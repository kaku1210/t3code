import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type DesktopUpdateCenterState,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";
import {
  buildUpdateSessionPayload,
  resolveCandidateUpdateWorkspaceRoots,
  resolveReadyScratchSendTarget,
} from "./useStartUpdateSession";

const LOCAL_ENV = EnvironmentId.make("env-local");
const REMOTE_ENV = EnvironmentId.make("env-remote");
const SCRATCH_PROJECT_ID = ProjectId.make("project-scratch");

const sampleState: DesktopUpdateCenterState = {
  supported: true,
  localAllowed: true,
  installing: false,
  preferences: {
    checkingEnabled: true,
    quickUpdateEnabled: true,
    sourcePath: "D:\\Project\\t3codeplus",
  },
  build: {
    artifactVersion: "0.1.7-plus.20261110.1",
    upstreamVersion: "0.1.7",
    repository: "kaku1210/t3code",
    sourceBranch: "develop",
    sourceRevision: "fb95f7db6eaf55ee1cfd7785d6779e632b536372",
    sourceDirty: false,
    builtAt: "2026-11-10T08:00:00Z",
    platform: "win32",
    arch: "x64",
  },
  upstream: {
    status: "available",
    current: "0.1.7",
    latest: "0.1.8",
    message: null,
    url: "https://github.com/pingdotgg/t3code/releases/tag/v0.1.8",
    checkedAt: "2026-11-10T08:00:00Z",
    majorUpdate: false,
    releaseNotes: {
      version: "0.1.8",
      items: ["Improved terminal throughput", "Fixed worktree cleanup"],
      totalItems: 2,
    },
  },
  repository: {
    status: "available",
    current: "a0ba2f4f00000000000000000000000000000000",
    latest: "fb95f7db6eaf55ee1cfd7785d6779e632b536372",
    message: null,
    url: "https://github.com/kaku1210/t3code/compare/a0ba2f4f...fb95f7db",
    checkedAt: "2026-11-10T08:00:00Z",
    majorUpdate: false,
    commits: [
      {
        sha: "fb95f7db6eaf55ee1cfd7785d6779e632b536372",
        message: "feat(web): add mobile adaptation\n\nSupport mobile drawer and touch actions.",
        url: "https://github.com/kaku1210/t3code/commit/fb95f7db6eaf55ee1cfd7785d6779e632b536372",
      },
    ],
    commitCount: 1,
  },
  release: {
    status: "current",
    current: "0.1.7-plus.20261110.1",
    latest: "0.1.7-plus.20261110.1",
    message: null,
    url: null,
    checkedAt: "2026-11-10T08:00:00Z",
    majorUpdate: false,
  },
  local: {
    status: "current",
    current: "0.1.7-plus.20261110.1",
    latest: "0.1.7-plus.20261110.1",
    message: null,
    url: null,
    checkedAt: "2026-11-10T08:00:00Z",
    majorUpdate: false,
  },
};

describe("resolveCandidateUpdateWorkspaceRoots", () => {
  it("prioritizes exact repository identity matches, filters by targetEnvironmentId, and excludes scratch projects", () => {
    const roots = resolveCandidateUpdateWorkspaceRoots(
      [
        {
          environmentId: LOCAL_ENV,
          workspaceRoot: "C:\\Users\\gh\\.t3\\userdata\\attachments",
          repositoryIdentity: null,
          isScratch: true,
        },
        {
          environmentId: REMOTE_ENV,
          workspaceRoot: "/home/dev/t3code",
          repositoryIdentity: {
            canonicalKey: "github.com/kaku1210/t3code",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "https://github.com/kaku1210/t3code.git",
            },
            owner: "kaku1210",
            name: "t3code",
            displayName: "kaku1210/t3code",
          },
        },
        {
          environmentId: LOCAL_ENV,
          workspaceRoot: "D:\\Work\\other-t3code-fork",
          repositoryIdentity: {
            canonicalKey: "github.com/someone/t3code",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "https://github.com/someone/t3code.git",
            },
            owner: "someone",
            name: "t3code",
            displayName: "someone/t3code",
          },
        },
        {
          environmentId: LOCAL_ENV,
          workspaceRoot: "D:\\Project\\AgentLearn\\t3code",
          repositoryIdentity: {
            canonicalKey: "github.com/kaku1210/t3code",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "https://github.com/kaku1210/t3code.git",
            },
            owner: "kaku1210",
            name: "t3code",
            displayName: "kaku1210/t3code",
          },
        },
        {
          environmentId: LOCAL_ENV,
          workspaceRoot: "d:/project/agentlearn/t3code/",
          repositoryIdentity: null,
        },
      ],
      "kaku1210/t3code",
      LOCAL_ENV,
    );

    expect(roots).toEqual(["D:\\Project\\AgentLearn\\t3code", "D:\\Work\\other-t3code-fork"]);
  });

  it("does not match every workspace when buildRepository is empty", () => {
    const roots = resolveCandidateUpdateWorkspaceRoots(
      [
        {
          environmentId: LOCAL_ENV,
          workspaceRoot: "D:\\Work\\unrelated-project",
          repositoryIdentity: null,
        },
        {
          environmentId: LOCAL_ENV,
          workspaceRoot: "D:\\Project\\AgentLearn\\t3code",
          repositoryIdentity: null,
        },
      ],
      "",
      LOCAL_ENV,
    );

    expect(roots).toEqual(["D:\\Project\\AgentLearn\\t3code"]);
  });
});

