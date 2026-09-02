import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { BotMatch, GroupMatch, GroupMember, UserMatch } from "./dws-dashboard.js";

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
}
interface DwsGroupMembersResponse {
  complete?: boolean; partial?: boolean;
  users?: Array<{ openDingtalkId?: string; name?: string; nick?: string; role?: string }>;
}
interface DwsGroupBotsResponse {
  bots?: Array<{ openBotId?: string; name?: string }>;
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

function formatDwsTime(date: Date): string {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

export async function listGroupMessages(groupId: string, from: Date, limit = 20): Promise<DwsMessageEvent[]> {
  const result = await runDwsJson<DwsMessageListResponse>([
    "chat", "message", "list", "--group", groupId, "--time", formatDwsTime(from),
    "--direction", "newer", "--limit", String(limit),
  ]);
  return (result.messages ?? []).map((message) => ({
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
  const result = await runDwsJson<DwsSelfResponse>(["contact", "+me"]);
  return { userId: result.userId?.trim(), openDingTalkId: (result.openDingTalkId || result.openDingtalkId)?.trim(), name: result.name?.trim(), email: result.email?.trim(), dept: result.dept?.trim(), org: result.org?.trim() };
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
  const result = await runDwsJson<DwsUserSearchResponse>(["contact", "+search-user", "--query", query]);
  return (result.users ?? result.items ?? []).flatMap((user) => {
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

export async function listConversations(): Promise<Array<{ openConversationId?: string; conversationName?: string }>> {
  const result = await runDwsJson<{ conversations?: Array<{ openConversationId?: string; conversationName?: string }>; chats?: Array<{ openConversationId?: string; name?: string }> }>([
    "chat", "+chat-list", "--types", "group", "--page-size", "10",
  ]);
  return result.conversations ?? result.chats?.map((chat) => ({ openConversationId: chat.openConversationId, conversationName: chat.name })) ?? [];
}

export function startGroupEventStream(eventName: string, maxEvents?: string, groupId?: string): ChildProcessWithoutNullStreams {
  const args = ["event", "consume", eventName, "--flatten", "--format", "ndjson"];
  if (groupId) args.push("--group", groupId);
  if (maxEvents) args.push("--max-events", maxEvents);
  return spawn(dwsPath, args, { stdio: ["pipe", "pipe", "pipe"] });
}
