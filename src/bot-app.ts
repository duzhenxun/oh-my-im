import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadConfig, type Config } from "./core/config.js";
import { agentLabel, agentSwitchMessage, listAgentSessions, runAgent, type AgentSessionInfo } from "./agents/index.js";
import { DingTalkBot, isSingleConversation, type DingTalkTextMessage, type DingTalkReplyHandle, type DownloadedAttachment } from "./dingtalk/dingtalk.js";
import { createLogger } from "./core/logger.js";
import { normalizeDingTalkMarkdown } from "./dingtalk/markdown.js";
import { DingTalkAiCardClient } from "./dingtalk/dingtalk-ai-card.js";
import { AiCardSession } from "./dingtalk/ai-card.js";
import type { CommandKeywordsConfig } from "./dws-dashboard.js";
import type { ResponseMode } from "./dws-dashboard.js";
import { parseAgentControlCommand } from "./core/monitor-command.js";
import { appendConversationLog } from "./core/conversation-log.js";

interface SelectedSession {
  id: string;
  cwd: string;
}

interface SessionDirectory {
  cwd: string;
  piCount: number;
  codexCount: number;
  opencodeCount: number;
  updatedAt?: string;
}

interface ConversationState {
  defaultWorkDir: string;
  selectedAgent?: Config["agent"];
  adminWorkDir?: string;
  adminDirectories?: SessionDirectory[];
  sessions: Partial<Record<Config["agent"], string>>;
  selectedSessions: Partial<Record<Config["agent"], SelectedSession>>;
  visibleSessionLists: Partial<Record<Config["agent"], AgentSessionInfo[]>>;
  busy: boolean;
  abort?: () => void;
  stopCardUpdates?: () => void;
  steer?: (message: string) => boolean;
  steerTaskToken?: string;
  pendingMessages: DingTalkTextMessage[];
  pendingNoticeSent: boolean;
  activeAgent?: Config["agent"];
  activeFingerprint?: string;
  paused?: boolean;
}

const PRIVATE_SESSIONS_FILE = join(homedir(), ".oh-my-im", "private-sessions.json");
const PRIVATE_AGENTS_FILE = join(homedir(), ".oh-my-im", "private-agents.json");
const privateSessionBindings = new Map<string, string>();
// Agent 与具体会话绑定：私聊 A 切了 Agent 不影响私聊 B，重启后也能各自记住。
const privateAgentBindings = new Map<string, Config["agent"]>();
try {
  const stored = JSON.parse(readFileSync(PRIVATE_SESSIONS_FILE, "utf8")) as Record<string, unknown>;
  Object.entries(stored).forEach(([key, value]) => { if (typeof value === "string" && value.trim()) privateSessionBindings.set(key, value.trim()); });
} catch { /* first run */ }
try {
  const stored = JSON.parse(readFileSync(PRIVATE_AGENTS_FILE, "utf8")) as Record<string, unknown>;
  Object.entries(stored).forEach(([key, value]) => {
    if (value === "pi" || value === "codex" || value === "opencode") privateAgentBindings.set(key, value);
  });
} catch { /* first run */ }

function savePrivateAgents(): void {
  mkdirSync(dirname(PRIVATE_AGENTS_FILE), { recursive: true });
  const temporary = `${PRIVATE_AGENTS_FILE}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(privateAgentBindings), null, 2)}\n`, "utf8");
  renameSync(temporary, PRIVATE_AGENTS_FILE);
}

function setPrivateAgent(conversationId: string, agent: Config["agent"]): void {
  if (privateAgentBindings.get(conversationId) === agent) return;
  privateAgentBindings.set(conversationId, agent);
  savePrivateAgents();
}

function privateSessionKey(conversationId: string, agent: Config["agent"], workDir: string): string {
  // The work directory is part of the key: a stored session created in a
  // different directory must never be resumed, otherwise Pi/Codex/OpenCode
  // fail with a project mismatch after the working directory changes.
  return `${agent}:${conversationId}:${workDir}`;
}

function savePrivateSessions(): void {
  mkdirSync(dirname(PRIVATE_SESSIONS_FILE), { recursive: true });
  const temporary = `${PRIVATE_SESSIONS_FILE}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(privateSessionBindings), null, 2)}\n`, "utf8");
  renameSync(temporary, PRIVATE_SESSIONS_FILE);
}

function clearPrivateSessionBindings(conversationId: string): void {
  let changed = false;
  for (const agent of ["pi", "codex", "opencode"] as const) {
    const prefix = `${agent}:${conversationId}:`;
    for (const key of [...privateSessionBindings.keys()]) {
      if (key.startsWith(prefix)) {
        privateSessionBindings.delete(key);
        changed = true;
      }
    }
  }
  if (changed) savePrivateSessions();
}

const log = createLogger("Main");

