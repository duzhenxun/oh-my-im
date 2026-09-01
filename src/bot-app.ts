import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { agentLabel, agentSwitchMessage, listAgentSessions, runAgent, type AgentSessionInfo } from "./agents/index.js";
import { DingTalkBot, isSingleConversation, type DingTalkTextMessage, type DownloadedAttachment } from "./dingtalk.js";
import { createLogger } from "./logger.js";
import type { CommandKeywordsConfig } from "./dws-dashboard.js";
import { parseAgentControlCommand } from "./monitor-command.js";
import { appendConversationLog } from "./conversation-log.js";

interface SelectedSession {
  id: string;
  cwd: string;
}

interface SessionDirectory {
  cwd: string;
  piCount: number;
  codexCount: number;
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
  steer?: (message: string) => boolean;
  pendingMessages: DingTalkTextMessage[];
  pendingNoticeSent: boolean;
  activeAgent?: Config["agent"]; 
  paused?: boolean;
}

const log = createLogger("Main");

function safePathPart(value: string): string {
  return value.trim().replace(/[^\w.-]+/g, "_").slice(0, 120) || "unknown";
}

function privateUserWorkDir(message: DingTalkTextMessage): string {
  const userId = message.senderStaffId?.trim() || message.senderId.trim();
  const dir = join(homedir(), ".oh-my-im", "users", safePathPart(userId), "workspace");
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
  if (existing) return existing;
  const created: ConversationState = {
    defaultWorkDir,
    sessions: {}, selectedSessions: {}, visibleSessionLists: {}, pendingMessages: [], pendingNoticeSent: false, busy: false,
  };
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

function buildAdminDirectories(piSessions: AgentSessionInfo[], codexSessions: AgentSessionInfo[]): SessionDirectory[] {
  const directories = new Map<string, SessionDirectory>();
  const append = (agent: Config["agent"], session: AgentSessionInfo) => {
    if (!session.cwd) return;
    const current = directories.get(session.cwd) ?? { cwd: session.cwd, piCount: 0, codexCount: 0 };
    if (agent === "pi") current.piCount += 1;
    else current.codexCount += 1;
    const timestamp = session.updatedAt ?? session.createdAt;
    if ((timestamp ?? "") > (current.updatedAt ?? "")) current.updatedAt = timestamp;
    directories.set(session.cwd, current);
  };
  piSessions.forEach((session) => append("pi", session));
  codexSessions.forEach((session) => append("codex", session));
  return [...directories.values()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

function formatAdminDirectories(directories: SessionDirectory[]): string {
  if (directories.length === 0) return "本机没有找到 Agent Session 工作目录。";
  return [
    `超级管理员 Session 目录（共 ${directories.length} 个）：`,
    ...directories.slice(0, 30).map((directory, index) => [
      `${index + 1}. ${directory.cwd}`,
      `   Pi: ${directory.piCount} · Codex: ${directory.codexCount} · 最近: ${formatSessionTime(directory.updatedAt)}`,
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

function formatStats(stats: Record<string, number>): string {
  const entries = Object.entries(stats);
  if (entries.length === 0) return "";
  return entries.map(([name, count]) => `${name} x${count}`).join(", ");
}

function buildCardContent(content: string, note?: string): string {
  const safeContent = content.trim() || "Codex 正在处理...";
  const safeNote = note?.trim();
  return safeNote ? `${safeContent}\n\n---\n${safeNote}` : safeContent;
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
      "/sessions [pi|codex] - 默认查看当前 Agent 的 sessions，也可指定 Agent",
      "/use <pi|codex> <编号或sessionId> - 切换当前私有目录下的 session",
      "/current - 查看当前 Agent session 和工作路径",
      "/new - 清空当前会话的 Codex/Pi session",
      ...(isSuperAdmin ? [
        "/admin-sessions - 查看本机全部 Session 目录",
        "/admin-cd <目录编号> - 选择管理员工作目录",
        "/admin-sessions <pi|codex> - 查看所选目录的 sessions",
        "/admin-use <pi|codex> <编号或sessionId> - 切换管理员 session",
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
    const agents: Config["agent"][] = requested === "pi" || requested === "codex"
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
    if ((agent !== "pi" && agent !== "codex") || !selector) {
      await bot.sendText(message.conversationId, "用法：/use <pi|codex> <编号或sessionId>");
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
    if (requested !== "pi" && requested !== "codex") {
      const [piSessions, codexSessions] = await Promise.all([
        listAgentSessions("pi", config), listAgentSessions("codex", config),
      ]);
      state.adminDirectories = buildAdminDirectories(piSessions, codexSessions);
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
      "查看：/admin-sessions pi 或 /admin-sessions codex",
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
    if ((agent !== "pi" && agent !== "codex") || !selector || !state.adminWorkDir) {
      await bot.sendText(message.conversationId, "用法：先 /admin-cd <目录编号>，再 /admin-use <pi|codex> <编号或sessionId>");
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
    state.sessions = {};
    state.selectedSessions = {};
    state.visibleSessionLists = {};
    state.selectedAgent = undefined;
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
    getAllowedUserIds?: () => string[];
    getCommandKeywords?: () => CommandKeywordsConfig | undefined;
    getSuperAdminUserIds?: () => string[];
  } = {},
): Promise<void> {
  const config = configOverride ?? loadConfig();
  const bot = new DingTalkBot(config);
  const conversations = new Map<string, ConversationState>();

  async function handleMessage(message: DingTalkTextMessage): Promise<void> {
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
        return;
      }
      if (control && typeof control === "object") {
        const state = getState(conversations, message.conversationId, privateUserWorkDir(message));
        state.selectedAgent = control.agent;
        await bot.sendText(message.conversationId, agentSwitchMessage(control.agent));
        return;
      }
    }

    if (message.msgtype === "text" && text.startsWith("/")) {
      log.info(`command=${text} conversation=${message.conversationId}`);
    }

    const state = getState(conversations, message.conversationId, privateUserWorkDir(message));
    const selectedAgent = state.selectedAgent ?? options.getAgent?.() ?? config.agent;
    const currentConfig = selectedAgent === config.agent ? config : { ...config, agent: selectedAgent };
    if (message.msgtype === "text" && await handleCommand(
      bot, currentConfig, conversations, message, text, isSuperAdminUser,
    )) return;
    if (state.busy) {
      if (state.activeAgent === "pi" && state.steer && text) {
        const steered = state.steer(text);
        await bot.sendText(message.conversationId, steered
          ? "已将这条消息作为引导发送给当前 Pi 任务。"
          : "当前 Pi 任务暂时无法接收引导，消息已排队等待处理。" );
      } else if (state.activeAgent === "codex" && text) {
        // Codex runs one exec process per turn. Collect follow-up messages and
        // replay them as one combined prompt after the current turn completes.
        state.pendingMessages.push(message);
        if (!state.pendingNoticeSent) {
          state.pendingNoticeSent = true;
          await bot.sendText(message.conversationId, "已收到后续消息，当前任务完成后会合并处理。");
        }
      } else if (state.activeAgent === "pi" && text) {
        // If Pi has not exposed steer yet, collect the message for the next
        // turn. The successful-steer path above still acknowledges once.
        state.pendingMessages.push(message);
        if (!state.pendingNoticeSent) {
          state.pendingNoticeSent = true;
          await bot.sendText(message.conversationId, "已收到后续消息，当前任务完成后会合并处理。");
        }
      } else {
        await bot.sendText(message.conversationId, "当前 Agent 不支持运行中引导，请等待任务结束，或先发送暂停指令。");
      }
      return;
    }

    state.busy = true;
    state.paused = false;
    state.activeAgent = selectedAgent;
    const label = `${agentLabel(selectedAgent)} Agent`;
    const taskStartedAt = Date.now();
    const formatElapsed = () => {
      const totalSeconds = Math.max(0, Math.floor((Date.now() - taskStartedAt) / 1000));
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
    };
    const title = `【${label}】`;
    const processingTitle = () => `🔵 ${title}处理中... (${formatElapsed()})`;
    const reply = await bot.sendThinkingCard(message, `${label} 正在处理...`, processingTitle());
    let elapsedTimer: ReturnType<typeof setInterval> | undefined;
    let latestCardContent = `${label} 正在处理...`;
    const agent = selectedAgent;
    let prompt = "";

    try {
      let latestStats: Record<string, number> = {};
      let lastUpdateAt = 0;
      const cardUpdateInterval = selectedAgent === "pi" ? 1_000 : 500;
      let pendingUpdate: ReturnType<typeof setTimeout> | undefined;

      const updateCard = (title: string, content: string, force = false) => {
        latestCardContent = content;
        if (reply.mode !== "card") return;
        const now = Date.now();
        const run = () => {
          lastUpdateAt = Date.now();
          pendingUpdate = undefined;
          bot.updateReply(reply, title, content, { fallbackToText: false }).catch((err) => {
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

      elapsedTimer = setInterval(() => {
        updateCard(processingTitle(), latestCardContent);
      }, 1_000);
      elapsedTimer.unref();

      prompt = await buildCodexPrompt(bot, message, state.selectedSessions[agent]?.cwd ?? state.defaultWorkDir);
      const selectedSession = state.selectedSessions[agent];
      const agentConfig = { ...config, codexWorkDir: selectedSession?.cwd ?? state.defaultWorkDir };
      const result = await runAgent(agent, prompt, state.sessions[agent], agentConfig, {
        onAbortReady: (abort) => { state.abort = abort; },
        onSteerReady: (steer) => { state.steer = steer; },
        onText: (content) => {
          const stats = formatStats(latestStats);
          updateCard(processingTitle(), buildCardContent(content, stats ? `工具：${stats}` : undefined));
        },
        onToolUse: (_toolName, stats) => {
          latestStats = stats;
          const statsText = formatStats(stats);
          updateCard(processingTitle(), buildCardContent(`${label} 正在处理...`, statsText ? `工具：${statsText}` : undefined));
        },
      });
      if (elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = undefined;
      }
      if (state.paused) throw new Error("Agent task paused by user");
      if (pendingUpdate) {
        clearTimeout(pendingUpdate);
      }
      state.sessions[agent] = result.sessionId ?? state.sessions[agent];
      const toolCount = Object.values(result.toolStats).reduce((total, count) => total + count, 0);
      const note = `处理详情 · 1 条消息 · ${toolCount} 次工具调用`;
      await bot.updateReply(reply, `✅ ${title}完成 总耗时 ${formatElapsed()}`, buildCardContent(result.text, note));
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
        log.info(`${label} task paused by user`);
        await bot.updateReply(reply, `🔴 ${title}处理暂停 总耗时 ${formatElapsed()}`, latestCardContent);
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
        log.error(`${label} execution failed`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        await bot.updateReply(reply, `❌ ${title}处理失败 总耗时 ${formatElapsed()}`, `${label} 执行失败：${errorMessage}`);
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
      state.steer = undefined;
      state.activeAgent = undefined;
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
        void handleMessage(combined).catch((error) => log.error("queued private messages failed", error));
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

  await bot.start(handleMessage);
  log.info(`ready workDir=${config.codexWorkDir} codex=${config.codexCliPath}`);
}
