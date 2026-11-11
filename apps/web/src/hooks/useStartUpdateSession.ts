import { RegistryContext } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  type DesktopUpdateCenterState,
  type EnvironmentId,
  type ModelSelection,
  type RuntimeMode,
  type ServerProvider,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveModelPreferences } from "@t3tools/shared/serverSettings";
import type { UiLanguage } from "@t3tools/shared/uiLanguage";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { type AnyRouter, useRouter } from "@tanstack/react-router";
import { useContext, useSyncExternalStore } from "react";

import {
  formatOutgoingPrompt,
  getAntigravitySendBlockReason,
  resolveComposerProviderSelection,
  threadShellHasStarted,
  waitForStartedServerThread,
} from "../components/ChatView.logic";
import {
  getComposerPromptInjectionState,
  getComposerProviderState,
} from "../components/chat/composerProviderState";
import { resolveCompatibleRuntimeMode } from "../components/chat/runtimeModeConfig";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { deriveEffectiveComposerModelState, useComposerDraftStore } from "../composerDraftStore";
import { useUiLanguage } from "../i18n/useUiLanguage";
import { newMessageId, newThreadId, randomUUID } from "../lib/utils";
import { isProviderInstancePickerReady, providerInstanceEntriesFor } from "../providerInstances";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects, readThreadShell } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { createNewThreadHandler } from "./useHandleNewThread";
import { createScratchProjectActions } from "./useScratchProject";
import { getClientSettings } from "./useSettings";

export type UpdateSessionKind = "upstream" | "repository";

const shortRevision = (value: string | null | undefined) =>
  value && /^[a-f0-9]{40}$/i.test(value) ? value.slice(0, 12) : (value ?? null);

const normalizePathComparisonKey = (value: string): string =>
  value.trim().replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

let activeStartingKind: UpdateSessionKind | null = null;
const startingKindListeners = new Set<() => void>();

function setActiveStartingKind(next: UpdateSessionKind | null) {
  if (activeStartingKind === next) return;
  activeStartingKind = next;
  for (const listener of startingKindListeners) {
    listener();
  }
}

function subscribeStartingKind(listener: () => void): () => void {
  startingKindListeners.add(listener);
  return () => startingKindListeners.delete(listener);
}

function getUpdateSessionStartingKind(): UpdateSessionKind | null {
  return activeStartingKind;
}

export function useUpdateSessionStartingKind(): UpdateSessionKind | null {
  return useSyncExternalStore(
    subscribeStartingKind,
    getUpdateSessionStartingKind,
    getUpdateSessionStartingKind,
  );
}

interface UpdateSessionLaunchAttempt {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: ReturnType<typeof newMessageId>;
  readonly createdAt: string;
  accepted: boolean;
}

const updateSessionLaunchAttempts = new Map<string, UpdateSessionLaunchAttempt>();

function launchRecoveryKey(
  environmentId: EnvironmentId,
  kind: UpdateSessionKind,
  state: DesktopUpdateCenterState,
): string {
  const targetRevision =
    kind === "upstream"
      ? `${state.upstream.current ?? ""}->${state.upstream.latest ?? ""}`
      : `${state.repository.current ?? ""}->${state.repository.latest ?? ""}`;
  return `${environmentId}:${kind}:${targetRevision}`;
}

export function resolveCandidateUpdateWorkspaceRoots(
  projects: ReadonlyArray<
    Pick<EnvironmentProject, "workspaceRoot" | "repositoryIdentity" | "isScratch"> & {
      readonly environmentId?: EnvironmentId;
    }
  >,
  repository: string | null | undefined,
  targetEnvironmentId?: EnvironmentId | null,
): ReadonlyArray<string> {
  const normalizedRepository = repository?.trim().toLowerCase() ?? "";
  const repoLeaf = normalizedRepository.split("/").filter(Boolean).at(-1) ?? "t3code";
  const exactMatches: string[] = [];
  const nameMatches: string[] = [];
  const seenExactKeys = new Set<string>();
  const seenNameKeys = new Set<string>();

  for (const project of projects) {
    if (project.isScratch) continue;
    if (
      targetEnvironmentId !== undefined &&
      targetEnvironmentId !== null &&
      project.environmentId !== undefined &&
      project.environmentId !== targetEnvironmentId
    ) {
      continue;
    }
    const root = project.workspaceRoot.trim();
    if (!root) continue;
    const normalizedRoot = normalizePathComparisonKey(root);
    if (!normalizedRoot) continue;

    const identity = project.repositoryIdentity;
    const ownerAndName =
      identity?.owner && identity?.name ? `${identity.owner}/${identity.name}`.toLowerCase() : "";
    const displayName = identity?.displayName?.trim().toLowerCase() ?? "";
    const canonicalKey = identity?.canonicalKey?.trim().toLowerCase() ?? "";
    const repoName = identity?.name?.trim().toLowerCase() ?? "";

    if (
      normalizedRepository.length > 0 &&
      (ownerAndName === normalizedRepository ||
        displayName === normalizedRepository ||
        canonicalKey.endsWith(`/${normalizedRepository}`) ||
        normalizedRoot.endsWith(`/${normalizedRepository}`))
    ) {
      if (!seenExactKeys.has(normalizedRoot)) {
        seenExactKeys.add(normalizedRoot);
        exactMatches.push(root);
      }
      continue;
    }
    if (
      repoLeaf.length > 0 &&
      (repoName === repoLeaf ||
        displayName.endsWith(`/${repoLeaf}`) ||
        canonicalKey.endsWith(`/${repoLeaf}`) ||
        normalizedRoot.endsWith(`/${repoLeaf}`) ||
        normalizedRoot.includes(`/${repoLeaf}/`))
    ) {
      if (!seenNameKeys.has(normalizedRoot)) {
        seenNameKeys.add(normalizedRoot);
        nameMatches.push(root);
      }
    }
  }

  const combined: string[] = [];
  const seenCombined = new Set<string>();
  for (const candidate of [...exactMatches, ...nameMatches]) {
    const key = normalizePathComparisonKey(candidate);
    if (seenCombined.has(key)) continue;
    seenCombined.add(key);
    combined.push(candidate);
  }
  return combined;
}

