import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { BotMatch, GroupMatch, GroupMember, UserMatch } from "../dws-dashboard.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("dws_client");

export interface DwsMessageEvent {
  [key: string]: unknown;
  event_id?: string;
  conversation_id?: string;
  conversationId?: string;
  openConversationId?: string;
  conversation_title?: string;
  conversation_name?: string;
  conversationTitle?: string;
  conversationName?: string;
  content?: string;
  text?: string;
  sender?: Record<string, unknown>;
  sender_open_dingtalk_id?: string;
  senderOpenDingTalkId?: string;
  sender_user_id?: string;
  create_time?: string;
  message_id?: string;
  messageId?: string;
  openMessageId?: string;
}

interface DwsMessageListResponse {
  messages?: Array<{
    conversationId?: string; openConversationId?: string; createTime?: string; messageId?: string; openMessageId?: string; sender?: string;
    senderId?: string; senderOpenDingTalkId?: string; text?: string; content?: string;
    atUsers?: unknown; atUserIds?: unknown; atOpenDingTalkIds?: unknown;
    at_users?: unknown; at_user_ids?: unknown; at_open_dingtalk_ids?: unknown;
    mentions?: unknown;
  }>;
  result?: { messages?: DwsMessageListResponse["messages"] };
  data?: { messages?: DwsMessageListResponse["messages"]; result?: { messages?: DwsMessageListResponse["messages"] } };
}
interface DwsChatSearchResponse { chats?: Array<{ openConversationId?: string; name?: string; title?: string; memberCount?: number }>; }
interface DwsConversationListResponse { conversations?: Array<{ openConversationId?: string; conversationName?: string }>; }
interface DwsSelfResponse { userId?: string; openDingTalkId?: string; openDingtalkId?: string; name?: string; email?: string; dept?: string; org?: string; }
interface DwsAuthStatusResponse { authenticated?: boolean; token_valid?: boolean; refresh_token_valid?: boolean; expires_at?: string; refresh_expires_at?: string; corp_id?: string; corp_name?: string; user_id?: string; user_name?: string; error?: string; message?: string; }
interface DwsMessageSendResult { failedCount?: number; success?: boolean; }
interface DwsBotSearchResponse {
  bots?: Array<{ openDingTalkId?: string; botOpenDingTalkId?: string; name?: string }>;
  result?: { bots?: Array<{ openDingTalkId?: string; botOpenDingTalkId?: string; name?: string }> };
}
interface DwsUserSearchResponse {
  users?: Array<{ openDingtalkId?: string; openDingTalkId?: string; userId?: string; name?: string; nick?: string; department?: string }>;
  items?: Array<{ openDingtalkId?: string; openDingTalkId?: string; userId?: string; name?: string; nick?: string; department?: string }>;
  data?: {
    users?: DwsUserSearchResponse["users"];
    items?: DwsUserSearchResponse["items"];
    result?: { users?: DwsUserSearchResponse["users"]; items?: DwsUserSearchResponse["items"] };
  };
}
interface DwsGroupMembersResponse {
  complete?: boolean; partial?: boolean;
  users?: Array<{ openDingtalkId?: string; name?: string; nick?: string; role?: string }>;
}
interface DwsGroupBotsResponse {
  bots?: Array<{ openBotId?: string; name?: string }>;
}
interface DwsGroupBotMembersResponse {
  complete?: boolean; partial?: boolean;
  bots?: Array<{ openDingtalkId?: string; openDingTalkId?: string; name?: string; openBotId?: string; robotCode?: string }>;
}
interface DwsOperationResponse { success?: boolean; ok?: boolean; error?: unknown; }

export const dwsPath = process.env.DWS_CLI_PATH?.trim() || "dws";

export function runDwsJson<T>(args: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(dwsPath, [...args, "--format", "json"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `dws command exited with code ${code}`));
      try { resolve(JSON.parse(stdout) as T); }
      catch (err) { reject(new Error(`Unable to parse dws command output: ${String(err)}`)); }
    });
  });
}

type DwsMessageListItem = NonNullable<DwsMessageListResponse["messages"]>[number];

// dws >= v1.0.64 intermittently answers "+search-msg" with this api error
// instead of an (often empty) collection. Measured on v1.0.64 it hits roughly a
// third of all calls for the same query, with or without --start/--no-enrich, so
// every attempt has to be retried and never trusted on its own.
const UNDECIDABLE_COLLECTION_ERROR = "缺少明确的集合字段";

