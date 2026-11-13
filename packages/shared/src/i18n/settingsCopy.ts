import type { UiLanguage } from "../uiLanguage.ts";

import { settingsDetailMessages } from "./settingsDetailMessages.ts";

type CopyPair = readonly [source: string, simplifiedChinese: string];
type SettingCopy = Readonly<Partial<Record<"title" | "description", CopyPair>>>;

const pageCopy: Readonly<Partial<Record<string, CopyPair>>> = {
  "/settings/diagnostics": ["Diagnostics", "诊断"],
  "/settings/projects": ["Projects", "项目"],
  "/settings/general": ["General", "常规"],
  "/settings/appearance": ["Appearance", "外观"],
  "/settings/chat": ["Chat", "聊天"],
  "/settings/diffs": ["Diffs & pull requests", "差异与拉取请求"],
  "/settings/keybindings": ["Keybindings", "快捷键"],
  "/settings/snap-shot": ["SnapShots", "快照"],
  "/settings/providers": ["Providers", "模型服务商"],
  "/settings/threads": ["Threads", "会话"],
  "/settings/browser": ["Browser", "浏览器"],
  "/settings/devices": ["Devices", "设备"],
  "/settings/scheduled-tasks": ["Scheduled tasks", "计划任务"],
  "/settings/source-control": ["Source control", "源代码管理"],
  "/settings/worktrees": ["Worktrees", "工作树"],
  "/settings/connections": ["Environments", "环境"],
  "/settings/access": ["Sharing & access", "共享与访问"],
  "/settings/secrets": ["Secrets", "机密"],
  "/settings/maintenance": ["Maintenance", "维护"],
  "/settings/labs": ["Labs", "实验室"],
  "/settings/about": ["About", "关于"],
  "/settings/voice": ["Voice", "语音"],
  "/settings/archived": ["Archive", "归档"],
  "/settings/open-source-licenses": ["Open source licenses", "开源许可证"],
};

const sectionCopy: Readonly<Partial<Record<string, CopyPair>>> = {
  notifications: ["Notifications", "通知"],
  sidebar: ["Sidebar", "侧栏"],
  confirmations: ["Confirmations", "确认操作"],
  display: ["Display", "显示"],
  appearance: ["Colors & themes", "配色与主题"],
  "appearance-interface": ["Interface", "界面"],
  composer: ["Composer", "输入区"],
  "follow-ups": ["Follow-ups", "追加消息"],
  diffs: ["Diffs", "差异"],
  "pull-requests": ["Pull requests", "拉取请求"],
  "new-projects": ["New projects", "新项目"],
  snooze: ["Snooze", "稍后提醒"],
  "usage-limits": ["Usage limits", "用量限制"],
  "auto-settle": ["Auto-settle", "自动收起"],
  "text-generation": ["Text generation", "文本生成"],
  updates: ["Updates", "更新"],
  background: ["Background activity", "后台活动"],
  "diagnostics-section": ["Diagnostics", "诊断"],
  about: ["App", "应用"],
  legal: ["Legal", "法律信息"],
  "worktree-creation": ["Creation", "创建"],
  "worktree-branches": ["Branches", "分支"],
  "legacy-features": ["Legacy", "旧版功能"],
  providers: ["Providers", "模型服务商"],
  "usage-providers": ["Usage providers", "用量来源"],
};

const groupCopy: Readonly<Partial<Record<string, CopyPair>>> = {
  Agents: ["Agents", "代理"],
  Code: ["Code", "代码"],
  Connections: ["Connections", "连接"],
};