/** Builds a localized inspection and delivery brief; detected desktop metadata does not identify mobile releases. */
export function buildUpdateSessionPayload(input: {
  readonly kind: UpdateSessionKind;
  readonly state: DesktopUpdateCenterState;
  readonly candidateWorkspaceRoots?: ReadonlyArray<string>;
  readonly language?: UiLanguage;
}): { readonly titleSeed: string; readonly prompt: string } {
  const { kind, state } = input;
  const language: UiLanguage = input.language ?? "zh-CN";
  const candidateRoots = input.candidateWorkspaceRoots ?? [];
  const { build, upstream, repository, preferences } = state;
  const branch = build.sourceBranch ?? "develop";
  const currentRev = shortRevision(build.sourceRevision) ?? "unknown";
  const platformInspection = (
    language === "en"
      ? [
          `4. Inspect platform scope before proposing changes:`,
          `   - Distinguish the official desktop/server release, official mobile release, and Plus repository commits. The update center checks the latest stable GitHub release, not the iOS App Store or TestFlight. Desktop, official mobile, and Plus mobile versions are independent; never turn an iOS version into a desktop Git tag or assume a desktop tag contains the latest mobile release. For a mobile release, verify its official notes and source ref/SHA; if the shipped source cannot be verified, report that uncertainty before proposing a merge. Repository sync does not authorize adding upstream changes.`,
          `   - Inspect the complete diff and dependencies across apps/desktop, apps/web, apps/mobile, apps/server, packages/contracts, packages/shared, and packages/client-runtime. Report a PC / iOS / server table with affected behavior, evidence, required checks, and whether each target needs a new package or deployment. Do not classify impact from commit titles or paths alone.`,
          `   - Verify installed versions and build provenance separately from checkout configuration. Identify each affected server host, whether it is desktop-managed, and its connection to the mobile client. Missing device or artifact evidence means unknown, not up to date.`,
          `   - Assess protocol/API changes, database migrations, and native dependencies/configuration, including Expo, permissions, Widgets, and Sharing. A small version increment can still require coordinated updates. Reuse existing protocol/capability checks, assess old/new client-server combinations, and propose update order and data recovery limits. Have a compatible mobile package available before switching to an incompatible server.`,
          `   - Read apps/mobile/app.config.ts, apps/mobile/ios-release.json, and docs/operations/mobile-testflight.md. Preserve Plus branding, localization, features, bundle IDs, signing, and update-channel ownership. Plus iOS currently disables OTA; verify the current setting. With OTA disabled, mobile JS changes also need a new TestFlight build. Never enable the official app's OTA feed or replace Plus with an official binary.`,
        ]
      : [
          `4. 提出变更方案前，完成分端影响检查：`,
          `   - 区分官方桌面/服务端发布、官方移动端发布和 Plus 仓库提交。更新中心只检查 GitHub 最新稳定发布，未检测 iOS App Store 或 TestFlight；桌面、官方移动端、Plus 移动端分别编号，不能把 iOS 版本拼成桌面 Git 标签，也不能假定桌面标签包含最新移动端发布。涉及移动端发布时，核实官方说明与对应源码引用/SHA；无法确认实际出包源码时，先报告不确定性再提出合并方案。同步个人仓库不等于授权额外合并上游。`,
          `   - 检查完整 diff 及 apps/desktop、apps/web、apps/mobile、apps/server、packages/contracts、packages/shared、packages/client-runtime 的依赖关系。按 PC / iOS / 服务端列出受影响行为、证据、所需验证、是否需要新包或部署；不能只凭提交标题或目录判断影响。`,
          `   - 分别核实已安装版本、产物来源和源码配置，识别受影响服务端所在机器、是否由桌面端托管及手机连接关系。没有设备或产物证据时标记未知，不能视为已更新。`,
          `   - 检查通信协议/API、数据库迁移及原生依赖/配置，包括 Expo、权限、Widgets、Sharing；小版本号变化也可能需要配套更新。复用已有协议/能力检查，评估新旧客户端与服务端组合，提出更新顺序及数据恢复限制。切换到不兼容的服务端前，先准备可安装的兼容移动端包。`,
          `   - 读取 apps/mobile/app.config.ts、apps/mobile/ios-release.json、docs/operations/mobile-testflight.md，保留 Plus 品牌、汉化、功能、bundle ID、签名及更新渠道归属。Plus iOS 当前关闭 OTA，须核对现状；关闭时手机 JS 改动也需新 TestFlight 包。不得启用官方应用的 OTA 源或用官方二进制替换 Plus。`,
        ]
  ).join("\n");
  const platformDelivery = (
    language === "en"
      ? [
          `#### Build, Installation & Delivery`,
          `- Propose only the packages and host deployments required by the confirmed impact. Build, upload, install, or restart only within explicit authorization; ask once for any missing authorization. Keep unaffected targets unchanged. For iOS, follow docs/operations/mobile-testflight.md with a verified source snapshot and unused build number; native changes require a new binary even if a Plus-owned OTA channel is later configured.`,
          `- Report source sync, Git push, PC package/install, iOS package/TestFlight availability/device validation, and each server host's update separately. Use verified, not run, blocked, or unaffected with evidence. Git delivery, a successful build, or TestFlight availability does not prove installation, device behavior, or cross-version compatibility.`,
        ]
      : [
          `#### 构建、安装与交付`,
          `- 只安排已确认影响范围内的出包与主机部署；构建、上传、安装、重启须在明确授权内执行，缺少授权时集中确认一次，未受影响的端保持不动。iOS 按 docs/operations/mobile-testflight.md 固定源码并选择未使用的 build 号；即使以后接入 Plus 自有 OTA，原生变化仍需新安装包。`,
          `- 分别报告源码同步、Git 推送、PC 出包/安装、iOS 出包/TestFlight 可用/设备验收及各服务端主机更新状态，附证据并标明已验证、未执行、阻塞或不受影响。提交推送、构建成功或 TestFlight 可用，均不代表设备已安装、功能验收或新旧版本兼容性通过。`,
        ]
  ).join("\n");

  if (language === "en") {
    const candidatePathsSection =
      candidateRoots.length > 0
        ? `Candidate local repository paths (verify first):\n${candidateRoots.map((root) => `- \`${root}\``).join("\n")}`
        : "Candidate local repository paths: Locate the local T3 Code Plus checkout on this machine first.";
    const commandPathNote = preferences.commandPath
      ? `- Configured local migration CMD: \`${preferences.commandPath}\``
      : null;

    if (kind === "upstream") {
      const currentVersion = upstream.current ?? build.upstreamVersion ?? "unknown";
      const latestVersion = upstream.latest ?? "latest";
      const isAvailable = upstream.status === "available";
      const titleSeed = isAvailable
        ? `Upstream T3 Code update (${currentVersion} → ${latestVersion})`
        : `Upstream T3 Code check & sync (${currentVersion})`;
      const releaseItems = (upstream.releaseNotes?.items ?? []).slice(0, 12);
      const releaseNotesBlock =
        releaseItems.length > 0
          ? [
              `### Detected Upstream Release Notes`,
              ...releaseItems.map((item) => `- ${item}`),
            ].join("\n")
          : null;

      const prompt = [
        `Please help me inspect and sync **Upstream T3 Code (\`pingdotgg/t3code\`)** into my local **T3 Code Plus** repository.`,
        `### Detected Build & Update Context`,
        `- Update source: Upstream repository (\`pingdotgg/t3code\`), status: \`${upstream.status}\``,
        `- Current upstream baseline: \`${currentVersion}\``,
        `- Detected upstream version: \`${latestVersion}\`${upstream.majorUpdate ? " (major update)" : ""}`,
        ...(upstream.url ? [`- Upstream release URL: ${upstream.url}`] : []),
        `- Current T3 Code Plus build: \`${build.artifactVersion}\` (branch: \`${branch}\`, commit: \`${currentRev}\`${build.sourceDirty ? ", built with uncommitted changes" : ""})`,
        `- Personal remote repository: \`${build.repository ?? "kaku1210/t3code"}\``,
        ...(commandPathNote ? [commandPathNote] : []),
        `- ${candidatePathsSection}`,
        ...(releaseNotesBlock ? [releaseNotesBlock] : []),
        `### Follow This Strict Two-Stage Confirmation Workflow`,
        `#### Stage 1: Read-Only Inspection & Confirmation (Run immediately, then pause and wait for my confirmation)`,
        `1. Verify the local T3 Code Plus checkout path and inspect \`git remote -v\` (check \`origin\` and whether \`upstream\` points to \`https://github.com/pingdotgg/t3code.git\`).`,
        `2. Inspect local working tree state: \`git status --short\`, current branch, uncommitted/untracked files, and local \`develop\` / \`main\` divergence.`,
        `3. Run \`git fetch --all --tags\` only (**do NOT merge, rebase, reset, clean, or modify working tree files in Stage 1**).`,
        platformInspection,
        `5. Report your findings and ask for my confirmation on:`,
        `   - The verified local repository path;`,
        `   - The verified release ref/tag or pinned upstream commit SHA to merge, including any separately identified mobile release source; do not invent a tag from a displayed version;`,
        `   - How to handle any local uncommitted changes (commit first, temporary \`git stash\` with restoration plan, or leave untouched; never run destructive git commands without explicit approval);`,
        `   - Target branches to update and push (\`develop\` and \`main\`).`,
        `   - The affected platforms, required checks/packages, target hosts, update order, and unresolved compatibility risks.`,
        `#### Stage 2: Merge, Verify & Push (Wait for my confirmation before executing)`,
        `1. Handle local changes as confirmed, switch to \`develop\`, and merge the confirmed upstream target.`,
        `2. Resolve any conflicts while preserving T3 Code Plus customizations (\`packages/shared/src/i18n\`, \`DesktopUpdateCenter\`, mobile adaptations, etc.).`,
        `3. Inspect \`package.json\` (\`packageManager\` / scripts) and use the supported toolchain for the required checks and affected PC/mobile/server workflows. Install dependencies only when changed inputs require it and authorization covers it. Typechecking alone does not validate client-server compatibility or device behavior.`,
        `4. Commit and push to \`origin/develop\`, then merge and push to \`origin/main\`, restoring any temporary stash if requested.`,
        platformDelivery,
      ].join("\n\n");

      return { titleSeed, prompt };
    }

    const currentCommit = shortRevision(repository.current) ?? currentRev;
    const latestCommit = shortRevision(repository.latest) ?? "latest";
    const isAvailable = repository.status === "available" || repository.status === "diverged";
    const titleSeed = isAvailable
      ? `T3 Code Plus repo sync (${branch}: ${currentCommit} → ${latestCommit})`
      : `T3 Code Plus repo check & sync (${branch}: ${currentCommit})`;
    const commits = (repository.commits ?? []).slice(0, 12);
    const commitsBlock =
      commits.length > 0
        ? [
            `### Detected Remote Commits${repository.commitCount ? ` (${repository.commitCount} total)` : ""}`,
            ...commits.map((commit) => {
              const subject = commit.message.split("\n")[0]?.trim() ?? "";
              return `- \`${commit.sha.slice(0, 8)}\` ${subject}`;
            }),
          ].join("\n")
        : null;

    const prompt = [
      `Please help me inspect and sync updates from my **T3 Code Plus remote repository (\`${build.repository ?? "kaku1210/t3code"}\`)** into my local checkout.`,
      `### Detected Build & Update Context`,
      `- Update source: Personal remote repository (\`${build.repository ?? "kaku1210/t3code"}\`), status: \`${repository.status}\``,
      `- Target branch: \`${branch}\``,
      `- Current build commit: \`${currentCommit}\` (build: \`${build.artifactVersion}\`${build.sourceDirty ? ", built with uncommitted changes" : ""})`,
      `- Detected remote commit: \`${latestCommit}\``,
      ...(repository.url ? [`- Compare URL: ${repository.url}`] : []),
      ...(commandPathNote ? [commandPathNote] : []),
      `- ${candidatePathsSection}`,
      ...(commitsBlock ? [commitsBlock] : []),
      `### Follow This Strict Two-Stage Confirmation Workflow`,
      `#### Stage 1: Read-Only Inspection & Confirmation (Run immediately, then pause and wait for my confirmation)`,
      `1. Verify the local T3 Code Plus checkout path and inspect \`git remote -v\`.`,
      `2. Inspect \`git status --short\`, current branch, uncommitted/untracked files, and unpushed local commits.`,
      `3. Run \`git fetch origin\` only (**do NOT pull, merge, rebase, or modify working tree files in Stage 1**).`,
      platformInspection,
      `5. Report your findings and ask for my confirmation on:`,
      `   - The verified local repository path;`,
      `   - Exact incoming commits on \`origin/develop\` and \`origin/main\`;`,
      `   - How to handle any local uncommitted changes or branch divergence (never run destructive git commands without explicit approval).`,
      `   - The affected platforms, required checks/packages, target hosts, update order, and unresolved compatibility risks.`,
      `#### Stage 2: Sync, Verify & Build Confirmation (Wait for my confirmation before executing)`,
      `1. Sync \`origin/develop\` and \`origin/main\` into the local branches as confirmed (keeping \`develop\` checked out), and restore any temporary stash if used.`,
      `2. Inspect \`package.json\` (\`packageManager\` / scripts) and use the supported toolchain for the required checks and affected PC/mobile/server workflows. Install dependencies only when changed inputs require it and authorization covers it. Typechecking alone does not validate client-server compatibility or device behavior.`,
      platformDelivery,
    ].join("\n\n");

    return { titleSeed, prompt };
  }

  const candidatePathsSection =
    candidateRoots.length > 0
      ? `候选本地仓库路径（请先核实）：\n${candidateRoots.map((root) => `- \`${root}\``).join("\n")}`
      : "候选本地仓库路径：请先在本机工作区或常见项目目录中定位 T3 Code Plus 源码仓库。";

  const commandPathNote = preferences.commandPath
    ? `- 已配置的本地迁移脚本路径：\`${preferences.commandPath}\``
    : null;

  if (kind === "upstream") {
    const currentVersion = upstream.current ?? build.upstreamVersion ?? "unknown";
    const latestVersion = upstream.latest ?? "latest";
    const isAvailable = upstream.status === "available";
    const titleSeed = isAvailable
      ? `上游 T3 Code 更新 (${currentVersion} → ${latestVersion})`
      : `上游 T3 Code 检查与同步 (${currentVersion})`;
    const releaseItems = (upstream.releaseNotes?.items ?? []).slice(0, 12);
    const releaseNotesBlock =
      releaseItems.length > 0
        ? [`### 已知上游发布说明摘要`, ...releaseItems.map((item) => `- ${item}`)].join("\n")
        : null;

    const statusDescription = isAvailable
      ? `检测到上游新版本 \`${latestVersion}\`${upstream.majorUpdate ? "（主版本更新）" : ""}`
      : `当前检测状态为 \`${upstream.status}\`（展示版本：\`${latestVersion}\`），请执行手动巡检与同步核对`;

    const prompt = [
      `请协助我完成 **T3 Code Plus 检查并同步上游 T3 Code (\`pingdotgg/t3code\`) 更新** 的流程。`,
      `### 当前检测到的版本与构建上下文`,
      `- 更新类型：上游仓库 (\`pingdotgg/t3code\`)，检测状态：\`${upstream.status}\``,
      `- 当前上游基线版本：\`${currentVersion}\``,
      `- 上游版本状态：${statusDescription}`,
      ...(upstream.url ? [`- 上游发布链接：${upstream.url}`] : []),
      `- 当前 T3 Code Plus 构建版本：\`${build.artifactVersion}\`（分支：\`${branch}\`，提交：\`${currentRev}\`${build.sourceDirty ? "，构建时含未提交改动" : ""}）`,
      `- 个人远端仓库：\`${build.repository ?? "kaku1210/t3code"}\``,
      ...(commandPathNote ? [commandPathNote] : []),
      `- ${candidatePathsSection}`,
      ...(releaseNotesBlock ? [releaseNotesBlock] : []),
      `### 请严格按以下两阶段确认流程执行`,
      `#### 第一阶段：只读巡检与变更确认（立即执行，完成后必须暂停并等待我确认）`,
      `1. 定位并核实本地 T3 Code Plus 源码仓库目录，检查 \`git remote -v\`（确认 \`origin\` 与 \`upstream\` 是否存在，若无 \`upstream\` 记录待添加地址 \`https://github.com/pingdotgg/t3code.git\`）。`,
      `2. 检查本地工作区状态：运行 \`git status --short\`、查看当前所在分支、检查本地 \`develop\` 与 \`main\` 分支是否有未提交修改、未跟踪文件或未推送提交。`,
      `3. 执行 \`git fetch --all --tags\` 获取远端最新引用（**注意：第一阶段仅允许只读检查与 fetch，严禁直接执行 merge / rebase / reset / clean 或修改任何工作区文件**）。`,
      platformInspection,
      `5. 核实官方发布对应引用与 \`upstream/main\` 的具体提交 SHA 及差异范围，评估与 Plus 二开功能的冲突点，向我汇报并请求确认以下事项：`,
      `   - 核实后的本地仓库路径；`,
      `   - 核实后的发布引用/标签或固定的上游提交 SHA，包括另行确认的移动端发布源码；不能仅凭展示版本编造标签；`,
      `   - 本地未提交改动的处理方式（先提交、先 \`git stash push -u\` 并在合并后恢复，还是保持不动；未经我明确同意严禁执行丢弃改动的破坏性操作）；`,
      `   - 目标更新与推送分支（\`develop\` 与 \`main\`）。`,
      `   - 受影响平台、所需验证与产物、目标主机、更新顺序及尚未解决的兼容风险。`,
      `#### 第二阶段：合并上游、验证与推送（必须收到我的明确确认后再执行）`,
      `1. 按我确认的方式处理本地改动，切换到 \`develop\` 分支并与 \`origin/develop\` 同步后合并已确认的上游目标引用。`,
      `2. 若出现代码冲突，完整保留 T3 Code Plus 二开能力并融合上游改动。`,
      `3. 检查 \`package.json\` 中的 \`packageManager\` 与脚本，使用仓库支持的工具链完成必要检查及受影响的 PC/移动端/服务端流程验证。仅在输入变化确有需要且授权涵盖时安装依赖；类型检查不能代替跨端兼容或设备验证。`,
      `4. 将验证通过的合并结果提交并推送到 \`origin/develop\`，再同步合并推送到 \`origin/main\`；若此前使用了临时 \`git stash\`，按确认方案恢复。`,
      platformDelivery,
    ].join("\n\n");

    return { titleSeed, prompt };
  }

  const currentCommit = shortRevision(repository.current) ?? currentRev;
  const latestCommit = shortRevision(repository.latest) ?? "latest";
  const isAvailable = repository.status === "available" || repository.status === "diverged";
  const titleSeed = isAvailable
    ? `T3 Code Plus 仓库同步 (${branch}: ${currentCommit} → ${latestCommit})`
    : `T3 Code Plus 仓库检查与同步 (${branch}: ${currentCommit})`;
  const commits = (repository.commits ?? []).slice(0, 12);
  const commitsBlock =
    commits.length > 0
      ? [
          `### 远端提交摘要${repository.commitCount ? `（共 ${repository.commitCount} 个提交）` : ""}`,
          ...commits.map((commit) => {
            const subject = commit.message.split("\n")[0]?.trim() ?? "";
            return `- \`${commit.sha.slice(0, 8)}\` ${subject}`;
          }),
        ].join("\n")
      : null;

  const repoStatusDescription =
    repository.status === "available"
      ? `检测到远端新提交 \`${latestCommit}\``
      : repository.status === "diverged"
        ? `检测到本地与远端提交历史已分叉（远端：\`${latestCommit}\`）`
        : `当前检测状态为 \`${repository.status}\`（远端提交：\`${latestCommit}\`），请执行手动巡检与同步核对`;

  const prompt = [
    `请协助我完成 **T3 Code Plus 远端仓库 (\`${build.repository ?? "kaku1210/t3code"}\`) 更新检查与本地同步** 的流程。`,
    `### 当前检测到的版本与构建上下文`,
    `- 更新类型：个人远端仓库 (\`${build.repository ?? "kaku1210/t3code"}\`)，检测状态：\`${repository.status}\``,
    `- 目标分支：\`${branch}\``,
    `- 当前构建提交：\`${currentCommit}\`（构建版本：\`${build.artifactVersion}\`${build.sourceDirty ? "，构建时含未提交改动" : ""}）`,
    `- 远端仓库状态：${repoStatusDescription}`,
    ...(repository.url ? [`- 对比链接：${repository.url}`] : []),
    ...(commandPathNote ? [commandPathNote] : []),
    `- ${candidatePathsSection}`,
    ...(commitsBlock ? [commitsBlock] : []),
    `### 请严格按以下两阶段确认流程执行`,
    `#### 第一阶段：只读巡检与变更确认（立即执行，完成后必须暂停并等待我确认）`,
    `1. 定位并核实本地 T3 Code Plus 源码仓库目录，确认 \`git remote -v\`。`,
    `2. 检查本地工作区状态：运行 \`git status --short\`、查看当前所在分支、检查是否有未提交修改、未跟踪文件或本地未推送提交。`,
    `3. 执行 \`git fetch origin\` 获取远端最新分支引用，对比本地 \`develop\` / \`main\` 与 \`origin/develop\` / \`origin/main\` 的提交差异（**注意：第一阶段仅允许只读检查与 fetch，严禁直接执行 pull / merge / rebase / reset 或修改工作区文件**）。`,
    platformInspection,
    `5. 向我汇报检查结果并请求确认以下事项：`,
    `   - 核实后的本地仓库路径；`,
    `   - \`origin/develop\` 与 \`origin/main\` 待同步的精确提交范围；`,
    `   - 本地未提交改动或分叉的处理方式（如先提交、先 \`git stash push -u\` 并在同步后恢复、快进合并或 rebase；未经我明确同意严禁执行破坏性重置命令）。`,
    `   - 受影响平台、所需验证与产物、目标主机、更新顺序及尚未解决的兼容风险。`,
    `#### 第二阶段：拉取同步、验证与构建确认（必须收到我的明确确认后再执行）`,
    `1. 按我确认的方式处理本地工作区，将 \`origin/develop\` 和 \`origin/main\` 同步到本地对应分支（保持工作分支在 \`develop\`），并在需要时恢复临时 \`git stash\`。`,
    `2. 若存在冲突，协助我解决冲突并保留正确改动。`,
    `3. 检查 \`package.json\` 中的 \`packageManager\` 与脚本，使用仓库支持的工具链完成必要检查及受影响的 PC/移动端/服务端流程验证。仅在输入变化确有需要且授权涵盖时安装依赖；类型检查不能代替跨端兼容或设备验证。`,
    platformDelivery,
  ].join("\n\n");

  return { titleSeed, prompt };
}

