import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { BotMatch, GroupMatch, GroupMember, UserMatch } from "../dws-dashboard.js";

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

export async function searchRecentGroupMessages(sender: string, minutes = 10, limit = 20, range?: { start?: Date; end?: Date }): Promise<DwsMessageEvent[]> {
  const end = range?.end ?? new Date();
  const start = range?.start ?? new Date(end.getTime() - minutes * 60_000);
  const result = await runDwsJson<DwsMessageListResponse & { data?: DwsMessageListResponse }>([
    "chat", "+search-msg", "--sender", sender, "--chat-type", "group",
    "--start", start.toISOString(), "--end", end.toISOString(),
    "--order", "desc", "--limit", String(limit),
  ]);
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
