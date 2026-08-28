import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { GroupMatch, GroupMember, UserMatch } from "./dws-dashboard.js";

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
    conversationId?: string; createTime?: string; messageId?: string; sender?: string;
    senderId?: string; senderOpenDingTalkId?: string; text?: string; content?: string;
    atUsers?: unknown; atUserIds?: unknown; atOpenDingTalkIds?: unknown;
    at_users?: unknown; at_user_ids?: unknown; at_open_dingtalk_ids?: unknown;
    mentions?: unknown;
  }>;
}
interface DwsChatSearchResponse { chats?: Array<{ openConversationId?: string; name?: string; title?: string; memberCount?: number }>; }
interface DwsConversationListResponse { conversations?: Array<{ openConversationId?: string; conversationName?: string }>; }
interface DwsMessageSendResult { failedCount?: number; success?: boolean; }
interface DwsUserSearchResponse {
  users?: Array<{ openDingtalkId?: string; openDingTalkId?: string; userId?: string; name?: string; nick?: string; department?: string }>;
  items?: Array<{ openDingtalkId?: string; openDingTalkId?: string; userId?: string; name?: string; nick?: string; department?: string }>;
}
interface DwsGroupMembersResponse {
  complete?: boolean; partial?: boolean;
  users?: Array<{ openDingtalkId?: string; name?: string; nick?: string; role?: string }>;
}

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

export async function listGroupMessages(groupId: string, from: Date): Promise<DwsMessageEvent[]> {
  const result = await runDwsJson<DwsMessageListResponse>([
    "chat", "message", "list", "--group", groupId, "--time", formatDwsTime(from),
    "--direction", "newer", "--limit", "50",
  ]);
  return (result.messages ?? []).map((message) => ({
    conversation_id: message.conversationId, create_time: message.createTime, message_id: message.messageId,
    sender_open_dingtalk_id: message.senderOpenDingTalkId || message.senderId,
    sender: message.sender ? { name: message.sender } : undefined,
    content: message.text || message.content,
  }));
}

export async function searchMonitorCommands(senderId: string, from: Date): Promise<DwsMessageEvent[]> {
  const result = await runDwsJson<DwsMessageListResponse>([
    "chat", "+search-msg", "--senders", senderId, "--start", from.toISOString(),
    "--end", new Date().toISOString(), "--order", "asc", "--limit", "50",
  ]);
  return (result.messages ?? []).map((message) => ({
    conversation_id: message.conversationId, create_time: message.createTime, message_id: message.messageId,
    sender_open_dingtalk_id: message.senderOpenDingTalkId || message.senderId,
    sender: message.sender ? { name: message.sender } : undefined,
    content: message.text || message.content,
  }));
}

export async function sendRobotText(groupId: string, robotCode: string, content: string): Promise<void> {
  const result = await runDwsJson<DwsMessageSendResult>([
    "chat", "+messages-send", "--as", "bot", "--robot-code", robotCode,
    "--groups", groupId, "--text", content, "--yes",
  ]);
  if (result.success === false || (result.failedCount ?? 0) > 0) throw new Error("机器人普通消息发送失败");
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
  const result = await runDwsJson<DwsConversationListResponse>([
    "chat", "+conversation-list", "--page-all", "--page-limit", "5", "--max-items", "500",
  ]);
  return result.conversations ?? [];
}

export function startGroupEventStream(eventName: string, maxEvents?: string, groupId?: string): ChildProcessWithoutNullStreams {
  const args = ["event", "consume", eventName, "--flatten", "--format", "ndjson"];
  if (groupId) args.push("--group", groupId);
  if (maxEvents) args.push("--max-events", maxEvents);
  return spawn(dwsPath, args, { stdio: ["pipe", "pipe", "pipe"] });
}