/** Raised when dws keeps failing to describe the result of a message search. */
export class DwsTransientSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DwsTransientSearchError";
  }
}

function isUndecidableCollectionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(UNDECIDABLE_COLLECTION_ERROR);
}

// Once the precise window had to be abandoned, prefer the day-wide scan for a
// while: an empty precise window is what dws fails to describe most often, and
// both forms return the same messages after the local window filter.
const WINDOW_SCAN_HOLD_MS = 30 * 60_000;
let windowScanPreferredAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function runWithUndecidableRetry<T>(attempts: number, run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (!isUndecidableCollectionError(err)) throw err;
      lastError = err;
      if (attempt < attempts) await sleep(100 * attempt);
    }
  }
  throw lastError;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** dws may print log lines around its JSON error envelope. */
function parseErrorEnvelope(err: unknown): JsonRecord | undefined {
  const text = err instanceof Error ? err.message : String(err);
  for (let index = text.indexOf("{"); index >= 0; index = text.indexOf("{", index + 1)) {
    try {
      const parsed: unknown = JSON.parse(text.slice(index));
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not the envelope start; keep scanning.
    }
  }
  return undefined;
}

const PARTIAL_RESULT_PATHS: string[][] = [
  ["error", "details", "partialResult", "messages"],
  ["details", "partialResult", "messages"],
  ["error", "partialResult", "messages"],
  ["partialResult", "messages"],
];

/**
 * dws answers an incomplete search with `reason: search_messages_incomplete`,
 * `retryable: true` and a `details.partialResult` that already holds the hits,
 * plus `failures[]` naming the stage that broke (usually message-enrichment).
 * The contract is to keep the partial hits and only redo the failed stage, so
 * the page is used as-is: this pipeline needs no enrichment.
 */
function partialResultMessages(err: unknown): DwsMessageListItem[] | undefined {
  const envelope = parseErrorEnvelope(err);
  if (!envelope) return undefined;
  for (const path of PARTIAL_RESULT_PATHS) {
    let node: unknown = envelope;
    for (const key of path) {
      node = isRecord(node) ? node[key] : undefined;
    }
    if (Array.isArray(node) && node.length) return node as DwsMessageListItem[];
  }
  return undefined;
}

/** Stage names from `details.failures[]`, for logging what dws could not finish. */
function failedStages(err: unknown): string {
  const envelope = parseErrorEnvelope(err);
  const details = isRecord(envelope?.error) ? envelope.error.details : envelope?.details;
  const failures = isRecord(details) ? details.failures : undefined;
  if (!Array.isArray(failures)) return "";
  const stages = failures
    .map((item) => (isRecord(item) ? item.stage : undefined))
    .filter((stage): stage is string => typeof stage === "string" && Boolean(stage));
  return [...new Set(stages)].join(",");
}

function listMessages(result: DwsMessageListResponse & { data?: DwsMessageListResponse }): DwsMessageListItem[] {
  return result.messages ?? result.result?.messages ?? result.data?.messages ?? result.data?.result?.messages ?? [];
}

/** dws formats message timestamps as local "YYYY-MM-DD HH:mm:ss" without an offset. */
function localTimeMs(value?: string): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toDwsMessageEvent(message: DwsMessageListItem): DwsMessageEvent {
  return {
    conversation_id: message.conversationId || message.openConversationId,
    create_time: message.createTime,
    message_id: message.messageId || message.openMessageId,
    sender_open_dingtalk_id: message.senderOpenDingTalkId || message.senderId,
    sender: message.sender ? { name: message.sender } : undefined,
    content: message.text || message.content,
    atUsers: message.atUsers, atUserIds: message.atUserIds, atOpenDingTalkIds: message.atOpenDingTalkIds,
    at_users: message.at_users, at_user_ids: message.at_user_ids, at_open_dingtalk_ids: message.at_open_dingtalk_ids,
    mentions: message.mentions,
  };
}