export type ScratchSendTargetResolution =
  | {
      readonly ready: true;
      readonly modelSelection: ModelSelection;
      readonly outgoingPrompt: string;
      readonly runtimeMode: RuntimeMode;
    }
  | {
      readonly ready: false;
    };

export function resolveReadyScratchSendTarget(input: {
  readonly project: Pick<
    EnvironmentProject,
    "id" | "defaultModelSelection" | "defaultThreadEnvMode"
  >;
  readonly prompt: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly serverSettings: ServerSettings;
  readonly clientSettings?: ReturnType<typeof getClientSettings>;
  readonly stickyState?: Pick<
    ReturnType<typeof useComposerDraftStore.getState>,
    "stickyActiveProvider" | "stickyModelSelectionByProvider"
  >;
}): ScratchSendTargetResolution {
  const { project, prompt, providers, serverSettings } = input;
  const clientSettings = input.clientSettings ?? getClientSettings();
  const stickyState = input.stickyState ?? useComposerDraftStore.getState();

  const unifiedSettings: UnifiedSettings = {
    ...clientSettings,
    ...serverSettings,
    ...resolveModelPreferences(serverSettings, clientSettings),
  };

  const projectSettings = resolveProjectSettings(serverSettings, project.id, project);
  const configuredDefaultModelSelection = projectSettings.settings.defaultModelSelection ?? null;
  const fallbackResolution = resolveNewThreadModelSelection({
    defaultSelection: configuredDefaultModelSelection,
    fallbackSelection: serverSettings.fallbackModelSelection ?? null,
    providers,
    settings: serverSettings,
    projectId: project.id,
    now: Date.now(),
  });
  const projectDefaultSelection = fallbackResolution.fallback
    ? fallbackResolution.selection
    : configuredDefaultModelSelection;

  const entries = providerInstanceEntriesFor(providers, serverSettings, project.id);
  const selection = resolveComposerProviderSelection({
    entries,
    candidateInstanceIds: [
      stickyState.stickyActiveProvider,
      projectDefaultSelection?.instanceId,
      serverSettings.fallbackModelSelection?.instanceId,
    ],
    lockedProvider: null,
    lockedInstanceId: undefined,
  });

  const selectedEntry = selection.selectedProviderEntry;
  if (!selectedEntry || !isProviderInstancePickerReady(selectedEntry)) {
    return { ready: false };
  }

  const selectedInstanceId = selectedEntry.instanceId;
  const selectedProvider = selectedEntry.driverKind;
  const modelState = deriveEffectiveComposerModelState({
    draft: {
      modelSelectionByProvider: stickyState.stickyModelSelectionByProvider,
      activeProvider: stickyState.stickyActiveProvider,
    },
    providers,
    selectedProvider,
    selectedInstanceId,
    requestedInstanceId: selection.requestedInstanceId,
    threadModelSelection: null,
    projectModelSelection: projectDefaultSelection,
    settings: unifiedSettings,
  });

  const selectedModel = modelState.selectedModel.trim();
  if (!selectedModel) {
    return { ready: false };
  }

  if (getAntigravitySendBlockReason(selectedEntry.snapshot, selectedModel) !== null) {
    return { ready: false };
  }

  const composerProviderState = getComposerProviderState({
    provider: selectedProvider,
    model: selectedModel,
    models: selectedEntry.models,
    promptInjectionState: getComposerPromptInjectionState(prompt),
    modelOptions: modelState.modelOptions?.[selectedInstanceId],
    planModeEnabled: false,
  });

  const modelSelection = createModelSelection(
    selectedInstanceId,
    selectedModel,
    composerProviderState.modelOptionsForDispatch,
  );
  const outgoingPrompt = formatOutgoingPrompt({
    provider: selectedProvider,
    model: selectedModel,
    models: selectedEntry.models,
    effort: composerProviderState.promptEffort,
    text: prompt,
  });
  const { mode: runtimeMode } = resolveCompatibleRuntimeMode(
    projectSettings.settings.defaultRuntimeMode,
    selectedEntry.snapshot.supportedRuntimeModes,
  );

  return {
    ready: true,
    modelSelection,
    outgoingPrompt,
    runtimeMode,
  };
}

