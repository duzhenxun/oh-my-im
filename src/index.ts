import { loadConfig, type Config } from "./config.js";
import { runCodex } from "./codex.js";
import { DingTalkBot, isSingleConversation, type DingTalkTextMessage, type DownloadedAttachment } from "./dingtalk.js";
import { createLogger } from "./logger.js";

interface ConversationState {
  sessionId?: string;
  busy: boolean;
}

const log = createLogger("Main");

function getState(conversations: Map<string, ConversationState>, conversationId: string): ConversationState {
  const existing = conversations.get(conversationId);
  if (existing) return existing;
  const created: ConversationState = { busy: false };
  conversations.set(conversationId, created);
  return created;
}

function isAllowed(message: DingTalkTextMessage, allowedUserIds: string[]): boolean {
  if (allowedUserIds.length === 0) return true;
  return allowedUserIds.includes(message.senderStaffId ?? message.senderId);
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
      "/new - 清空当前会话的 Codex session",
    ].join("\n"));
    return true;
  }

  if (text === "/status") {
    await bot.sendText(message.conversationId, [
      "oh-my-im status:",
      `Codex: ${config.codexCliPath}`,
      `WorkDir: ${config.codexWorkDir}`,
      `Current session: ${state.sessionId ?? "new"}`,
      `Known conversations: ${conversations.size}`,
    ].join("\n"));
    return true;
  }

  if (text === "/new") {
    state.sessionId = undefined;
    await bot.sendText(message.conversationId, "已清空当前会话的 Codex session。");
    return true;
  }

  return false;
}

export async function runApp(configOverride?: Config, options: { singleChatOnly?: boolean } = {}): Promise<void> {
  const config = configOverride ?? loadConfig();
  const bot = new DingTalkBot(config);
  const conversations = new Map<string, ConversationState>();

  async function handleMessage(message: DingTalkTextMessage): Promise<void> {
    log.info(
      `handle message conversation=${message.conversationId} msgtype=${message.msgtype} sender=${message.senderStaffId ?? message.senderId} textLen=${message.text.length}`,
    );
    if (options.singleChatOnly && !isSingleConversation(message.conversationType)) {
      log.debug(`ignored non-single conversation=${message.conversationId} type=${message.conversationType ?? "unknown"}`);
      return;
    }
    if (!isAllowed(message, config.allowedUserIds)) {
      await bot.sendText(message.conversationId, `抱歉，您没有访问权限。\n您的 ID: ${message.senderStaffId ?? message.senderId}`);
      return;
    }

    const text = message.text.trim();
    if (!text && message.attachments.length === 0 && message.msgtype !== "richText") return;

    if (message.msgtype === "text" && text.startsWith("/")) {
      log.info(`command=${text} conversation=${message.conversationId}`);
    }

    if (message.msgtype === "text" && await handleCommand(bot, config, conversations, message, text)) return;

    const state = getState(conversations, message.conversationId);
    if (state.busy) {
      await bot.sendText(message.conversationId, "当前会话已有 Codex 任务在执行，请稍后再发。");
      return;
    }

    state.busy = true;
    const reply = await bot.sendThinkingCard(message, "Codex 正在处理...");

    try {
      let latestStats: Record<string, number> = {};
      let lastUpdateAt = 0;
      let pendingUpdate: ReturnType<typeof setTimeout> | undefined;

      const updateCard = (title: string, content: string, force = false) => {
        if (reply.mode !== "card") return;
        const now = Date.now();
        const run = () => {
          lastUpdateAt = Date.now();
          pendingUpdate = undefined;
          bot.updateReply(reply, title, content, { fallbackToText: false }).catch((err) => {
            log.warn(`card update skipped: ${err instanceof Error ? err.message : String(err)}`);
          });
        };

        if (force || now - lastUpdateAt >= 1200) {
          if (pendingUpdate) {
            clearTimeout(pendingUpdate);
            pendingUpdate = undefined;
          }
          run();
          return;
        }

        if (!pendingUpdate) {
          pendingUpdate = setTimeout(run, 1200 - (now - lastUpdateAt));
          pendingUpdate.unref();
        }
      };

      const prompt = await buildCodexPrompt(bot, message);
      const result = await runCodex(prompt, state.sessionId, config, {
        onText: (content) => {
          const stats = formatStats(latestStats);
          updateCard("Codex - 执行中", buildCardContent(content, stats ? `工具：${stats}` : undefined));
        },
        onToolUse: (_toolName, stats) => {
          latestStats = stats;
          const statsText = formatStats(stats);
          updateCard("Codex - 执行中", buildCardContent("Codex 正在处理...", statsText ? `工具：${statsText}` : undefined));
        },
      });
      if (pendingUpdate) {
        clearTimeout(pendingUpdate);
      }
      state.sessionId = result.sessionId ?? state.sessionId;
      const stats = formatStats(result.toolStats);
      const note = [`耗时 ${(result.durationMs / 1000).toFixed(1)}s`, stats].filter(Boolean).join(" | ");
      await bot.updateReply(reply, "Codex - 完成", buildCardContent(result.text, note));
    } catch (err) {
      log.error("Codex execution failed", err);
      await bot.updateReply(reply, "Codex - 失败", `Codex 执行失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      state.busy = false;
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
