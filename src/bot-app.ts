import { loadConfig, type Config } from "./config.js";
import { agentLabel, agentSwitchMessage, runAgent } from "./agents/index.js";
import { DingTalkBot, isSingleConversation, type DingTalkTextMessage, type DownloadedAttachment } from "./dingtalk.js";
import { createLogger } from "./logger.js";
import type { CommandKeywordsConfig } from "./dws-dashboard.js";
import { parseAgentControlCommand } from "./monitor-command.js";
import { appendConversationLog } from "./conversation-log.js";

interface ConversationState {
  sessions: Partial<Record<Config["agent"], string>>;
  busy: boolean;
  abort?: () => void;
  steer?: (message: string) => boolean;
  activeAgent?: Config["agent"]; 
  paused?: boolean;
}

const log = createLogger("Main");

function getState(conversations: Map<string, ConversationState>, conversationId: string): ConversationState {
  const existing = conversations.get(conversationId);
  if (existing) return existing;
  const created: ConversationState = { sessions: {}, busy: false };
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

async function buildCodexPrompt(bot: DingTalkBot, message: DingTalkTextMessage): Promise<string> {
  if (message.msgtype === "text") return message.text.trim();

  const downloaded = await bot.downloadAttachments(message);
  const attachmentText = downloaded.map(describeAttachment).join("\n\n");
  const recognizedText = message.attachments
    .map((item) => item.recognition)
    .filter((item): item is string => Boolean(item))
    .join("\n");
  const text = [message.text, recognizedText].filter(Boolean).join("\n").trim();

  if (message.msgtype === "audio" || message.msgtype === "voice") {
    if (text) {
      return [
        "用户发送了一段语音，钉钉识别文本如下：",
        text,
        attachmentText ? `\n语音文件信息：\n${attachmentText}` : "",
        "\n请根据语音识别文本回复用户。如果需要，也可以参考本地语音文件路径。",
      ].filter(Boolean).join("\n");
    }
    return [
      "用户发送了一段语音，但钉钉消息里没有提供语音识别文本。",
      attachmentText ? `语音文件已下载：\n${attachmentText}` : "语音文件未能下载。",
      "请尝试根据本地文件分析；如果当前环境不支持音频识别，请明确告诉用户需要文字或可识别语音。",
    ].join("\n\n");
  }

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
): Promise<boolean> {
  const state = getState(conversations, message.conversationId);

  if (text === "/help") {
    await bot.sendText(message.conversationId, [
      "oh-my-im commands:",
      "/help - 查看帮助",
      "/status - 查看运行状态",
      "/new - 清空当前会话的 Codex/Pi session",
    ].join("\n"));
    return true;
  }

  if (text === "/status") {
    await bot.sendText(message.conversationId, [
      "oh-my-im status:",
      `Agent: ${agentLabel(config.agent)}`,
      `Codex CLI: ${config.codexCliPath}`,
      `Pi CLI: ${config.piCliPath ?? "pi"}`,
      `WorkDir: ${config.codexWorkDir}`,
      `Current session: ${state.sessions[config.agent] ?? "new"}`,
      `Known conversations: ${conversations.size}`,
    ].join("\n"));
    return true;
  }

  if (text === "/new") {
    state.sessions = {};
    await bot.sendText(message.conversationId, "已清空当前会话的 Agent session。");
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
    setAgent?: (agent: Config["agent"]) => Promise<void>;
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

    if (message.msgtype === "text" || message.msgtype === "richText") {
      const keywords = options.getCommandKeywords?.();
      const control = keywords ? parseAgentControlCommand(text, keywords) : undefined;
      if (control === "pause") {
        const state = getState(conversations, message.conversationId);
        if (!state.busy || !state.abort) {
          await bot.sendText(message.conversationId, "当前没有正在处理的 Agent 任务。");
          return;
        }
        state.paused = true;
        state.abort();
        return;
      }
      if (control && typeof control === "object") {
        await options.setAgent?.(control.agent);
        await bot.sendText(message.conversationId, agentSwitchMessage(control.agent));
        return;
      }
    }

    if (message.msgtype === "text" && text.startsWith("/")) {
      log.info(`command=${text} conversation=${message.conversationId}`);
    }

    const selectedAgent = options.getAgent?.() ?? config.agent;
    const currentConfig = selectedAgent === config.agent ? config : { ...config, agent: selectedAgent };
    if (message.msgtype === "text" && await handleCommand(bot, currentConfig, conversations, message, text)) return;

    const state = getState(conversations, message.conversationId);
    if (state.busy) {
      if (state.activeAgent === "pi" && state.steer && text) {
        const steered = state.steer(text);
        await bot.sendText(message.conversationId, steered
          ? "已将这条消息作为引导发送给当前 Pi 任务。"
          : "当前 Pi 任务暂时无法接收引导，消息已排队等待处理。" );
      } else {
        await bot.sendText(message.conversationId, "当前 Agent 不支持运行中引导，请等待任务结束，或先发送暂停指令。");
      }
      return;
    }

    state.busy = true;
    state.paused = false;
    state.activeAgent = selectedAgent;
    const label = agentLabel(selectedAgent);
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

      prompt = await buildCodexPrompt(bot, message);
      const result = await runAgent(agent, prompt, state.sessions[agent], config, {
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
      const stats = formatStats(result.toolStats);
      const note = [`Agent ${label}`, `耗时 ${(result.durationMs / 1000).toFixed(1)}s`, stats].filter(Boolean).join(" | ");
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