export function useStartUpdateSession() {
  const router = useRouter({ warn: false }) as AnyRouter | undefined;
  const { language, t } = useUiLanguage();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const registry = useContext(RegistryContext);
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });

  const handleNewThread = router
    ? createNewThreadHandler(router)
    : async () => {
        return null;
      };

  const { scratchWorkspaceRootFor, openScratchProject } = createScratchProjectActions({
    environments: () => environments,
    primaryEnvironmentId: () => primaryEnvironmentId,
    registry,
    handleNewThread,
  });

  return async (kind: UpdateSessionKind, state: DesktopUpdateCenterState): Promise<boolean> => {
    if (getUpdateSessionStartingKind() !== null) {
      return false;
    }

    const failureTitle = t("updates.aiQuickUpdateFailed");
    if (primaryEnvironmentId === null || scratchWorkspaceRootFor(primaryEnvironmentId) === null) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: failureTitle,
          description: t("updates.aiQuickUpdateNoLocalEnv"),
        }),
      );
      return false;
    }

    const environmentId = primaryEnvironmentId;
    const recoveryKey = launchRecoveryKey(environmentId, kind, state);
    const existingAttempt = updateSessionLaunchAttempts.get(recoveryKey);
    if (existingAttempt !== undefined) {
      const existingRef = scopeThreadRef(environmentId, existingAttempt.threadId);
      const existingShell = readThreadShell(existingRef);
      if (
        existingShell !== null &&
        existingShell.deletedAt == null &&
        (existingAttempt.accepted || threadShellHasStarted(existingShell))
      ) {
        existingAttempt.accepted = true;
        if (router) {
          await router
            .navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: existingAttempt.threadId },
            })
            .catch(() => undefined);
        }
        return true;
      }
      if (existingShell?.deletedAt != null || existingAttempt.accepted) {
        updateSessionLaunchAttempts.delete(recoveryKey);
      }
    }

    setActiveStartingKind(kind);
    const requestingRouteHref = router?.state.location.href;
    const routeChangedSinceRequest = () =>
      router !== undefined &&
      requestingRouteHref !== undefined &&
      router.state.location.href !== requestingRouteHref;

    try {
      const project = await openScratchProject(environmentId, failureTitle);
      if (!project) {
        return false;
      }

      const candidateWorkspaceRoots = resolveCandidateUpdateWorkspaceRoots(
        readProjects(),
        state.build.repository,
        environmentId,
      );
      const payload = buildUpdateSessionPayload({
        kind,
        state,
        candidateWorkspaceRoots,
        language,
      });

      const environmentServerConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
      const serverConfig = environmentServerConfigs.get(project.environmentId);
      const sendTarget = resolveReadyScratchSendTarget({
        project,
        prompt: payload.prompt,
        providers: serverConfig?.providers ?? [],
        serverSettings: serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
      });

      if (!sendTarget.ready) {
        try {
          const opened = await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
            prompt: payload.prompt,
          });
          if (opened !== null) {
            toastManager.add(
              stackedThreadToast({
                type: "info",
                title: t("updates.aiQuickUpdateSettingsTitle"),
                description: t("updates.aiQuickUpdateDraftFallback"),
              }),
            );
            return true;
          }
          return false;
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: failureTitle,
              description: error instanceof Error ? error.message : String(error),
            }),
          );
          return false;
        }
      }

      let attempt = updateSessionLaunchAttempts.get(recoveryKey);
      if (!attempt) {
        attempt = {
          commandId: CommandId.make(randomUUID()),
          threadId: newThreadId(),
          messageId: newMessageId(),
          createdAt: new Date().toISOString(),
          accepted: false,
        };
        updateSessionLaunchAttempts.set(recoveryKey, attempt);
      }
      const { commandId, threadId, messageId, createdAt } = attempt;
      const threadRef = scopeThreadRef(project.environmentId, threadId);

      const startResult = await startThreadTurn({
        environmentId: project.environmentId,
        input: {
          commandId,
          threadId,
          message: {
            messageId,
            role: "user",
            text: sendTarget.outgoingPrompt,
            attachments: [],
          },
          modelSelection: sendTarget.modelSelection,
          titleSeed: payload.titleSeed,
          runtimeMode: sendTarget.runtimeMode,
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: project.id,
              title: payload.titleSeed,
              modelSelection: sendTarget.modelSelection,
              runtimeMode: sendTarget.runtimeMode,
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
            },
          },
          createdAt,
        },
      });

      if (startResult._tag === "Failure") {
        const recoveredVisible = await waitForStartedServerThread(threadRef, 500).catch(
          () => false,
        );
        const recoveredShell = readThreadShell(threadRef);
        if (
          recoveredVisible ||
          (recoveredShell !== null &&
            recoveredShell.deletedAt == null &&
            threadShellHasStarted(recoveredShell))
        ) {
          attempt.accepted = true;
          if (router && !routeChangedSinceRequest()) {
            await router
              .navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: project.environmentId, threadId },
              })
              .catch(() => undefined);
          }
          return true;
        }

        const deletedEmpty = await deleteThread({
          environmentId: project.environmentId,
          input: { threadId, onlyIfUnused: true },
        });
        if (deletedEmpty._tag === "Success") {
          updateSessionLaunchAttempts.delete(recoveryKey);
        }

        if (!isAtomCommandInterrupted(startResult)) {
          const error = squashAtomCommandFailure(startResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: failureTitle,
              description: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        return false;
      }

      attempt.accepted = true;
      const startedVisible = await waitForStartedServerThread(threadRef, 5_000).catch(() => false);

      if (router) {
        const navigateToStartedThread = () =>
          void router
            .navigate({
              to: "/$environmentId/$threadId",
              params: {
                environmentId: project.environmentId,
                threadId,
              },
            })
            .catch(() => undefined);

        const showStartedToast = () => {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: t("updates.aiQuickUpdateStartedTitle"),
              description: payload.titleSeed,
              actionProps: {
                children: t("updates.aiQuickUpdateOpenSession"),
                onClick: navigateToStartedThread,
              },
            }),
          );
        };

        if (routeChangedSinceRequest() || !startedVisible) {
          showStartedToast();
          if (!routeChangedSinceRequest() && !startedVisible) {
            void waitForStartedServerThread(threadRef, 10_000)
              .then((visibleLater) => {
                if (visibleLater && !routeChangedSinceRequest()) {
                  navigateToStartedThread();
                }
              })
              .catch(() => undefined);
          }
        } else {
          await router
            .navigate({
              to: "/$environmentId/$threadId",
              params: {
                environmentId: project.environmentId,
                threadId,
              },
            })
            .catch(() => {
              showStartedToast();
            });
        }
      }
      return true;
    } finally {
      setActiveStartingKind(null);
    }
  };
}