const settingCopy: Readonly<Partial<Record<string, SettingCopy>>> = {
  "composer-placeholder": { title: settingsDetailMessages["settings.chat.placeholder"] },
  "next-prompt-suggestions-enabled": {
    title: settingsDetailMessages["settings.promptSuggestion.enabled"],
  },
  "next-prompt-suggestions-model": {
    title: settingsDetailMessages["settings.promptSuggestion.model"],
  },
  "snap-shot-enabled": { title: ["SnapShots", "快照"] },
  "snap-shot-accessibility": { title: ["Include app text", "包含应用文本"] },
  "snap-shot-shortcut": { title: ["Capture shortcut", "捕获快捷键"] },
  "snap-shot-sound": { title: ["Capture sound", "捕获音效"] },
  "snap-shot-flash": { title: ["Capture flash", "捕获闪光提示"] },
  "snap-shot-animations": { title: ["Capture animations", "捕获动画"] },
  "browser-profiles": { title: ["Browser profiles", "浏览器配置"] },
  "browser-default-profile": { title: ["Default browser profile", "默认浏览器配置"] },
  "browser-default-viewport": { title: settingsDetailMessages["settings.browser.viewport"] },
  "browser-default-zoom": { title: settingsDetailMessages["settings.browser.zoom"] },
  "browser-default-appearance": { title: settingsDetailMessages["settings.browser.appearance"] },
  "browser-recording-frame-rate": { title: settingsDetailMessages["settings.browser.frameRate"] },
  "browser-recording-key-presses": { title: settingsDetailMessages["settings.browser.recordKeys"] },
  "browser-recording-mouse-presses": {
    title: settingsDetailMessages["settings.browser.recordMouse"],
  },
  "browser-link-target": { title: settingsDetailMessages["settings.browser.links"] },
  "browser-search-engine": { title: settingsDetailMessages["settings.browser.searchEngine"] },
  "agent-browser-access": { title: settingsDetailMessages["settings.browser.access"] },
  "browser-auto-show-floating-preview": {
    title: settingsDetailMessages["settings.browser.preview"],
  },
  "voice-transcription-destination": {
    title: settingsDetailMessages["settings.voice.transcribeWith"],
  },
  "voice-microphone": { title: settingsDetailMessages["settings.voice.microphone"] },
  "dictation-shortcut-mode": { title: settingsDetailMessages["settings.voice.shortcut"] },
  "speech-language": { title: ["Transcription language", "转录语言"] },
  "speech-dictionary": { title: settingsDetailMessages["settings.voice.dictionary"] },
  "speech-project-dictionary": { title: ["Project dictionary", "项目词典"] },
  "speech-post-processing-model": { title: ["Cleanup model", "润色模型"] },
  "speech-correction-word": { title: settingsDetailMessages["settings.voice.correctionCue"] },
  "speech-silence-filtering": { title: settingsDetailMessages["settings.voice.silenceFiltering"] },
  "remove-filler-words": { title: settingsDetailMessages["settings.voice.removeFillerWords"] },
  "speech-post-processing": { title: settingsDetailMessages["settings.voice.cleanupWithProvider"] },
  "speech-models": { title: ["Transcription models", "转录模型"] },
  "speech-hardware": {
    title: ["Transcription hardware and model unloading", "转录硬件和模型卸载"],
  },
  "microphone-test": { title: settingsDetailMessages["settings.microphoneTest.test"] },
  "transcription-test": { title: ["Test model", "测试模型"] },
  "project-grouping": {
    title: ["Project grouping", "项目分组"],
    description: [
      "Combine matching repositories across environments.",
      "将不同环境中对应同一仓库的项目合并显示。",
    ],
  },
  "project-order": {
    title: ["Project order", "项目排序"],
    description: [
      "Order of projects in the sidebar project picker and command palette.",
      "侧栏项目选择器和命令面板中的项目顺序。",
    ],
  },
  "working-shelf": {
    title: ["Working section", "进行中分组"],
    description: [
      "Fold working and monitoring threads into a Working section. They return to the top of the inbox when they need you. The boring sidebar in Labs has no Working section.",
      "把正在运行或监控的会话归入「进行中」。需要你处理时，它们会回到会话列表顶部。「实验室」中的按项目分组侧栏没有这个区域。",
    ],
  },
  "thread-notifications": {
    title: ["Thread notifications", "会话通知"],
  },
  "in-app-notifications": {
    title: ["In-app notifications", "应用内通知"],
    description: [
      "Show a toast when another thread finishes, fails, or needs input or approval while this app has focus.",
      "应用在前台时，其他会话完成、失败、需要回答或审批时显示提示。",
    ],
  },
  "time-format": {
    title: ["Time format", "时间格式"],
    description: [
      "System default follows your browser or OS clock preference.",
      "系统默认会使用浏览器或操作系统的时钟格式。",
    ],
  },
  "unpin-confirmation": {
    title: ["Unpin confirmation", "取消固定时确认"],
    description: [
      "Ask before unpinning a thread from the pinned section.",
      "从固定区取消固定会话前先确认。",
    ],
  },
  "archive-confirmation": {
    title: ["Archive confirmation", "归档时确认"],
    description: [
      "Require a second click on the inline archive action before a thread is archived.",
      "在会话旁点击归档时，需要再点击一次确认。",
    ],
  },
  "delete-confirmation": {
    title: ["Delete confirmation", "删除时确认"],
    description: [
      "Ask before deleting a thread and its chat history.",
      "删除会话及其聊天记录前先确认。",
    ],
  },
  "quit-confirmation": {
    title: ["Quit shortcut", "退出快捷键"],
    description: [
      "Hold mode quits after holding the shortcut for 5 seconds.",
      "长按模式需按住快捷键 5 秒才退出。",
    ],
  },
  "color-scheme": {
    title: ["Color scheme", "外观模式"],
  },
  theme: {
    title: ["Themes", "主题"],
  },
  "setting-appearance-contrast": {
    title: ["Contrast", "对比度"],
    description: [
      "Adjust the contrast of colors and borders across the interface.",
      "调整界面颜色和边框的对比度。",
    ],
  },
  "setting-glass-opacity": {
    title: ["Glass opacity", "透明效果不透明度"],
    description: [
      "Higher values make menus, dialogs, and the composer more solid.",
      "增大此值可降低菜单、对话框和输入区的透明度。",
    ],
  },
  "chat-width": {
    title: ["Chat width", "聊天宽度"],
    description: [
      "Set how wide messages and the composer can grow on large screens.",
      "设置大屏幕上消息和输入区的最大宽度。",
    ],
  },
  "thread-details-items": {
    title: ["Thread details", "会话详情"],
  },
  "effort-display": {
    title: ["Effort display", "推理强度显示"],
    description: [
      "Show reasoning effort in the composer as its name, such as High, or as bars.",
      "在输入区以名称（例如「高」）或条形标记显示推理强度。",
    ],
  },
  "math-rendering": {
    title: ["Render math", "数学公式渲染"],
  },
  "panel-animations": {
    title: ["Panel animations", "面板动画"],
    description: ["Set how fast panels open and close.", "设置面板打开与关闭的动画速度。"],
  },
  "environment-identification": {
    title: ["Environment identification", "环境标识"],
  },
  "interface-font": {
    title: ["Interface font", "界面字体"],
  },
  "prompt-font": {
    title: ["Prompt font", "输入字体"],
  },
  "code-font": {
    title: ["Code font", "代码字体"],
  },
  "terminal-font": {
    title: ["Terminal font", "终端字体"],
  },
  "separate-fonts": {
    title: ["Separate fonts", "分别设置字体"],
  },
  "font-smoothing": {
    title: ["Font smoothing", "字体平滑"],
  },
  "word-wrap": {
    title: ["Word wrap", "自动换行"],
  },
  "composer-context": {
    title: ["Composer context", "输入区上下文"],
    description: [
      "Keep branch and worktree controls below the composer after a thread starts.",
      "开始会话后，在输入区下方继续显示分支和工作树控件。",
    ],
  },
  "skills-in-slash-menu": {
    title: ["Show skills in slash menu", "在斜杠菜单显示技能"],
    description: [
      "Also include skills in the / command menu. Skills always appear when you type $.",
      "在 / 命令菜单中也显示技能。输入 $ 时始终显示技能。",
    ],
  },
  "composer-rich-text": {
    title: ["Rich text composer", "富文本输入"],
    description: ["Show formatted Markdown as you type.", "输入时显示格式化的 Markdown。"],
  },
  "send-shortcut": {
    title: ["Send shortcut", "发送快捷键"],
    description: [
      "Choose when Enter sends a prompt or inserts a new line",
      "选择按 Enter 键时发送消息还是换行。",
    ],
  },
  "follow-up-behavior": {
    title: ["Follow-up behavior", "追加消息行为"],
  },
  "diff-color-scheme": {
    title: ["Diff colors", "改动颜色"],
    description: [
      "Choose colors for additions and deletions, including change counts.",
      "选择新增、删除以及改动计数使用的颜色。",
    ],
  },
  "hide-whitespace-changes": {
    title: ["Hide whitespace changes", "隐藏纯空白改动"],
    description: [
      "Set whether the diff panel ignores whitespace-only edits by default.",
      "设置差异面板默认是否忽略仅涉及空白的修改。",
    ],
  },
  "default-diff-file-state": {
    title: ["Default diff file state", "差异文件的默认展开状态"],
    description: [
      "Start with files expanded or collapsed when opening diffs or a pull request's Code tab.",
      "打开差异或拉取请求的代码选项卡时，文件默认展开或折叠。",
    ],
  },
  "diff-layout": {
    title: ["Diff layout", "差异布局"],
    description: [
      "Show diffs stacked or side by side. The toggle in the diff toolbar changes this too.",
      "将差异上下排列或并排显示。差异工具栏也可切换。",
    ],
  },
  "proactive-panels": {
    title: ["Open pull requests and changes panels proactively", "自动打开拉取请求或改动面板"],
    description: [
      "Open linked pull requests first. Otherwise, open Changes for edits to at least 3 files or 50 lines.",
      "优先打开关联的拉取请求。没有关联时，改动达到 3 个文件或 50 行便打开改动面板。",
    ],
  },
  "pull-request-links-open-in-app": {
    title: ["Open pull requests in T3 Code", "在 T3 Code 内打开拉取请求"],
  },
  "project-overview": {
    title: ["Project overview", "项目概览"],
  },
  "project-actions": {
    title: ["Actions", "项目操作"],
  },
  "compact-idle-threads": {
    title: ["Compact idle threads", "压缩闲置会话"],
    description: [
      "When to compact an idle Claude thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Each Claude provider can override this.",
      "设定超过 20 万个 token 的闲置 Claude 会话何时压缩。可选返回会话后、提示缓存即将到期时或从不压缩。每个 Claude 服务商可以覆盖此设置。",
    ],
  },
  providers: {
    title: ["Providers", "模型服务商"],
  },
  "usage-providers": {
    title: ["Usage providers", "用量来源"],
  },
  "cursor-keychain-usage": {
    title: ["Cursor account usage", "Cursor 账号用量"],
  },
  "provider-health-check-interval": {
    title: ["Health check interval", "状态检查间隔"],
  },
  "project-defaults": {
    title: ["Project defaults and overrides", "项目默认值与覆盖项"],
  },
  "default-model": {
    title: ["Default model", "默认模型"],
  },
  "fallback-model": {
    title: ["Fallback model", "备用模型"],
    description: [
      "Used for new threads when the default model's provider is out of usage.",
      "默认模型的服务商额度耗尽时，新会话使用此模型。",
    ],
  },
  "default-permissions": {
    title: ["Permissions", "权限"],
  },
  "snooze-options": {
    title: ["Snooze options", "稍后提醒选项"],
  },
  "snooze-limited-threads": {
    title: ["Snooze until limits reset", "等额度重置后提醒"],
    description: [
      "Snooze threads until their usage limits reset. Enable auto-resume to continue the agent after the reset.",
      "将会话稍后提醒至用量额度重置。启用自动继续后，代理会在重置时继续工作。",
    ],
  },
  "auto-resume-limited-threads": {
    title: ["Resume after usage limits", "额度重置后继续"],
    description: [
      "Automatically resume threads when their usage limits reset. You can cancel auto-resume in each thread.",
      "用量额度重置后自动继续会话。可以在每个会话中取消自动继续。",
    ],
  },
  "auto-settle-inactive-threads": {
    title: ["Auto-settle inactive threads", "自动收起闲置会话"],
    description: [
      "Sidebar threads with no activity for this long settle automatically.",
      "侧栏中达到指定闲置时长的会话会自动收起。",
    ],
  },
  "auto-settle-merged-threads": {
    title: ["Auto-settle merged threads", "自动收起已合并会话"],
    description: [
      "Settle a thread when its pull request merges. Closed pull requests still settle automatically.",
      "关联的拉取请求合并后收起会话。关闭的拉取请求仍会触发自动收起。",
    ],
  },
  "keep-threads-with-pull-requests": {
    title: ["Keep threads with a PR", "保留有关联拉取请求的会话"],
  },
  "days-before-auto-settle": {
    title: ["Days of inactivity before auto-settle", "自动收起前的闲置天数"],
  },
  "response-streaming": {
    title: ["Response streaming", "回复流式输出"],
  },
  "new-threads": {
    title: ["New threads", "新会话"],
  },
  "add-project-starts-in": {
    title: ["Add project starts in", "添加项目的起始目录"],
  },
  "ghq-clone-layout": {
    title: ["Clone into host folders", "按主机名整理克隆目录"],
    description: [
      "Clones go to github.com/owner/repo under the folder above, like ghq.",
      "仓库克隆到上述目录下的 github.com/owner/repo，采用 ghq 目录结构。",
    ],
  },
  "text-generation-model": {
    title: ["Text generation model", "文本生成模型"],
    description: [
      "Used for thread titles and other generated text on connected devices with this provider. Source control can override it.",
      "在使用此服务商的已连接设备上生成会话标题等文本。源代码管理设置可以覆盖它。",
    ],
  },
  "thread-title-instructions": {
    title: ["Thread title instructions", "会话标题说明"],
  },
  "storage-worktrees": {
    title: ["Worktree cleanup", "工作树清理"],
  },
  "storage-worktrees-location": {
    title: ["Worktree location", "工作树目录"],
  },
  "worktree-submodules": {
    title: ["Submodules", "子模块"],
  },
  "start-from-origin": {
    title: ["Start from remote", "从远端开始"],
  },
  "worktree-branch-naming": {
    title: ["Worktree branch naming", "工作树分支命名"],
  },
  "app-version": {
    title: ["Version", "版本"],
  },
  "update-track": {
    title: ["Update track", "更新渠道"],
    description: ["Switches the hosted app release channel.", "切换托管应用的发布渠道。"],
  },
  "cli-command": {
    title: ["t3 command", "t3 命令"],
  },
  "mobile-app": {
    title: ["Mobile app", "移动应用"],
  },
  "privacy-policy": {
    title: ["Privacy policy", "隐私政策"],
  },
  "open-source-licenses": {
    title: ["Open source licenses", "开源许可证"],
    description: [
      "Notices for dependencies, assets, and optional tools used by T3 Code.",
      "T3 Code 使用的依赖项、资源和可选工具的许可声明。",
    ],
  },
  "local-environment": {
    title: ["Local environment", "本机环境"],
  },
  "remote-environments": {
    title: ["Environments", "环境"],
  },
  "load-balancing": {
    title: ["Load balancing", "负载均衡"],
  },
  "pull-request-routing": {
    title: ["Pull request sharing", "拉取请求共享"],
  },
  "environment-icon": {
    title: ["Environment icon", "环境图标"],
  },
  "network-access": {
    title: ["Network access", "网络访问"],
  },
  "tailscale-https": {
    title: ["Tailscale HTTPS", "Tailscale HTTPS"],
  },
  "wsl-backend": {
    title: ["WSL backend", "WSL 后端"],
  },
  "connections-environment": {
    title: ["This machine", "本机"],
  },
  "ui-language": {
    title: ["Interface language", "界面语言"],
  },
};

// A stable settings ID locates the copy. Match the source too so an upstream wording
// change with new semantics cannot keep displaying an older translation.
function translated(language: UiLanguage, copy: CopyPair | undefined, source: string): string {
  return language === "zh-CN" && copy?.[0] === source ? copy[1] : source;
}

export function settingsPageLabel(language: UiLanguage, path: string, source: string): string {
  return translated(language, pageCopy[path], source);
}

export function settingsGroupLabel(language: UiLanguage, source: string): string {
  return translated(language, groupCopy[source], source);
}

export function settingsSectionTitle(
  language: UiLanguage,
  id: string | undefined,
  source: string,
): string {
  return translated(language, id === undefined ? undefined : sectionCopy[id], source);
}

export function settingsRowText(
  language: UiLanguage,
  id: string | undefined,
  field: keyof SettingCopy,
  source: string,
): string {
  return translated(language, id === undefined ? undefined : settingCopy[id]?.[field], source);
}