function safeDirName(value: string, fallback: string): string {
  // Chinese display names are valid directory names; only strip characters
  // that are illegal on the filesystem or could escape the parent directory.
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

function privateUserWorkDir(message: DingTalkTextMessage): string {
  // An explicit AGENT_WORK_DIR override is used as-is (single shared dir).
  const override = process.env.AGENT_WORK_DIR?.trim();
  if (override) {
    mkdirSync(override, { recursive: true });
    return override;
  }
  // Otherwise each DingTalk user gets their own directory named after the
  // sender display name, for example ~/.oh-my-im/users/杜振训.
  const userId = message.senderStaffId?.trim() || message.senderId.trim();
  const displayName = safeDirName(message.senderNick ?? "", safeDirName(userId, "unknown"));
  const dir = join(homedir(), ".oh-my-im", "users", displayName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function pathInside(root: string, candidate?: string): boolean {
  if (!candidate) return false;
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function getState(
  conversations: Map<string, ConversationState>,
  conversationId: string,
  defaultWorkDir: string,
): ConversationState {
  const existing = conversations.get(conversationId);
  if (existing) {
    // The directory is derived from the sender display name, so a nickname
    // change must take effect on the next message. Reset the bound sessions
    // and selections so no Agent keeps running in (or resumes a session from)
    // the previous directory.
    if (existing.defaultWorkDir !== defaultWorkDir) {
      existing.defaultWorkDir = defaultWorkDir;
      existing.selectedSessions = {};
      existing.visibleSessionLists = {};
      existing.sessions = {};
      // Drop persisted session bindings too; resuming a session created in the
      // previous directory makes Pi/Codex/OpenCode fail with a project
      // mismatch, so the next message must start a fresh session.
      clearPrivateSessionBindings(conversationId);
    }
    return existing;
  }
  const created: ConversationState = {
    defaultWorkDir,
    sessions: {}, selectedSessions: {}, visibleSessionLists: {}, pendingMessages: [], pendingNoticeSent: false, busy: false,
    selectedAgent: privateAgentBindings.get(conversationId),
  };
  (['codex', 'pi', 'opencode'] as const).forEach((agent) => {
    const sessionId = privateSessionBindings.get(privateSessionKey(conversationId, agent, defaultWorkDir));
    if (sessionId) created.sessions[agent] = sessionId;
  });
  conversations.set(conversationId, created);
  return created;
}

function isAllowed(message: DingTalkTextMessage, allowedUserIds: string[]): boolean {
  // Single-chat authorization is deny-by-default. Only users explicitly added
  // in the dashboard may use the bot; an empty list allows nobody.
  if (allowedUserIds.length === 0) return false;
  // DingTalk may provide both a staffId and an open userId. The dashboard
  // stores the openDingTalkId returned by dws, so accept either identifier.
  const senderIds = [message.senderStaffId, message.senderId]
    .filter((id): id is string => Boolean(id?.trim()))
    .map((id) => id.trim());
  return senderIds.some((id) => allowedUserIds.includes(id));
}

function formatSessionTime(value?: string): string {
  if (!value) return "未知时间";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function buildAdminDirectories(piSessions: AgentSessionInfo[], codexSessions: AgentSessionInfo[], opencodeSessions: AgentSessionInfo[]): SessionDirectory[] {
  const directories = new Map<string, SessionDirectory>();
  const append = (agent: Config["agent"], session: AgentSessionInfo) => {
    if (!session.cwd) return;
    const current = directories.get(session.cwd) ?? { cwd: session.cwd, piCount: 0, codexCount: 0, opencodeCount: 0 };
    if (agent === "pi") current.piCount += 1;
    else if (agent === "codex") current.codexCount += 1;
    else current.opencodeCount += 1;
    const timestamp = session.updatedAt ?? session.createdAt;
    if ((timestamp ?? "") > (current.updatedAt ?? "")) current.updatedAt = timestamp;
    directories.set(session.cwd, current);
  };
  piSessions.forEach((session) => append("pi", session));
  codexSessions.forEach((session) => append("codex", session));
  opencodeSessions.forEach((session) => append("opencode", session));
  return [...directories.values()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

function formatAdminDirectories(directories: SessionDirectory[]): string {
  if (directories.length === 0) return "本机没有找到 Agent Session 工作目录。";
  return [
    `超级管理员 Session 目录（共 ${directories.length} 个）：`,
    ...directories.slice(0, 30).map((directory, index) => [
      `${index + 1}. ${directory.cwd}`,
      `   Pi: ${directory.piCount} · Codex: ${directory.codexCount} · OpenCode: ${directory.opencodeCount} · 最近: ${formatSessionTime(directory.updatedAt)}`,
    ].join("\n")),
    directories.length > 30 ? `仅显示最近 30 个目录，共 ${directories.length} 个。` : "",
    "",
    "选择目录：/admin-cd <编号>",
  ].filter(Boolean).join("\n");
}

function formatSessionList(
  agent: Config["agent"], cwd: string, sessions: AgentSessionInfo[], selected?: SelectedSession, admin = false,
): string {
  const label = agentLabel(agent);
  if (sessions.length === 0) return `${cwd} 下没有找到 ${label} Session。`;
  return [
    `${label} Sessions（路径：${cwd}，最近 ${Math.min(sessions.length, 10)} 条）：`,
    ...sessions.slice(0, 10).map((session, index) => [
      `${index + 1}. ${session.id === selected?.id ? "✅ " : ""}${session.title?.trim() || "(暂无用户消息摘要)"}`,
      `   ID: ${session.id}`,
      `   时间: ${formatSessionTime(session.updatedAt ?? session.createdAt)}`,
    ].join("\n")),
    "",
    `切换：/${admin ? "admin-use" : "use"} ${agent} <编号或sessionId>`,
    admin ? "返回目录：/admin-sessions" : `重新查看：/sessions ${agent}`,
  ].join("\n");
}
function shortModelName(model: string | undefined): string {
  const value = model?.trim() || "";
  return value.includes("/") ? value.slice(value.lastIndexOf("/") + 1) : value;
}

function buildCardContent(content: string, note?: string): string {
  // DingTalk cards render a limited Markdown subset without table support, so
  // convert tables to lists before they reach the card.
  const safeContent = normalizeDingTalkMarkdown(content).trim() || "[OMG] 正在分析...";
  const safeNote = note?.trim();
  return safeNote ? `${safeContent}\n\n\n${safeNote}` : safeContent;
}

function describeAttachment(attachment: DownloadedAttachment): string {
  const parts = [
    `类型: ${attachment.type}`,
    `路径: ${attachment.path}`,
  ];
  if (attachment.fileName) parts.push(`文件名: ${attachment.fileName}`);
  if (attachment.contentType) parts.push(`Content-Type: ${attachment.contentType}`);
  if (attachment.size) parts.push(`大小: ${attachment.size} bytes`);
  if (attachment.duration) parts.push(`时长: ${attachment.duration}ms`);
  if (attachment.recognition) parts.push(`语音识别: ${attachment.recognition}`);
  return parts.join("\n");
}

async function buildCodexPrompt(bot: DingTalkBot, message: DingTalkTextMessage, workDir: string): Promise<string> {
  if (message.msgtype === "text") return message.text.trim();

  const recognizedText = message.attachments
    .map((item) => item.recognition)
    .filter((item): item is string => Boolean(item?.trim()))
    .join("\n");
  const text = [...new Set([message.text, recognizedText].map((item) => item?.trim()).filter(Boolean))].join("\n");

  if (message.msgtype === "audio" || message.msgtype === "voice") {
    if (text) {
      return [
        "用户发送了一段语音，钉钉识别文本如下：",
        text,
        "请直接根据语音识别文本回复用户。",
      ].join("\n\n");
    }
    return [
      "用户发送了一段语音，但钉钉消息中没有提供语音识别文本。",
      "请告诉用户本次语音未识别成功，并请用户重新发送可识别的语音或补充文字。",
    ].join("\n\n");
  }

  // Pictures, videos and files still need a local file for the Agent to read.
  // Voice messages are handled above from DingTalk recognition and never reach
  // this download path.
  const downloaded = await bot.downloadAttachments(message, workDir);
  const attachmentText = downloaded.map(describeAttachment).join("\n\n");

  if (message.msgtype === "picture" || message.msgtype === "image") {
    return [
      "用户发送了图片。",
      attachmentText ? `图片已下载到本地：\n${attachmentText}` : "图片未能下载。",
      text ? `随图文字：\n${text}` : "",
      "请分析图片内容并回复用户。",
    ].filter(Boolean).join("\n\n");
  }

  if (message.msgtype === "richText") {
    return [
      "用户发送了富文本消息。",
      text ? `文本内容：\n${text}` : "",
      attachmentText ? `附件信息：\n${attachmentText}` : "",
      "请根据以上内容回复用户。",
    ].filter(Boolean).join("\n\n");
  }

  if (downloaded.length > 0) {
    return [
      `用户发送了 ${message.msgtype} 消息。`,
      `附件已下载到本地：\n${attachmentText}`,
      text ? `附带文本：\n${text}` : "",
      "请根据附件内容回复用户；如果当前 Codex 环境无法直接读取该类型文件，请说明已收到文件及本地路径。",
    ].filter(Boolean).join("\n\n");
  }

  throw new Error(`暂不支持 ${message.msgtype} 消息：钉钉没有提供可处理的文本或附件下载信息。`);
}

async function handleCommand(
  bot: DingTalkBot,
  config: Config,
  conversations: Map<string, ConversationState>,
  message: DingTalkTextMessage,
  text: string,
  isSuperAdmin: boolean,
): Promise<boolean> {
  const state = getState(conversations, message.conversationId, privateUserWorkDir(message));

  if (text === "/help") {
    await bot.sendText(message.conversationId, [
      "oh-my-im commands:",
      "/help - 查看帮助",
      "/status - 查看运行状态",
      "/sessions [pi|codex|opencode] - 默认查看当前 Agent 的 sessions，也可指定 Agent",
      "/use <pi|codex|opencode> <编号或sessionId> - 切换当前私有目录下的 session",
      "/current - 查看当前 Agent session 和工作路径",
        "/new - 清空当前会话的 Codex/Pi/OpenCode session",
      ...(isSuperAdmin ? [
        "/admin-sessions - 查看本机全部 Session 目录",
        "/admin-cd <目录编号> - 选择管理员工作目录",
        "/admin-sessions <pi|codex|opencode> - 查看所选目录的 sessions",
        "/admin-use <pi|codex|opencode> <编号或sessionId> - 切换管理员 session",
        "/admin-current - 查看管理员当前绑定",
        "/admin-reset - 返回自己的私有目录",
      ] : []),
    ].join("\n"));
    return true;
  }

  if (text === "/sessions" || text.startsWith("/sessions ")) {
    if (state.busy) {
      await bot.sendText(message.conversationId, "当前 Agent 任务正在运行，暂时不能查看或切换 Session。");
      return true;
    }
    const requested = text.split(/\s+/)[1]?.toLowerCase();
    const agents: Config["agent"][] = requested === "pi" || requested === "codex" || requested === "opencode"
      ? [requested]
      : [config.agent];
    const sections: string[] = [];
    for (const agent of agents) {
      // Never expose another DingTalk user's workspaces. Every private-chat
      // user gets one isolated default cwd, and only sessions created under
      // that cwd are visible and selectable.
      const sessions = (await listAgentSessions(agent, config))
        .filter((session) => pathInside(state.defaultWorkDir, session.cwd));
      state.visibleSessionLists[agent] = sessions;
      sections.push(formatSessionList(agent, state.defaultWorkDir, sessions, state.selectedSessions[agent]));
    }
    await bot.sendText(message.conversationId, sections.join("\n\n---\n\n"));
    return true;
  }

  if (text.startsWith("/use ")) {
    if (state.busy) {
      await bot.sendText(message.conversationId, "当前 Agent 任务正在运行，不能切换 Session。");
      return true;
    }
    const [, rawAgent, selector] = text.split(/\s+/, 3);
    const agent = rawAgent?.toLowerCase();
    if ((agent !== "pi" && agent !== "codex" && agent !== "opencode") || !selector) {
      await bot.sendText(message.conversationId, "用法：/use <pi|codex|opencode> <编号或sessionId>");
      return true;
    }
    const sessions = state.visibleSessionLists[agent] ?? (await listAgentSessions(agent, config))
      .filter((session) => pathInside(state.defaultWorkDir, session.cwd));
    state.visibleSessionLists[agent] = sessions;
    const index = Number.parseInt(selector, 10);
    const selected = Number.isInteger(index) && String(index) === selector
      ? sessions[index - 1]
      : sessions.find((session) => session.id === selector || session.id.startsWith(selector));
    if (!selected) {
      await bot.sendText(message.conversationId, `没有找到 ${agentLabel(agent)} Session：${selector}。请先发送 /sessions ${agent}。`);
      return true;
    }
    if (!selected.cwd || !pathInside(state.defaultWorkDir, selected.cwd) || !existsSync(selected.cwd)) {
      await bot.sendText(message.conversationId, "该 Session 不属于当前用户的私有工作目录，无法切换。");
      return true;
    }
    state.sessions[agent] = selected.id;
    state.selectedSessions[agent] = { id: selected.id, cwd: selected.cwd };
    state.selectedAgent = agent;
    setPrivateAgent(message.conversationId, agent);
    await bot.sendText(message.conversationId, [
      `已切换到 ${agentLabel(agent)} Session。`,
      `Session: ${selected.id}`,
      `路径: ${selected.cwd}`,
      "后续该 Agent 的消息会在此路径下继续执行。",
    ].join("\n"));
    return true;
  }

  if (text === "/admin-sessions" || text.startsWith("/admin-sessions ")) {
    if (!isSuperAdmin) {
      await bot.sendText(message.conversationId, "抱歉，您没有 Session 超级管理员权限。");
      return true;
    }
    if (state.busy) {
      await bot.sendText(message.conversationId, "当前 Agent 任务正在运行，暂时不能管理 Session。");
      return true;
    }
    const requested = text.split(/\s+/)[1]?.toLowerCase();
    if (requested !== "pi" && requested !== "codex" && requested !== "opencode") {
      const [piSessions, codexSessions, opencodeSessions] = await Promise.all([
        listAgentSessions("pi", config), listAgentSessions("codex", config), listAgentSessions("opencode", config),
      ]);
      state.adminDirectories = buildAdminDirectories(piSessions, codexSessions, opencodeSessions);
      await bot.sendText(message.conversationId, formatAdminDirectories(state.adminDirectories));
      return true;
    }
    if (!state.adminWorkDir) {
      await bot.sendText(message.conversationId, "请先发送 /admin-sessions 查看目录，再发送 /admin-cd <目录编号>。 ");
      return true;
    }
    const sessions = (await listAgentSessions(requested, config))
      .filter((session) => resolve(session.cwd ?? "") === resolve(state.adminWorkDir ?? ""));
    state.visibleSessionLists[requested] = sessions;
    await bot.sendText(message.conversationId, formatSessionList(
      requested, state.adminWorkDir, sessions, state.selectedSessions[requested], true,
    ));
    return true;
  }

  if (text.startsWith("/admin-cd ")) {
    if (!isSuperAdmin) {
      await bot.sendText(message.conversationId, "抱歉，您没有 Session 超级管理员权限。");
      return true;
    }
    if (state.busy) {
      await bot.sendText(message.conversationId, "当前 Agent 任务正在运行，不能切换管理员目录。");
      return true;
    }
    const selector = text.split(/\s+/)[1];
    const index = Number.parseInt(selector ?? "", 10);
    const directory = Number.isInteger(index) && String(index) === selector
      ? state.adminDirectories?.[index - 1]
      : state.adminDirectories?.find((item) => item.cwd === selector);
    if (!directory || !existsSync(directory.cwd)) {
      await bot.sendText(message.conversationId, "没有找到该目录，请先发送 /admin-sessions 获取最新目录列表。");
      return true;
    }
    state.adminWorkDir = directory.cwd;
    state.visibleSessionLists = {};
    await bot.sendText(message.conversationId, [
      "管理员工作目录已切换：", directory.cwd,
      `Pi Sessions: ${directory.piCount}`,
      `Codex Sessions: ${directory.codexCount}`,
      `OpenCode Sessions: ${directory.opencodeCount}`,
      "查看：/admin-sessions pi、/admin-sessions codex 或 /admin-sessions opencode",
    ].join("\n"));
    return true;
  }

  if (text.startsWith("/admin-use ")) {
    if (!isSuperAdmin) {
      await bot.sendText(message.conversationId, "抱歉，您没有 Session 超级管理员权限。");
      return true;
    }
    if (state.busy) {
      await bot.sendText(message.conversationId, "当前 Agent 任务正在运行，不能切换管理员 Session。");
      return true;
    }
    const [, rawAgent, selector] = text.split(/\s+/, 3);
    const agent = rawAgent?.toLowerCase();
    if ((agent !== "pi" && agent !== "codex" && agent !== "opencode") || !selector || !state.adminWorkDir) {
      await bot.sendText(message.conversationId, "用法：先 /admin-cd <目录编号>，再 /admin-use <pi|codex|opencode> <编号或sessionId>");
      return true;
    }
    const sessions = state.visibleSessionLists[agent] ?? (await listAgentSessions(agent, config))
      .filter((session) => resolve(session.cwd ?? "") === resolve(state.adminWorkDir ?? ""));
    state.visibleSessionLists[agent] = sessions;
    const index = Number.parseInt(selector, 10);
    const selected = Number.isInteger(index) && String(index) === selector
      ? sessions[index - 1]
      : sessions.find((session) => session.id === selector || session.id.startsWith(selector));
    if (!selected?.cwd || resolve(selected.cwd) !== resolve(state.adminWorkDir) || !existsSync(selected.cwd)) {
      await bot.sendText(message.conversationId, `所选 Session 不属于当前管理员目录，请先发送 /admin-sessions ${agent}。`);
      return true;
    }
    state.sessions[agent] = selected.id;
    state.selectedSessions[agent] = { id: selected.id, cwd: selected.cwd };
    state.selectedAgent = agent;
    setPrivateAgent(message.conversationId, agent);
    await bot.sendText(message.conversationId, [
      `已切换到管理员 ${agentLabel(agent)} Session。`,
      `Session: ${selected.id}`,
      `路径: ${selected.cwd}`,
      "该切换只影响当前私聊，不影响其他用户和全局 Agent。",
    ].join("\n"));
    return true;
  }

  if (text === "/admin-current") {
    if (!isSuperAdmin) {
      await bot.sendText(message.conversationId, "抱歉，您没有 Session 超级管理员权限。");
      return true;
    }
    const agent = state.selectedAgent ?? config.agent;
    await bot.sendText(message.conversationId, [
      `Agent: ${agentLabel(agent)}`,
      `管理员目录: ${state.adminWorkDir ?? "未选择"}`,
      `Session: ${state.sessions[agent] ?? "new"}`,
      `执行路径: ${state.selectedSessions[agent]?.cwd ?? state.defaultWorkDir}`,
    ].join("\n"));
    return true;
  }

  if (text === "/admin-reset") {
    if (!isSuperAdmin) {
      await bot.sendText(message.conversationId, "抱歉，您没有 Session 超级管理员权限。");
      return true;
    }
    state.adminWorkDir = undefined;
    state.adminDirectories = undefined;
    state.selectedAgent = undefined;
    state.sessions = {};
    state.selectedSessions = {};
    state.visibleSessionLists = {};
    await bot.sendText(message.conversationId, `已退出管理员 Session，恢复私有目录：${state.defaultWorkDir}`);
    return true;
  }

  if (text === "/current") {
    const currentAgent = state.selectedAgent ?? config.agent;
    const selected = state.selectedSessions[currentAgent];
    await bot.sendText(message.conversationId, [
      `Agent: ${agentLabel(currentAgent)}`,
      `Session: ${state.sessions[currentAgent] ?? "new"}`,
      `路径: ${selected?.cwd ?? state.defaultWorkDir}`,
    ].join("\n"));
    return true;
  }

  if (text === "/status") {
    await bot.sendText(message.conversationId, [
      "oh-my-im status:",
      `Agent: ${agentLabel(state.selectedAgent ?? config.agent)}`,
      `Codex CLI: ${config.codexCliPath}`,
      `Pi CLI: ${config.piCliPath ?? "pi"}`,
      `WorkDir: ${state.selectedSessions[state.selectedAgent ?? config.agent]?.cwd ?? state.defaultWorkDir}`,
      `Current session: ${state.sessions[state.selectedAgent ?? config.agent] ?? "new"}`,
      `Known conversations: ${conversations.size}`,
    ].join("\n"));
    return true;
  }

  if (text === "/new") {
    clearPrivateSessionBindings(message.conversationId);
    state.sessions = {};
    state.selectedSessions = {};
    state.visibleSessionLists = {};
    // 只清空 session 与工作路径绑定，保留当前选中的 Agent，
    // 否则下一条消息会退回默认 Agent（看起来像被自动切换了）。
    state.adminWorkDir = undefined;
    state.adminDirectories = undefined;
    await bot.sendText(message.conversationId, "已清空当前会话的 Agent session 和工作路径绑定。");
    return true;
  }

  return false;
}

export async function runApp(
  configOverride?: Config,
  options: {
    singleChatOnly?: boolean;
    getAgent?: () => Config["agent"];
    getAgentModel?: (agent: Config["agent"]) => string | undefined;
    getResponseMode?: () => ResponseMode;
    getShowProcessingDetails?: () => boolean;
    getAllowedUserIds?: () => string[];
    getCommandKeywords?: () => CommandKeywordsConfig | undefined;
    getSuperAdminUserIds?: () => string[];
    getAiCardConfig?: () => { templateId: string; contentKey: string; streamIntervalMs: number };
    getPrivateChatEnabled?: () => boolean;
    getCardUpdateIntervalMs?: () => number;
    getShowElapsed?: () => boolean;
    onConnectionStatus?: (connected: boolean) => void;
  } = {},
): Promise<void> {
  const config = configOverride ?? loadConfig();
  const bot = new DingTalkBot(config);
  const aiCardClient = new DingTalkAiCardClient();
  aiCardClient.setCredentials(config.dingtalkClientId, config.dingtalkClientSecret, config.dingtalkClientId);
  const conversations = new Map<string, ConversationState>();
  // Stream callbacks can still be redelivered when an ACK is lost, and DWS /
  // history paths may surface the same content twice. Without message-level
  // deduplication, one user message can enter the busy branch again and emit
  // the misleading "后续消息" acknowledgement even though the user sent it
  // only once.
  const handledCallbackIds = new Set<string>();
  const handledCallbackIdLimit = 2_000;
  const handledMessageFingerprints = new Map<string, number>();
  const messageFingerprintTtlMs = 15_000;

  // `replay` marks an internally replayed queue batch: its callback id and
  // fingerprint were already registered when the messages first arrived, so
  // deduplication must be skipped or the queued follow-ups would be dropped.
  async function handleMessage(message: DingTalkTextMessage, replay = false): Promise<void> {
    if (options.getPrivateChatEnabled?.() === false) {
      log.info(`ignored private message while private chat is disabled conversation=${message.conversationId}`);
      return;
    }
    if (!replay && message.callbackId?.trim()) {
      const callbackId = message.callbackId.trim();
      if (handledCallbackIds.has(callbackId)) {
        log.warn(`ignored duplicate DingTalk callback callbackId=${callbackId} conversation=${message.conversationId} text=${JSON.stringify(message.text.slice(0, 120))}`);
        return;
      }
      handledCallbackIds.add(callbackId);
      if (handledCallbackIds.size > handledCallbackIdLimit) {
        handledCallbackIds.delete(handledCallbackIds.values().next().value as string);
      }
    }
    const messageFingerprint = [
      message.conversationId,
      message.senderStaffId || message.senderId,
      message.msgtype,
      message.text.trim(),
      message.attachments.map((attachment) => `${attachment.type}:${attachment.downloadCode}`).join(","),
    ].join("\u0000");
    const now = Date.now();
    if (!replay) {
      const previousMessageAt = handledMessageFingerprints.get(messageFingerprint);
      if (previousMessageAt !== undefined && now - previousMessageAt < messageFingerprintTtlMs) {
        log.warn(`ignored duplicate DingTalk message fingerprint conversation=${message.conversationId} text=${JSON.stringify(message.text.slice(0, 120))}`);
        return;
      }
      handledMessageFingerprints.set(messageFingerprint, now);
      for (const [fingerprint, timestamp] of handledMessageFingerprints) {
        if (now - timestamp >= messageFingerprintTtlMs) handledMessageFingerprints.delete(fingerprint);
      }
    }

    log.info(
      `received message conversation=${message.conversationId} conversationType=${message.conversationType ?? "<none>"} msgtype=${message.msgtype} senderNick=${message.senderNick ?? "<none>"} senderId=${message.senderId} senderStaffId=${message.senderStaffId ?? "<none>"} text=${JSON.stringify(message.text.slice(0, 500))} textLen=${message.text.length} attachmentCount=${message.attachments.length}`,
    );
    if (options.singleChatOnly && !isSingleConversation(message.conversationType)) {
      log.debug(`ignored non-single conversation=${message.conversationId} type=${message.conversationType ?? "unknown"}`);
      return;
    }
    const allowedUserIds = options.getAllowedUserIds?.() ?? config.allowedUserIds;
    const allowed = isAllowed(message, allowedUserIds);
    log.info(
      `permission check conversation=${message.conversationId} senderNick=${message.senderNick ?? "<none>"} senderId=${message.senderId} senderStaffId=${message.senderStaffId ?? "<none>"} allowedCount=${allowedUserIds.length} allowed=[${allowedUserIds.join(",")}] result=${allowed ? "ALLOW" : "DENY"}`,
    );
    if (!allowed) {
      const receivedIds = [message.senderStaffId, message.senderId].filter(Boolean).join(", ");
      await bot.sendText(message.conversationId, `抱歉，您没有访问权限。\n收到的 ID: ${receivedIds}`);
      return;
    }

    const text = message.text.trim();
    if (!text && message.attachments.length === 0 && message.msgtype !== "richText") return;
    const superAdminIds = options.getSuperAdminUserIds?.() ?? [];
    const isSuperAdminUser = [message.senderStaffId, message.senderId]
      .filter((id): id is string => Boolean(id?.trim()))
      .some((id) => superAdminIds.includes(id.trim()));

    if (message.msgtype === "text" || message.msgtype === "richText") {
      const keywords = options.getCommandKeywords?.();
      const control = keywords ? parseAgentControlCommand(text, keywords) : undefined;
      if (control === "pause") {
        const state = getState(conversations, message.conversationId, privateUserWorkDir(message));
        if (!state.busy || !state.abort) {
          await bot.sendText(message.conversationId, "当前没有正在处理的 Agent 任务。");
          return;
        }
        state.paused = true;
        state.abort();
        // The task's card timers are owned by the message handler. Mark the
        // task stopped immediately so a delayed update cannot restore the
        // "处理中" title after the user has paused it.
        state.stopCardUpdates?.();
        return;
      }
      if (control && typeof control === "object") {
        const state = getState(conversations, message.conversationId, privateUserWorkDir(message));
        state.selectedAgent = control.agent;
        // 只绑定到当前会话：别的私聊/群聊不受影响，重启后这个会话仍记得。
        setPrivateAgent(message.conversationId, control.agent);
        await bot.sendText(message.conversationId, agentSwitchMessage(control.agent));
        return;
      }
    }

    if (message.msgtype === "text" && text.startsWith("/")) {
      log.info(`command=${text} conversation=${message.conversationId}`);
    }

    const state = getState(conversations, message.conversationId, privateUserWorkDir(message));
    const selectedAgent = state.selectedAgent ?? options.getAgent?.() ?? config.agent;
    const currentConfig = {
      ...config,
      // Session listing and command handling must run in the same isolated
      // directory the Agent will execute in, for Codex, Pi and OpenCode alike.
      codexWorkDir: state.defaultWorkDir,
      agent: selectedAgent,
      agentModel: options.getAgentModel?.(selectedAgent) ?? (config.agentModels[selectedAgent] || undefined),
    };
    if (message.msgtype === "text" && await handleCommand(
      bot, currentConfig, conversations, message, text, isSuperAdminUser,
    )) return;
    if (state.busy) {
      // A redelivery of the message that started the running task must never
      // be treated as a new user message (steered or queued). Callbacks are
      // ACKed immediately now, but keep this guard in case an ACK is lost.
      if (state.activeFingerprint && messageFingerprint === state.activeFingerprint) {
        log.warn(`ignored duplicate of the in-flight task message conversation=${message.conversationId} text=${JSON.stringify(message.text.slice(0, 120))}`);
        return;
      }
      const steer = state.activeAgent === "pi" && state.busy && state.steer && state.steerTaskToken ? state.steer : undefined;
      if (steer && text) {
        const steered = steer(text);
        if (!steered) {
          // 引导失败时必须真的入队，否则“已排队等待处理”只是空话，消息会被丢掉。
          state.pendingMessages.push(message);
          state.pendingNoticeSent = true;
        }
        await bot.sendText(message.conversationId, steered
          ? "[灵感] 已将这条消息作为引导发送给当前 Pi 任务。"
          : "当前 Pi 任务暂时无法接收引导，消息已排队等待处理。" );
      } else if ((state.activeAgent === "codex" || state.activeAgent === "opencode") && text) {
        // Codex and OpenCode run one CLI process per turn. Collect follow-up messages and
        // replay them as one combined prompt after the current turn completes.
        state.pendingMessages.push(message);
        state.pendingNoticeSent = true;
      } else if (state.activeAgent === "pi" && text) {
        // If Pi has not exposed steer yet, collect the message for the next
        // turn without sending a second status message to the conversation.
        state.pendingMessages.push(message);
        state.pendingNoticeSent = true;
      } else {
        await bot.sendText(message.conversationId, "当前 Agent 不支持运行中引导，请等待任务结束，或先发送暂停指令。");
      }
      return;
    }

    state.busy = true;
    state.paused = false;
    state.activeAgent = selectedAgent;
    state.activeFingerprint = messageFingerprint;
    const taskToken = `${message.conversationId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    state.steerTaskToken = taskToken;
    const modelName = shortModelName(options.getAgentModel?.(selectedAgent) ?? config.agentModels[selectedAgent]);
    const label = agentLabel(selectedAgent);
    const processingLabel = `${agentLabel(selectedAgent)} ${modelName || "默认模型"}`;
    const processingMessage = `[OMG] ${processingLabel} 正在分析...`;
    const taskStartedAt = Date.now();
    const formatElapsed = () => {
      const totalSeconds = Math.max(0, Math.floor((Date.now() - taskStartedAt) / 1000));
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
    };
    const title = `【${label}】`;
    // Keep the title lightweight. Detailed phases are already shown in the
    // card body; only alternate the icon as a heartbeat to avoid duplicate text.
    let heartbeat = 0;
    const processingTitle = () => {
      const heartbeatIcon = heartbeat++ % 2 === 0 ? "🔵" : "🔷";
      const elapsed = options.getShowElapsed?.() === false ? "" : ` ${formatElapsed()}`;
      return `${heartbeatIcon} ${title}处理中...${elapsed}`;
    };
    // The setting only controls the live processing title. Completion always
    // includes the elapsed time as a useful final result summary.
    const finishedTitle = (icon: string, state: string) => `${icon} ${title}${state} 总耗时 ${formatElapsed()}`;
    const requestedMode = options.getResponseMode?.() ?? "card";
    const aiCardConfig = options.getAiCardConfig?.() ?? { templateId: "", contentKey: "content", streamIntervalMs: 500 };
    let useAiCard = requestedMode === "aiCard" && Boolean(aiCardConfig.templateId) && aiCardClient.configured;
    if (requestedMode === "aiCard" && !useAiCard) {
      log.warn(`AI card unavailable (template=${aiCardConfig.templateId ? "set" : "empty"}, credentials=${aiCardClient.configured}); using standard card`);
    }
    const responseMode: "card" | "text" = requestedMode === "text" ? "text" : "card";
    let aiCardSession: AiCardSession | undefined;
    let reply: DingTalkReplyHandle;
    if (responseMode === "card") {
      if (useAiCard) {
        try {
          aiCardClient.setCredentials(config.dingtalkClientId, config.dingtalkClientSecret, message.robotCode || config.dingtalkClientId);
          const session = new AiCardSession({
            client: aiCardClient,
            templateId: aiCardConfig.templateId,
            contentKey: aiCardConfig.contentKey,
            log,
          });
          await session.openForSingle({
            userId: message.senderStaffId || message.senderId,
            title: `【${label}】${modelName || "默认模型"} 进行中...`,
          });
          aiCardSession = session;
          reply = { conversationId: message.conversationId, mode: "card", cardBizId: session.outTrackId };
        } catch (err) {
          log.warn(`AI card create failed; falling back to standard card: ${String(err)}`);
          useAiCard = false;
          reply = await bot.sendThinkingCard(message, processingMessage, processingTitle());
        }
      } else {
        reply = await bot.sendThinkingCard(message, processingMessage, processingTitle());
      }
    } else {
      reply = { conversationId: message.conversationId, mode: "text" as const };
    }
    if (responseMode === "text") await bot.sendText(message.conversationId, processingMessage);
    let elapsedTimer: ReturnType<typeof setInterval> | undefined;
    let latestCardContent = processingMessage;
    const agent = selectedAgent;
    let prompt = "";

    try {
      let streamedText = "";
      let toolStatus = "";
      let lastUpdateAt = 0;
      let pendingUpdate: ReturnType<typeof setTimeout> | undefined;
      let cardUpdatesStopped = false;
      let cardUpdateChain = Promise.resolve();
      const getCardUpdateInterval = () => useAiCard ? Math.max(0, aiCardConfig.streamIntervalMs) : Math.max(0, options.getCardUpdateIntervalMs?.() ?? 3_000);
      const liveCardUpdates = responseMode === "card" && getCardUpdateInterval() > 0;
      const stopCardUpdates = () => {
        cardUpdatesStopped = true;
        if (pendingUpdate) clearTimeout(pendingUpdate);
        pendingUpdate = undefined;
      };
      state.stopCardUpdates = stopCardUpdates;
      stopCardUpdatesForCurrentTask = stopCardUpdates;

      const updateCard = (title: string, content: string, force = false) => {
        if (cardUpdatesStopped) return;
        if (responseMode !== "card") return;
        const cardUpdateInterval = getCardUpdateInterval();
        latestCardContent = content;
        if (reply.mode !== "card") return;
        if (cardUpdateInterval <= 0 && !force) return;
        const now = Date.now();
        const run = () => {
          if (cardUpdatesStopped) return;
          lastUpdateAt = Date.now();
          pendingUpdate = undefined;
          cardUpdateChain = cardUpdateChain.then(async () => {
            if (cardUpdatesStopped) return;
            if (aiCardSession) {
              await aiCardSession.push(content);
              return;
            }
            await bot.updateReply(reply, title, content, { fallbackToText: false });
          }).catch((err) => {
            log.warn(`card update skipped: ${err instanceof Error ? err.message : String(err)}`);
          });
        };

        if (force || now - lastUpdateAt >= cardUpdateInterval) {
          if (pendingUpdate) {
            clearTimeout(pendingUpdate);
            pendingUpdate = undefined;
          }
          run();
          return;
        }

        if (!pendingUpdate) {
          pendingUpdate = setTimeout(run, cardUpdateInterval - (now - lastUpdateAt));
          pendingUpdate.unref();
        }
      };

      if (liveCardUpdates && !useAiCard) {
        elapsedTimer = setInterval(() => {
          if (!cardUpdatesStopped) updateCard(processingTitle(), latestCardContent);
        }, 1_000);
        elapsedTimer.unref();
      }

      prompt = await buildCodexPrompt(bot, message, state.selectedSessions[agent]?.cwd ?? state.defaultWorkDir);
      const selectedSession = state.selectedSessions[agent];
      // Carry the per-conversation Agent and model selection into execution.
      // Using the startup config here can leak the default agent's model into
      // a private conversation after the user switches Agent.
      const agentConfig = { ...currentConfig, codexWorkDir: selectedSession?.cwd ?? state.defaultWorkDir };
      const result = await runAgent(agent, prompt, state.sessions[agent], agentConfig, {
        onAbortReady: (abort) => { state.abort = abort; },
        onSteerReady: (steer) => {
          if (state.busy && state.activeAgent === "pi" && state.steerTaskToken === taskToken) state.steer = steer;
        },
        onText: (content) => {
          streamedText = content;
          if (liveCardUpdates && content.trim()) {
            toolStatus = "";
            updateCard(processingTitle(), buildCardContent(content));
          }
        },
        onToolUse: (toolName, stats) => {
          const totalCalls = Object.values(stats).reduce((sum, count) => sum + (count || 0), 0);
          log.info(`tool=${toolName} total=${totalCalls}`);
          // AI 卡片在工具调用/等待期显示实时调用次数，出字后清除。
          if (!useAiCard || !liveCardUpdates) return;
          toolStatus = `[OMG] 正在调用工具（已 ${totalCalls} 次）…`;
          updateCard(processingTitle(), buildCardContent(streamedText ? `${streamedText}\n\n${toolStatus}` : toolStatus));
        },
      });
      if (elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = undefined;
      }
      if (state.paused) throw new Error("Agent task paused by user");
      if (pendingUpdate) {
        clearTimeout(pendingUpdate);
        pendingUpdate = undefined;
      }
      await cardUpdateChain;
      state.stopCardUpdates = undefined;
      stopCardUpdatesForCurrentTask = undefined;
      state.sessions[agent] = result.sessionId ?? state.sessions[agent];
      if (state.sessions[agent]) {
        privateSessionBindings.set(privateSessionKey(message.conversationId, agent, selectedSession?.cwd ?? state.defaultWorkDir), state.sessions[agent] as string);
        savePrivateSessions();
      }
      const toolCount = Object.values(result.toolStats).reduce((total, count) => total + count, 0);
      const showDetails = options.getShowProcessingDetails?.() === true;
      const note = `${modelName || "默认模型"} 1条消息,${toolCount}次工具`;
      if (responseMode === "card" && aiCardSession) {
        // AI 卡片：正文不带结束语，结束语走模板的 $end_text 变量。
        const cardContent = buildCardContent(result.text);
        const delivered = await aiCardSession.finish({
          content: cardContent,
          title: `【${label}】完成 总耗时 ${formatElapsed()}`,
          endText: showDetails ? note : undefined,
        });
        if (!delivered) {
          await bot.sendText(message.conversationId, `${normalizeDingTalkMarkdown(result.text).trim() || "(无输出)"}\n\n总耗时 ${formatElapsed()}`)
            .catch((sendErr) => log.warn(`AI card text fallback failed: ${String(sendErr)}`));
        }
      } else if (responseMode === "card") {
        // 非 AI 卡片在结束语前面加上「[夯爆了]」标记。
        await bot.updateReply(reply, finishedTitle("✅", "完成"), buildCardContent(result.text, showDetails ? `[夯爆了] ${note}` : undefined));
      } else {
        await bot.sendText(message.conversationId, normalizeDingTalkMarkdown(result.text).trim() || "(无输出)");
      }
      await appendConversationLog({
        id: `${message.conversationId}:${taskStartedAt}`,
        createdAt: new Date().toISOString(),
        conversationType: "personal",
        conversationName: message.senderNick || message.senderId,
        groupId: message.conversationId,
        groupName: message.senderNick || message.senderId,
        status: "completed",
        agent,
        question: prompt,
        senderNames: [message.senderNick || message.senderId],
        senderDetails: [{ senderName: message.senderNick || message.senderId, senderId: message.senderStaffId || message.senderId, content: prompt }],
        content: result.text,
        messageCount: 1,
      }, [{ senderName: message.senderNick || message.senderId, senderId: message.senderStaffId || message.senderId, content: prompt }]);
    } catch (err) {
      if (elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = undefined;
      }
      if (state.paused) {
        stopCardUpdatesForCurrentTask?.();
        state.stopCardUpdates = undefined;
        stopCardUpdatesForCurrentTask = undefined;
        log.info(`${label} task paused by user`);
        if (responseMode === "card" && aiCardSession) {
          await aiCardSession.finish({ content: latestCardContent, title: `【${label}】处理暂停 总耗时 ${formatElapsed()}`, error: true });
        } else if (responseMode === "card") {
          await bot.updateReply(reply, finishedTitle("🔴", "处理暂停"), latestCardContent);
        } else {
          await bot.sendText(message.conversationId, "Agent 任务已暂停。");
        }
        await appendConversationLog({
          id: `${message.conversationId}:${taskStartedAt}`,
          createdAt: new Date().toISOString(), conversationType: "personal",
          conversationName: message.senderNick || message.senderId, groupId: message.conversationId,
          groupName: message.senderNick || message.senderId, status: "failed", agent,
          question: prompt, senderNames: [message.senderNick || message.senderId],
          senderDetails: [{ senderName: message.senderNick || message.senderId, senderId: message.senderStaffId || message.senderId, content: prompt }],
          content: latestCardContent, messageCount: 1,
        }, [{ senderName: message.senderNick || message.senderId, senderId: message.senderStaffId || message.senderId, content: prompt }]);
      } else {
        stopCardUpdatesForCurrentTask?.();
        state.stopCardUpdates = undefined;
        stopCardUpdatesForCurrentTask = undefined;
        log.error(`${label} execution failed`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (responseMode === "card" && aiCardSession) {
          await aiCardSession.finish({ content: `${label} 执行失败：${errorMessage}`, title: `【${label}】处理失败 总耗时 ${formatElapsed()}`, error: true });
        } else if (responseMode === "card") {
          await bot.updateReply(reply, finishedTitle("❌", "处理失败"), `${label} 执行失败：${errorMessage}`);
        } else {
          await bot.sendText(message.conversationId, `${label} 执行失败：${errorMessage}`);
        }
        await appendConversationLog({
          id: `${message.conversationId}:${taskStartedAt}`,
          createdAt: new Date().toISOString(),
          conversationType: "personal",
          conversationName: message.senderNick || message.senderId,
          groupId: message.conversationId,
          groupName: message.senderNick || message.senderId,
          status: "failed",
          agent,
          question: prompt,
          senderNames: [message.senderNick || message.senderId],
          senderDetails: [{ senderName: message.senderNick || message.senderId, senderId: message.senderStaffId || message.senderId, content: prompt }],
          content: errorMessage,
          messageCount: 1,
        }, [{ senderName: message.senderNick || message.senderId, senderId: message.senderStaffId || message.senderId, content: prompt }]);
      }
    } finally {
      state.busy = false;
      state.abort = undefined;
      state.stopCardUpdates = undefined;
      state.steer = undefined;
      state.steerTaskToken = undefined;
      state.activeAgent = undefined;
      state.activeFingerprint = undefined;
      state.paused = false;
      const pending = state.pendingMessages.splice(0);
      state.pendingNoticeSent = false;
      if (pending.length > 0) {
        // Replay all messages received during this turn as one prompt. These
        // are text follow-ups (attachments are handled as their own turn), so
        // preserve their order and avoid starting one Agent process per line.
        const first = pending[0];
        const combined: DingTalkTextMessage = {
          ...first,
          msgtype: "text",
          text: pending.map((item) => item.text.trim()).filter(Boolean).join("\n"),
          attachments: [],
        };
        void handleMessage(combined, true).catch((error) => log.error("queued private messages failed", error));
      }
    }
  }

  process.once("SIGINT", () => {
    bot.stop();
    process.exit(0);
  });

  process.once("SIGTERM", () => {
    bot.stop();
    process.exit(0);
  });

  let stopCardUpdatesForCurrentTask: (() => void) | undefined;
  let privateChatConnected = false;
  let privateChatStarting = false;
  let privateChatGeneration = 0;
  // 只在（启用状态, 连接状态）真的变化时写一次状态文件，避免看板读到过期值。
  let lastReportedStatusKey: string | undefined;
  const reportConnectionStatus = (connected: boolean): void => {
    const enabled = options.getPrivateChatEnabled?.() ?? true;
    const key = `${enabled}|${connected}`;
    if (key === lastReportedStatusKey) return;
    lastReportedStatusKey = key;
    options.onConnectionStatus?.(connected);
  };
  const privateChatTimer = setInterval(() => {
    const enabled = options.getPrivateChatEnabled?.() ?? true;
    if (!enabled) {
      privateChatGeneration += 1;
      if (privateChatConnected || privateChatStarting) {
        privateChatConnected = false;
        privateChatStarting = false;
        bot.stop();
        reportConnectionStatus(false);
        log.info("private chat stream stopped by configuration");
      }
      return;
    }
    if (privateChatConnected || privateChatStarting) {
      // 流保持连接时，如果开关变了也要刷新状态，否则看板会一直显示未连接。
      reportConnectionStatus(privateChatConnected);
      return;
    }
    privateChatStarting = true;
    const generation = privateChatGeneration;
    log.info("private chat stream starting by configuration");
    void bot.start(handleMessage).then(() => {
      if (generation !== privateChatGeneration || options.getPrivateChatEnabled?.() === false) {
        // 启动过程中开关又变了：停掉并复位状态。不复位 privateChatStarting
        // 会让定时器以后每秒都提前 return，流永远不再重连。
        privateChatStarting = false;
        privateChatConnected = false;
        bot.stop();
        reportConnectionStatus(false);
        return;
      }
      privateChatStarting = false;
      privateChatConnected = true;
      reportConnectionStatus(true);
      log.info("private chat stream started by configuration");
    }).catch((err) => {
      privateChatStarting = false;
      privateChatConnected = false;
      reportConnectionStatus(false);
      log.error("private chat stream restart failed", err);
    });
  }, 1_000);
  // Keep the worker alive while private chat is disabled so a later dashboard
  // toggle can start the Stream connection without requiring a process restart.
  if (options.getPrivateChatEnabled?.() === false) {
    privateChatConnected = false;
    log.info("private chat stream disabled by configuration");
  } else {
    privateChatStarting = true;
    await bot.start(handleMessage);
    privateChatStarting = false;
    privateChatConnected = true;
  }
  // 启动时无论开关状态都写一次状态文件（enabled 取实时配置、connected 取实际连接），
  // 避免看板看到上一次进程遗留的旧值。
  reportConnectionStatus(privateChatConnected);
  log.info(`ready workDir=${config.codexWorkDir} codex=${config.codexCliPath}`);
}