export async function searchRecentGroupMessages(sender: string, minutes = 10, limit = 20, range?: { start?: Date; end?: Date }): Promise<DwsMessageEvent[]> {
  const end = range?.end ?? new Date();
  const start = range?.start ?? new Date(end.getTime() - minutes * 60_000);
  // --no-enrich keeps reaction/thread detail lookups out of the call: the poll
  // only needs sender, text, time and ids, and enrichment is what makes dws
  // abort a whole page with "business error: success=false".
  const query = async (args: string[]): Promise<DwsMessageListResponse & { data?: DwsMessageListResponse }> => {
    try {
      return await runDwsJson<DwsMessageListResponse & { data?: DwsMessageListResponse }>([
        "chat", "+search-msg", "--sender", sender, "--chat-type", "group", "--no-enrich", ...args,
      ]);
    } catch (err) {
      const salvaged = partialResultMessages(err);
      if (!salvaged) throw err;
      const stages = failedStages(err);
      log.debug(`+search-msg returned a partial page (${salvaged.length} messages)`
        + (stages ? `; failed stage=${stages}` : "") + "; keeping the hits, no retry");
      return { messages: salvaged };
    }
  };
  const preferWindowScan = Date.now() - windowScanPreferredAt < WINDOW_SCAN_HOLD_MS;
  if (!preferWindowScan) {
    try {
      const result = await runWithUndecidableRetry(2, () => query([
        "--start", start.toISOString(), "--end", end.toISOString(),
        "--order", "desc", "--limit", String(limit),
      ]));
      return listMessages(result).map(toDwsMessageEvent);
    } catch (err) {
      if (!isUndecidableCollectionError(err)) throw err;
    }
  }
  // The precise window stayed undecidable: scan whole days up to `end` instead
  // and keep only messages inside [start, end] locally. This also covers dws
  // reporting an *empty* precise window as undecidable. Messages without a
  // parseable timestamp are dropped rather than replayed as fresh events.
  const days = Math.min(3650, Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86_400_000)));
  const windowLimit = Math.min(100, Math.max(limit, limit * 5));
  try {
    const result = await runWithUndecidableRetry(4, () => query([
      "--days", String(days), "--end", end.toISOString(),
      "--order", "desc", "--limit", String(windowLimit),
    ]));
    windowScanPreferredAt = Date.now();
    log.debug(`+search-msg fell back to a ${days}d window for ${start.toISOString()}..${end.toISOString()}`);
    return listMessages(result)
      .filter((message) => {
        const at = localTimeMs(message.createTime);
        return at !== undefined && at >= start.getTime() && at <= end.getTime() + 1_000;
      })
      .map(toDwsMessageEvent);
  } catch (err) {
    if (!isUndecidableCollectionError(err)) throw err;
    throw new DwsTransientSearchError(
      `dws +search-msg kept answering "${UNDECIDABLE_COLLECTION_ERROR}" for ${start.toISOString()}..${end.toISOString()}`,
    );
  }
}

/* Kept only for callers outside the history pipeline; normal operation uses +search-msg. */
export async function listGroupMessages(groupId: string, from: Date, limit = 20, sender?: string): Promise<DwsMessageEvent[]> {
  const args = [
    "chat", "+chat-messages", "--group", groupId, "--time", from.toISOString(),
    "--direction", "newer", "--limit", String(limit),
  ];
  // Let DWS filter by sender when the current account is known. The caller
  // still performs an exact local name check because sender identity fields in
  // historical responses are not fully consistent.
  if (sender?.trim()) args.push("--sender", sender.trim());
  const result = await runDwsJson<DwsMessageListResponse>(args);
  const messages = result.messages ?? result.result?.messages ?? result.data?.messages ?? result.data?.result?.messages ?? [];
  return messages.map((message) => ({
    conversation_id: message.conversationId || message.openConversationId,
    create_time: message.createTime,
    message_id: message.messageId || message.openMessageId,
    sender_open_dingtalk_id: message.senderOpenDingTalkId || message.senderId,
    sender: message.sender ? { name: message.sender } : undefined,
    content: message.text || message.content,
    atUsers: message.atUsers, atUserIds: message.atUserIds, atOpenDingTalkIds: message.atOpenDingTalkIds,
    at_users: message.at_users, at_user_ids: message.at_user_ids, at_open_dingtalk_ids: message.at_open_dingtalk_ids,
    mentions: message.mentions,
  }));
}

export async function getCurrentDwsUser(): Promise<{ userId?: string; openDingTalkId?: string; name?: string; email?: string; dept?: string; org?: string }> {
  const result = await runDwsJson<DwsSelfResponse & { data?: DwsSelfResponse }>(["contact", "+me"]);
  const user = result.data ?? result;
  return { userId: user.userId?.trim(), openDingTalkId: (user.openDingTalkId || user.openDingtalkId)?.trim(), name: user.name?.trim(), email: user.email?.trim(), dept: user.dept?.trim(), org: user.org?.trim() };
}