describe("resolveReadyScratchSendTarget", () => {
  const readyCodexProvider: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-10T08:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Effort",
              type: "select",
              options: [
                { id: "medium", label: "Medium" },
                { id: "high", label: "High", isDefault: true },
              ],
            },
            {
              id: "fastMode",
              label: "Fast mode",
              type: "boolean",
              currentValue: true,
            },
          ],
        },
      },
    ],
  };

  it("resolves a ready target and normalizes model options through composer provider state", () => {
    const target = resolveReadyScratchSendTarget({
      project: {
        id: SCRATCH_PROJECT_ID,
        defaultModelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
          { id: "reasoningEffort", value: "high" },
        ]),
      },
      prompt: "Run update check",
      providers: [readyCodexProvider],
      serverSettings: DEFAULT_SERVER_SETTINGS,
      stickyState: {
        stickyActiveProvider: null,
        stickyModelSelectionByProvider: {},
      },
    });

    expect(target.ready).toBe(true);
    if (target.ready) {
      expect(target.modelSelection).toEqual(
        createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: false },
        ]),
      );
    }
  });

  it("returns ready: false when the selected provider is disabled or not ready", () => {
    const disabledProvider: ServerProvider = {
      ...readyCodexProvider,
      enabled: false,
      status: "disabled",
    };

    const target = resolveReadyScratchSendTarget({
      project: {
        id: SCRATCH_PROJECT_ID,
        defaultModelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4"),
      },
      prompt: "Run update check",
      providers: [disabledProvider],
      serverSettings: DEFAULT_SERVER_SETTINGS,
      stickyState: {
        stickyActiveProvider: null,
        stickyModelSelectionByProvider: {},
      },
    });

    expect(target.ready).toBe(false);
  });
});

describe("buildUpdateSessionPayload", () => {
  it("builds a two-stage confirmation prompt for upstream updates in Chinese", () => {
    const payload = buildUpdateSessionPayload({
      kind: "upstream",
      state: sampleState,
      candidateWorkspaceRoots: ["D:\\Project\\AgentLearn\\t3code"],
      language: "zh-CN",
    });

    expect(payload.titleSeed).toBe("上游 T3 Code 更新 (0.1.7 → 0.1.8)");
    expect(payload.prompt).toContain("pingdotgg/t3code");
    expect(payload.prompt).toContain("0.1.7");
    expect(payload.prompt).toContain("0.1.8");
    expect(payload.prompt).toContain("Improved terminal throughput");
    expect(payload.prompt).toContain("D:\\Project\\AgentLearn\\t3code");
    expect(payload.prompt).toContain(
      "第一阶段：只读巡检与变更确认（立即执行，完成后必须暂停并等待我确认）",
    );
    expect(payload.prompt).toContain(
      "第二阶段：合并上游、验证与推送（必须收到我的明确确认后再执行）",
    );
  });

  it("builds a status-accurate prompt when repository status is diverged, and supports English", () => {
    const divergedState: DesktopUpdateCenterState = {
      ...sampleState,
      repository: {
        ...sampleState.repository,
        status: "diverged",
      },
    };
    const payload = buildUpdateSessionPayload({
      kind: "repository",
      state: divergedState,
      candidateWorkspaceRoots: ["D:\\Project\\AgentLearn\\t3code"],
      language: "en",
    });

    expect(payload.titleSeed).toBe("T3 Code Plus repo sync (develop: a0ba2f4f0000 → fb95f7db6eaf)");
    expect(payload.prompt).toContain("diverged");
    expect(payload.prompt).toContain(
      "Stage 1: Read-Only Inspection & Confirmation (Run immediately, then pause and wait for my confirmation)",
    );
    expect(payload.prompt).toContain(
      "Stage 2: Sync, Verify & Build Confirmation (Wait for my confirmation before executing)",
    );
  });
});
