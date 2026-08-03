import { loadConfig, type Config } from "./config.js";
import { runCodex } from "./codex.js";
import { DingTalkBot, type DingTalkTextMessage } from "./dingtalk.js";
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

export async function runApp(): Promise<void> {
  const config = loadConfig();
  const bot = new DingTalkBot(config);
  const conversations = new Map<string, ConversationState>();

  async function handleMessage(message: DingTalkTextMessage): Promise<void> {
    if (!isAllowed(message, config.allowedUserIds)) {
      await bot.sendText(message.conversationId, `抱歉，您没有访问权限。\n您的 ID: ${message.senderStaffId ?? message.senderId}`);
      return;
    }

    if (message.msgtype !== "text") {
      await bot.sendText(message.conversationId, `暂不支持 ${message.msgtype} 消息，请发送文本。`);
      return;
    }

    const text = message.text.trim();
    if (!text) return;

    if (await handleCommand(bot, config, conversations, message, text)) return;

    const state = getState(conversations, message.conversationId);
    if (state.busy) {
      await bot.sendText(message.conversationId, "当前会话已有 Codex 任务在执行，请稍后再发。");
      return;
    }

    state.busy = true;
    await bot.sendText(message.conversationId, "Codex 正在处理...");

    try {
      const result = await runCodex(text, state.sessionId, config);
      state.sessionId = result.sessionId ?? state.sessionId;
      const stats = formatStats(result.toolStats);
      const note = [`耗时 ${(result.durationMs / 1000).toFixed(1)}s`, stats].filter(Boolean).join(" | ");
      await bot.sendText(message.conversationId, `${result.text}\n\n${note}`);
    } catch (err) {
      log.error("Codex execution failed", err);
      await bot.sendText(message.conversationId, `Codex 执行失败：${err instanceof Error ? err.message : String(err)}`);
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