export async function getDwsAuthStatus(): Promise<Record<string, unknown>> {
  const result = await runDwsJson<DwsAuthStatusResponse>(["auth", "status"]);
  return result as Record<string, unknown>;
}

let deviceLoginProcess: ReturnType<typeof spawn> | undefined;
let deviceLoginOutput = "";

export function startDwsDeviceLogin(): { started: boolean; message: string } {
  if (deviceLoginProcess && deviceLoginProcess.exitCode === null) return { started: false, message: deviceLoginOutput || "DWS Device Flow 登录正在进行中，请查看终端输出。" };
  deviceLoginOutput = "正在启动 DWS Device Flow 登录，请稍候...";
  deviceLoginProcess = spawn(dwsPath, ["auth", "login", "--device"], { stdio: ["ignore", "pipe", "pipe"] });
  const append = (chunk: Buffer) => { deviceLoginOutput = `${deviceLoginOutput}\n${chunk.toString().trim()}`.trim().slice(-8_000); };
  deviceLoginProcess.stdout?.on("data", append);
  deviceLoginProcess.stderr?.on("data", append);
  deviceLoginProcess.on("close", (code) => { deviceLoginOutput += `\n登录进程结束（退出码 ${code ?? 0}）。`; });
  deviceLoginProcess.on("error", (err) => { deviceLoginOutput += `\n登录进程启动失败：${err.message}`; });
  return { started: true, message: deviceLoginOutput };
}

export async function getDwsDeviceLoginOutput(): Promise<{ running: boolean; output: string }> {
  return { running: Boolean(deviceLoginProcess && deviceLoginProcess.exitCode === null), output: deviceLoginOutput };
}

export async function logoutDws(): Promise<void> {
  await runDwsJson<Record<string, unknown>>(["auth", "logout"]);
}

export async function searchMonitorCommands(senderId: string, from: Date): Promise<DwsMessageEvent[]> {
  const result = await runDwsJson<DwsMessageListResponse>([
    "chat", "+search-msg", "--senders", senderId, "--start", from.toISOString(),
    "--end", new Date().toISOString(), "--order", "asc", "--limit", "50",
  ]);
  return ((result.messages ?? result.result?.messages) ?? []).map((message) => ({
    conversation_id: message.conversationId || message.openConversationId, create_time: message.createTime, message_id: message.messageId || message.openMessageId,
    sender_open_dingtalk_id: message.senderOpenDingTalkId || message.senderId,
    sender: message.sender ? { name: message.sender } : undefined,
    content: message.text || message.content,
    atUsers: message.atUsers, atUserIds: message.atUserIds, atOpenDingTalkIds: message.atOpenDingTalkIds,
    at_users: message.at_users, at_user_ids: message.at_user_ids, at_open_dingtalk_ids: message.at_open_dingtalk_ids,
    mentions: message.mentions,
  }));
}

export async function searchBots(query: string): Promise<BotMatch[]> {
  const result = await runDwsJson<DwsBotSearchResponse>(["chat", "bot", "find", "--query", query]);
  return ((result.bots ?? result.result?.bots) ?? []).flatMap((bot) => {
    const openDingTalkId = (bot.openDingTalkId || bot.botOpenDingTalkId)?.trim();
    const name = bot.name?.trim();
    return openDingTalkId && name ? [{ openDingTalkId, name }] : [];
  });
}

export async function searchGroups(query: string): Promise<GroupMatch[]> {
  const result = await runDwsJson<DwsChatSearchResponse>(["chat", "+chat-search", "--query", query, "--limit", "20"]);
  return (result.chats ?? []).flatMap((chat) => {
    const groupId = chat.openConversationId?.trim();
    const groupName = chat.name?.trim() || chat.title?.trim();
    return groupId && groupName ? [{ groupId, groupName, memberCount: chat.memberCount }] : [];
  });
}

export async function searchUsers(query: string): Promise<UserMatch[]> {
  // Keep this as the DWS contact search command. Do not use group members or
  // any DingTalk HTTP API here; the value saved for robot authorization must be
  // the contact userId returned by this command.
  const result = await runDwsJson<DwsUserSearchResponse>([
    "contact", "+search-user", "--query", query,
  ]);
  const users = result.users ?? result.items ?? result.data?.users ?? result.data?.items
    ?? result.data?.result?.users ?? result.data?.result?.items ?? [];
  return users.flatMap((user) => {
    // Robot callbacks expose userId as senderStaffId. Prefer it for one-to-one
    // authorization; openDingTalkId belongs to a different identifier namespace.
    const senderId = (user.userId || user.openDingtalkId || user.openDingTalkId)?.trim();
    const senderName = (user.name || user.nick)?.trim();
    return senderId && senderName ? [{ senderId, senderName, department: user.department }] : [];
  });
}

export async function addBotToGroup(groupId: string, robotCode: string): Promise<void> {
  try {
    const result = await runDwsJson<DwsOperationResponse>([
      "chat", "+chat-add-bot", "--robot-code", robotCode, "--id", groupId, "--yes",
    ]);
    if (result.success === false || result.ok === false) throw new Error(`配置机器人加入群失败：${JSON.stringify(result.error ?? result)}`);
  } catch (err) {
    throw new Error(`配置机器人加入群失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function listGroupBots(groupId: string): Promise<Array<{ openBotId: string; name: string }>> {
  const result = await runDwsJson<DwsGroupBotsResponse>([
    "chat", "+chat-bots", "--group", groupId,
  ]);
  return (result.bots ?? []).flatMap((bot) => {
    const openBotId = bot.openBotId?.trim();
    const name = bot.name?.trim();
    return openBotId && name ? [{ openBotId, name }] : [];
  });
}

export async function listGroupMembers(groupId: string): Promise<GroupMember[]> {
  const result = await runDwsJson<DwsGroupMembersResponse>([
    "chat", "+chat-members-list", "--conversation-id", groupId, "--member-types", "user",
  ]);
  if (result.complete !== true || result.partial === true) throw new Error("群成员未完整返回，未使用部分结果");
  return (result.users ?? []).flatMap((user) => {
    const senderId = user.openDingtalkId?.trim();
    const senderName = user.name?.trim() || user.nick?.trim();
    return senderId && senderName ? [{ senderId, senderName, role: user.role }] : [];
  });
}

/**
 * 机器人成员与真人成员使用同一套 openDingtalkId，可用于判断群消息是否由
 * 群内机器人（AI）发出。返回的 senderId 与事件里的 sender_open_dingtalk_id 可直接比较。
 */
export async function listGroupBotMembers(groupId: string): Promise<Array<{ senderId: string; senderName: string }>> {
  const result = await runDwsJson<DwsGroupBotMembersResponse>([
    "chat", "+chat-members-list", "--conversation-id", groupId, "--member-types", "bot",
  ]);
  return (result.bots ?? []).flatMap((bot) => {
    const senderId = (bot.openDingtalkId || bot.openDingTalkId)?.trim();
    const senderName = bot.name?.trim();
    return senderId && senderName ? [{ senderId, senderName }] : [];
  });
}

export async function listConversations(): Promise<Array<{ openConversationId?: string; conversationName?: string }>> {
  const result = await runDwsJson<{
    conversations?: Array<{ openConversationId?: string; conversationName?: string }>;
    chats?: Array<{ openConversationId?: string; name?: string }>;
    data?: {
      conversations?: Array<{ openConversationId?: string; conversationName?: string }>;
      chats?: Array<{ openConversationId?: string; name?: string }>;
      result?: { conversations?: Array<{ openConversationId?: string; conversationName?: string }>; chats?: Array<{ openConversationId?: string; name?: string }> };
    };
  }>([
    "chat", "+chat-list", "--types", "group", "--page-size", "20",
  ]);
  const data = result.data;
  const nested = data?.result;
  const chats = result.chats ?? data?.chats ?? nested?.chats;
  return result.conversations ?? data?.conversations ?? nested?.conversations
    ?? chats?.map((chat) => ({ openConversationId: chat.openConversationId, conversationName: chat.name })) ?? [];
}

export function startGroupEventStream(_eventName: string, maxEvents?: string, groupId?: string): ChildProcessWithoutNullStreams {
  // group-worker owns the DWS event subscription directly. Keeping the
  // subscription in the same process as the consumer removes the old
  // Unix-socket/nc relay and avoids an extra failure boundary.
  const args = ["event", "+listen-im", "--kind", "all-group", "--events", "message", "--format", "ndjson"];
  if (groupId) args.push("--group", groupId);
  if (maxEvents) args.push("--max-events", maxEvents);
  return spawn(dwsPath, args, { stdio: ["pipe", "pipe", "pipe"] });
}
