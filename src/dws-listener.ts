import { mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { agentLabel, agentSwitchMessage, runAgent } from "./agents/index.js";
import type { Config } from "./config.js";
import { DingTalkCardClient, type CardReplyHandle } from "./dingtalk-card.js";
import { applyMonitorCommand, parseMonitorCommand, type MonitorCommand } from "./monitor-command.js";
import {
  startDashboard,
  type DashboardConfig,
  type DashboardStatus,
  type MonitorTarget,
  type ReplyRecord,
  type ConversationMessage,
} from "./dws-dashboard.js";
import {
  dwsPath,
  listGroupMessages,
  listConversations,
  getCurrentDwsUser,
  getDwsAuthStatus,
  startDwsDeviceLogin,
  getDwsDeviceLoginOutput,
  logoutDws,
  listGroupBots,
  addBotToGroup,
  listGroupMembers,
  searchGroups,
  searchUsers,
  searchBots,
  startGroupEventStream,
  type DwsMessageEvent,
} from "./dws-client.js";
import type { GroupMember } from "./dws-dashboard.js";
import { createLogger } from "./logger.js";
import { sendRobotGroupText } from "./dingtalk-robot.js";
import { runDwsJson } from "./dws-client.js";
import { appendConversationLog } from "./conversation-log.js";

const log = createLogger("DwsCodexListener");

async function sendDwsFallbackText(groupId: string, content: string): Promise<void> {
  const result = await runDwsJson<{ success?: boolean; failedCount?: number }>(["chat", "message", "send", "--group", groupId, "--text", content, "--yes"]);
  if (result.success === false || (result.failedCount ?? 0) > 0) throw new Error("DWS 失败原因通知发送失败");
}

async function sendRobotText(groupId: string, config: DashboardConfig, content: string): Promise<void> {
  log.info(`robot API send group=${groupId} robotCode=${config.clientId} robotName=${config.robotName}`);
  return sendRobotGroupText(groupId, content, config.clientId, config.clientId, config.clientSecret);
}
const DEFAULT_CODEX_WORK_DIR = process.cwd();
const DEFAULT_DWS_CODEX_TIMEOUT_MS = 300_000;
const DWS_GROUP_MESSAGE_EVENT = "user_im_message_receive_group_all";

const DATA_DIR = join(homedir(), ".oh-my-im");
const LEGACY_DATA_DIR = join(process.cwd(), ".oh-my-im");
const CONFIG_MIGRATION_FILE = join(DATA_DIR, ".config-location-v1");
const LISTENER_LOCK_FILE = join(DATA_DIR, "dws-listener.lock");
const CARD_STATE_FILE = join(DATA_DIR, "dws-cards.json");
const DASHBOARD_CONFIG_FILE = join(DATA_DIR, "dws-dashboard.json");
const DASHBOARD_SERVER_CONFIG_FILE = join(DATA_DIR, "dws-dashboard-server.json");
const REPLY_HISTORY_DIR = join(DATA_DIR, "replies");
const LEGACY_REPLY_HISTORY_FILE = join(DATA_DIR, "dws-replies.json");
const DEFAULT_DINGTALK_CLIENT_ID = "";
const DEFAULT_DINGTALK_CLIENT_SECRET = "";
const DEFAULT_ROBOT_NAME = "AI Agent";
const EMPTY_COMMAND_KEYWORDS: DashboardConfig["commandKeywords"] = {
  pause: [], monitorOpen: [], monitorStop: [], switchPi: [], switchCodex: [],
};
const cardUpdateIntervalMs = 500;
const historyPollIntervalMs = 2_000;
const historyLookbackMs = 20_000;
const mentionPollIntervalMs = 5_000;

interface CardState {
  cards: Record<string, PersistedCard>;
}

interface DashboardServerConfig {
  port: number;
  host: "127.0.0.1" | "0.0.0.0" | "::" | "localhost";
}

type CardStatus = "processing" | "completed" | "failed";

interface PersistedCard {
  cardBizId: string;
  status: CardStatus;
}

interface ListenerRuntime {
  startedAt: string;
  eventConnected: boolean;
  lastEventAt?: string;
  activeBatches: number;
}

function hasMention(event: DwsMessageEvent): boolean {
  const hasValue = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.length > 0;
    return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
  };

  // DWS has returned mention metadata under several names in different
  // message APIs. Check the complete event instead of relying on one schema.
  const visit = (value: unknown, depth = 0): boolean => {
    if (!value || depth > 4) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value !== "object") return false;
    return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
      const normalized = key.toLowerCase().replace(/[-_]/g, "");
      if (normalized === "at" || normalized.startsWith("atuser") || normalized.startsWith("atopendingtalk") || normalized.startsWith("mention")) {
        return hasValue(child) || visit(child, depth + 1);
      }
      return visit(child, depth + 1);
    });
  };
  if (visit(event)) return true;

  // History APIs can flatten mention metadata into the message text. A mention
  // is an @ token at the start of a message or after whitespace; this avoids
  // treating normal email addresses as mentions.
  const content = (event.content || event.text || "").trim();
  return /(?:^|\s)@[^\s]+/u.test(content);
}

function mentionValues(event: DwsMessageEvent): string[] {
  const values: string[] = [];
  const mentionKeys = /^(?:at|atuser|atusers|atuserids|atopendingtalk|mention|mentions)$/;
  const collect = (value: unknown, depth = 0): void => {
    if (!value || depth > 5) return;
    if (typeof value === "string") { if (value.trim()) values.push(value.trim()); return; }
    if (Array.isArray(value)) { value.forEach((item) => collect(item, depth + 1)); return; }
    if (typeof value !== "object") return;
    Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
      const normalized = key.toLowerCase().replace(/[-_]/g, "");
      if (/^(?:id|userid|staffid|opendingtalkid|opendingtalkids|name|nick|nickname|displayname)$/.test(normalized)) {
        if (typeof child === "string" && child.trim()) values.push(child.trim());
      } else collect(child, depth + 1);
    });
  };
  const visit = (value: unknown, depth = 0): void => {
    if (!value || depth > 5 || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach((item) => visit(item, depth + 1)); return; }
    Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
      const normalized = key.toLowerCase().replace(/[-_]/g, "");
      if (mentionKeys.test(normalized) || normalized.startsWith("atuser") || normalized.startsWith("mention")) collect(child);
      else visit(child, depth + 1);
    });
  };
  visit(event);
  const content = (event.content || event.text || "").trim();
  const textMentions = content.match(/@[^\s]+/gu) ?? [];
  return [...new Set([...values, ...textMentions.map((value) => value.slice(1).trim()).filter(Boolean)])];
}

function parseMentionMonitorCommand(content: string, keywords: DashboardConfig["commandKeywords"], hasTargetMention = false): "open" | "stop" | undefined {
  const normalized = content.replace(/\s+/g, "").toLowerCase();
  // A target only needs to be a member of the current group. It does not need
  // to be in the one-to-one authorization list; only the command sender is
  // authorized.
  if (!hasTargetMention && !(content.match(/@[^\s]+/gu)?.length)) return undefined;
  if ((keywords.monitorOpen ?? []).some((keyword) => {
    const value = keyword.replace(/\s+/g, "").toLowerCase();
    return value && normalized.includes(value);
  })) return "open";
  if ((keywords.monitorStop ?? []).some((keyword) => {
    const value = keyword.replace(/\s+/g, "").toLowerCase();
    return value && normalized.includes(value);
  })) return "stop";
  return undefined;
}

function resolveMentionedMember(members: GroupMember[], mentions: string[]): GroupMember | undefined {
  const candidates = mentions.map((value) => value.replace(/^@/, "").trim().toLowerCase()).filter(Boolean);
  return members.find((member) => {
    const values = [member.senderId, member.senderName].map((value) => value.trim().toLowerCase());
    return candidates.some((candidate) => values.includes(candidate));
  });
}

function eventKey(event: DwsMessageEvent, groupId: string): string | undefined {
  const messageId = event.message_id || event.messageId || event.openMessageId;
  if (messageId?.trim()) return `${groupId}:message:${messageId.trim()}`;
  if (event.event_id?.trim()) return `${groupId}:event:${event.event_id.trim()}`;

  // Some DWS history results omit message_id. Keep a deterministic fallback so
  // the same item returned by the stream and the history poll is not handled
  // twice. The timestamp is part of the key so two identical messages remain
  // distinct when they were sent at different times.
  const senderId = getSenderId(event);
  const content = (event.content || event.text || "").trim();
  const createdAt = event.create_time?.trim();
  if (senderId !== "unknown" && content && createdAt) {
    return `${groupId}:fallback:${senderId}:${createdAt}:${content}`;
  }
  return undefined;
}

function eventGroupId(event: DwsMessageEvent): string | undefined {
  return event.conversation_id?.trim() || event.conversationId?.trim() || event.openConversationId?.trim();
}

async function acquireListenerLock(): Promise<() => Promise<void>> {
  let lock;
  try {
    lock = await open(LISTENER_LOCK_FILE, "wx");
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
    if (code === "EEXIST") {
      const pid = Number.parseInt(await readFile(LISTENER_LOCK_FILE, "utf8").catch(() => ""), 10);
      try {
        if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0);
        throw new Error(`DWS listener is already running (lock: ${LISTENER_LOCK_FILE})`);
      } catch (lockErr) {
        if (lockErr instanceof Error && lockErr.message.startsWith("DWS listener")) throw lockErr;
        await unlink(LISTENER_LOCK_FILE).catch(() => undefined);
        lock = await open(LISTENER_LOCK_FILE, "wx");
      }
    }
    else throw err;
  }
  await lock.writeFile(`${process.pid}\n`);
  return async () => {
    await lock.close();
    await unlink(LISTENER_LOCK_FILE).catch(() => undefined);
  };
}

async function loadCardState(): Promise<CardState> {
  try {
    const parsed = JSON.parse(await readFile(CARD_STATE_FILE, "utf8")) as {
      cards?: Record<string, PersistedCard | string>;
    };
    const cards = Object.fromEntries(
      Object.entries(parsed.cards ?? {}).map(([groupId, card]) => [
        groupId,
        typeof card === "string" ? { cardBizId: card, status: "completed" } : card,
      ]),
    ) as Record<string, PersistedCard>;
    return { cards };
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
    if (code === "ENOENT") return { cards: {} };
    throw new Error(`Unable to load card state: ${String(err)}`);
  }
}

async function saveCardState(state: CardState): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${CARD_STATE_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, CARD_STATE_FILE);
}

function knownGroupName(groupId: string): string {
  return groupId;
}

function createDefaultTargets(): MonitorTarget[] {
  return [];
}

function defaultBotAllowedUserIds(targets: MonitorTarget[]): string[] {
  return [...new Set(targets.map((target) => target.senderId).filter(Boolean))];
}

function normalizeDashboardConfig(parsed: DashboardConfig): DashboardConfig {
  if (!Array.isArray(parsed.targets)) throw new Error("targets is invalid");
  if (parsed.replyFormat !== "markdown" && parsed.replyFormat !== "plain") throw new Error("replyFormat is invalid");
  const targets = parsed.targets;
  return {
    ...parsed,
    privateChatEnabled: parsed.privateChatEnabled !== false,
    targets,
    botAllowedUserIds: Array.isArray(parsed.botAllowedUserIds) && parsed.botAllowedUserIds.length > 0
      ? [...new Set(parsed.botAllowedUserIds.map((id) => id.trim()).filter(Boolean))]
      : defaultBotAllowedUserIds(targets),
    botAllowedUserNames: parsed.botAllowedUserNames && typeof parsed.botAllowedUserNames === "object"
      ? parsed.botAllowedUserNames
      : Object.fromEntries(targets.map((target) => [target.senderId, target.senderName])),
    botSuperAdminUserIds: Array.isArray(parsed.botSuperAdminUserIds)
      ? [...new Set(parsed.botSuperAdminUserIds.map((id) => id.trim()).filter(Boolean))]
      : [],
    botSuperAdminUserNames: parsed.botSuperAdminUserNames && typeof parsed.botSuperAdminUserNames === "object"
      ? parsed.botSuperAdminUserNames
      : {},
    robotSenderOpenDingTalkId: parsed.robotSenderOpenDingTalkId?.trim() || "",
    agent: parsed.agent === "pi" ? "pi" : "codex",
    commandKeywords: parsed.commandKeywords && typeof parsed.commandKeywords === "object"
      ? parsed.commandKeywords
      : structuredClone(EMPTY_COMMAND_KEYWORDS),
    groupPromptPrefix: typeof parsed.groupPromptPrefix === "string" ? parsed.groupPromptPrefix.trim() : "",
    robotName: parsed.robotName?.trim() || DEFAULT_ROBOT_NAME,
    clientId: parsed.clientId?.trim() || DEFAULT_DINGTALK_CLIENT_ID,
    clientSecret: parsed.clientSecret?.trim() || DEFAULT_DINGTALK_CLIENT_SECRET,
  };
}

async function readStoredDashboardConfig(file: string): Promise<DashboardConfig | undefined> {
  try {
    return normalizeDashboardConfig(JSON.parse(await readFile(file, "utf8")) as DashboardConfig);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
    if (code !== "ENOENT") log.warn(`dashboard config ignored (${file}): ${String(err)}`);
    return undefined;
  }
}

async function saveDashboardConfig(config: DashboardConfig): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${DASHBOARD_CONFIG_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporary, DASHBOARD_CONFIG_FILE);
}

function mergeDashboardConfigs(primary: DashboardConfig, legacy: DashboardConfig): DashboardConfig {
  const targets = [...primary.targets, ...legacy.targets].filter((target, index, all) =>
    all.findIndex((item) => item.groupId === target.groupId && item.senderId === target.senderId) === index,
  );
  return {
    ...legacy,
    ...primary,
    targets,
    botAllowedUserIds: [...new Set([...primary.botAllowedUserIds, ...legacy.botAllowedUserIds])],
    botAllowedUserNames: { ...legacy.botAllowedUserNames, ...primary.botAllowedUserNames },
    botSuperAdminUserIds: [...new Set([...primary.botSuperAdminUserIds, ...legacy.botSuperAdminUserIds])],
    botSuperAdminUserNames: { ...legacy.botSuperAdminUserNames, ...primary.botSuperAdminUserNames },
    robotSenderOpenDingTalkId: primary.robotSenderOpenDingTalkId || legacy.robotSenderOpenDingTalkId,
    clientId: primary.clientId || legacy.clientId,
    clientSecret: primary.clientSecret || legacy.clientSecret,
  };
}

async function migrateDashboardConfig(): Promise<void> {
  try {
    await readFile(CONFIG_MIGRATION_FILE, "utf8");
    return;
  } catch {
    // A single migration avoids resurrecting deleted legacy rules after future restarts.
  }
  const primary = await readStoredDashboardConfig(DASHBOARD_CONFIG_FILE);
  const legacy = LEGACY_DATA_DIR === DATA_DIR
    ? undefined
    : await readStoredDashboardConfig(join(LEGACY_DATA_DIR, "dws-dashboard.json"));
  if (primary && legacy) await saveDashboardConfig(mergeDashboardConfigs(primary, legacy));
  else if (legacy) await saveDashboardConfig(legacy);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CONFIG_MIGRATION_FILE, "migrated\n", "utf8");
}

async function loadDashboardConfig(): Promise<DashboardConfig> {
  await migrateDashboardConfig();
  const stored = await readStoredDashboardConfig(DASHBOARD_CONFIG_FILE);
  if (stored) return stored;
  const targets = createDefaultTargets();
  return {
    privateChatEnabled: true,
    targets,
    botAllowedUserIds: defaultBotAllowedUserIds(targets),
    botAllowedUserNames: Object.fromEntries(targets.map((target) => [target.senderId, target.senderName])),
    botSuperAdminUserIds: [],
    botSuperAdminUserNames: {},
    robotSenderOpenDingTalkId: "",
    replyFormat: "markdown",
    agent: "codex",
    commandKeywords: structuredClone(EMPTY_COMMAND_KEYWORDS),
    groupPromptPrefix: "",
    robotName: DEFAULT_ROBOT_NAME,
    clientId: DEFAULT_DINGTALK_CLIENT_ID,
    clientSecret: DEFAULT_DINGTALK_CLIENT_SECRET,
  };
}

function normalizeDashboardServerConfig(value: unknown): DashboardServerConfig {
  if (!value || typeof value !== "object") throw new Error("dashboard server config is invalid");
  const source = value as Partial<DashboardServerConfig>;
  const port = source.port;
  const host = source.host;
  if (!Number.isInteger(port) || !port || port < 1 || port > 65535) throw new Error("dashboard port is invalid");
  if (host !== "127.0.0.1" && host !== "0.0.0.0" && host !== "::" && host !== "localhost") throw new Error("dashboard host is invalid");
  return { port, host };
}

async function saveDashboardServerConfig(config: DashboardServerConfig): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${DASHBOARD_SERVER_CONFIG_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporary, DASHBOARD_SERVER_CONFIG_FILE);
}

async function loadDashboardServerConfig(): Promise<DashboardServerConfig> {
  try {
    const config = normalizeDashboardServerConfig(JSON.parse(await readFile(DASHBOARD_SERVER_CONFIG_FILE, "utf8")) as unknown);
    await saveDashboardServerConfig(config);
    return config;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
    if (code !== "ENOENT") log.warn(`dashboard server config ignored: ${String(err)}`);
    const config: DashboardServerConfig = { port: 12525, host: "127.0.0.1" };
    await saveDashboardServerConfig(config);
    return config;
  }
}

function replyDateKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function validReplyRecords(value: unknown): ReplyRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((record): record is ReplyRecord => Boolean(record && typeof record === "object" &&
    typeof (record as ReplyRecord).id === "string" &&
    typeof (record as ReplyRecord).content === "string" &&
    ((record as ReplyRecord).status === "completed" || (record as ReplyRecord).status === "failed"),
  ));
}

async function loadReplyHistory(): Promise<ReplyRecord[]> {
  const all: ReplyRecord[] = [];
  try {
    const files = (await readdir(REPLY_HISTORY_DIR)).filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).sort().reverse();
    for (const file of files) {
      try { all.push(...validReplyRecords(JSON.parse(await readFile(join(REPLY_HISTORY_DIR, file), "utf8")))); }
      catch (err) { log.warn(`reply history file ignored (${file}): ${String(err)}`); }
    }
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
    if (code !== "ENOENT") log.warn(`reply history directory ignored: ${String(err)}`);
  }
  // Read the old single-file format once so existing records remain visible.
  try {
    all.push(...validReplyRecords(JSON.parse(await readFile(LEGACY_REPLY_HISTORY_FILE, "utf8"))));
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
    if (code !== "ENOENT") log.warn(`legacy reply history ignored: ${String(err)}`);
  }
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
}

async function recordReply(replies: ReplyRecord[], reply: ReplyRecord): Promise<void> {
  replies.unshift(reply);
  if (replies.length > 100) replies.length = 100;
  await mkdir(REPLY_HISTORY_DIR, { recursive: true });
  const file = join(REPLY_HISTORY_DIR, `${replyDateKey(reply.createdAt)}.json`);
  const existing = await readFile(file, "utf8").then((text) => validReplyRecords(JSON.parse(text))).catch(() => []);
  const records = [reply, ...existing.filter((item) => item.id !== reply.id)];
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  await rename(temporary, file);
  await appendConversationLog({ ...reply, conversationType: "group", conversationName: reply.groupName }, reply.senderDetails);
}

function groupTitle(groupId: string, config: DashboardConfig): string {
  const target = config.targets.find((item) => item.groupId === groupId);
  return `钉钉群 ${target?.groupName || knownGroupName(groupId)}`;
}

function eventGroupName(event: DwsMessageEvent, groupId: string, config: DashboardConfig): string {
  const configuredName = config.targets.find((item) => item.groupId === groupId)?.groupName;
  const eventName = [event.conversation_title, event.conversation_name, event.conversationTitle, event.conversationName]
    .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
  return configuredName || eventName?.trim() || knownGroupName(groupId);
}

const conversationNameCache = new Map<string, string>();

async function groupHasConfiguredRobot(groupId: string, config: DashboardConfig): Promise<boolean> {
  const configuredId = config.robotSenderOpenDingTalkId?.trim();
  const configuredName = config.robotName.trim();
  log.info(`checking configured robot group=${groupId} configuredId=${configuredId || "<none>"} configuredName=${configuredName || "<none>"}`);
  if (!configuredId && !configuredName) {
    log.warn(`configured robot check failed: no robot ID or name group=${groupId}`);
    return false;
  }
  try {
    const [groupBots, matchingBots] = await Promise.all([
      listGroupBots(groupId),
      configuredName ? searchBots(configuredName) : Promise.resolve([]),
    ]);
    // Group membership exposes openBotId, while bot search/configuration uses
    // openDingTalkId. Resolve the canonical name through the configured ID,
    // then compare names across the two identifier namespaces.
    const canonicalName = matchingBots.find((bot) => bot.openDingTalkId === configuredId)?.name;
    const acceptedNames = new Set([configuredName, canonicalName].filter((name): name is string => Boolean(name)));
    const present = groupBots.some((bot) => bot.openBotId === configuredId || acceptedNames.has(bot.name));
    log.info(`configured robot check group=${groupId} present=${present} groupBots=${JSON.stringify(groupBots)} matchedBots=${JSON.stringify(matchingBots)}`);
    return present;
  } catch (err) {
    log.warn(`unable to inspect group robots group=${groupId}: ${String(err)}`);
    return false;
  }
}

async function resolveCommandGroupName(groupId: string, config: DashboardConfig): Promise<string> {
  const configuredName = config.targets.find((item) => item.groupId === groupId)?.groupName?.trim();
  if (configuredName && configuredName !== groupId && !configuredName.startsWith("cid")) return configuredName;
  const cached = conversationNameCache.get(groupId);
  if (cached) return cached;
  try {
    const conversations = await listConversations();
    for (const conversation of conversations) {
      const id = conversation.openConversationId?.trim();
      const name = conversation.conversationName?.trim();
      if (id && name) conversationNameCache.set(id, name);
    }
  } catch (err) {
    log.warn(`unable to resolve group name for monitor command: ${String(err)}`);
  }
  return conversationNameCache.get(groupId) || eventGroupName({}, groupId, config);
}

async function handleMentionMonitorCommand(
  command: "open" | "stop",
  event: DwsMessageEvent,
  groupId: string,
  config: DashboardConfig,
  target: MonitorTarget,
  updateDashboardConfig: (config: DashboardConfig) => Promise<void>,
): Promise<void> {
  const result = applyMonitorCommand(config, command, target);
  if (result.changed) await updateDashboardConfig(result.config);
  const detail = command === "open" ? `已开启 ${target.senderName} 在本群的AI 能力。` : `已关闭 ${target.senderName} 在本群的AI 能力。`;
  await sendRobotText(groupId, config, detail);
  log.info(`mention monitor command=${command} group=${groupId} operator=${getSenderId(event)} target=${target.senderId} changed=${result.changed}`);
}

async function handleMonitorCommand(
  command: MonitorCommand,
  event: DwsMessageEvent,
  groupId: string,
  getDashboardConfig: () => DashboardConfig,
  updateDashboardConfig: (config: DashboardConfig) => Promise<void>,
  sendReply = true,
): Promise<void> {
  const config = getDashboardConfig();
  const senderId = getSenderId(event);
  if (!senderId || senderId === "unknown") return;
  const senderName = senderDisplayName(event) ||
    config.botAllowedUserNames?.[senderId]?.trim() ||
    config.targets.find((target) => target.groupId === groupId && target.senderId === senderId)?.senderName ||
    senderId;
  const target = {
    groupId,
    groupName: await resolveCommandGroupName(groupId, config),
    senderId,
    senderName,
  };
  const result = applyMonitorCommand(config, command, target);
  if (result.changed) await updateDashboardConfig(result.config);

  const detail = typeof command === "object"
    ? agentSwitchMessage(command.agent)
    : command === "open"
      ? `已开启 ${senderName} 在本群的AI 能力。`
      : `已关闭 ${senderName} 在本群的AI 能力。`;
  if (sendReply) await sendRobotText(groupId, config, detail);
  log.info(`monitor command=${typeof command === "object" ? command.type + ":" + command.agent : command} group=${groupId} changed=${result.changed} replied=${sendReply}`);
}

function senderDisplayName(event: DwsMessageEvent): string {
  const rawSender = event.sender as unknown;
  if (typeof rawSender === "string" && rawSender.trim()) return rawSender.trim();
  const sender = rawSender && typeof rawSender === "object" ? rawSender as Record<string, unknown> : {};
  return [sender.name, sender.nick, sender.displayName]
    .find((value): value is string => typeof value === "string" && Boolean(value.trim()))
    ?.trim() || "";
}

function isBotAuthorizedOperator(event: DwsMessageEvent, config: DashboardConfig): boolean {
  const senderId = getSenderId(event);
  const allowedIds = new Set(config.botAllowedUserIds.map((id) => id.trim()).filter(Boolean));
  if (allowedIds.has(senderId)) return true;

  // The Web search stores DingTalk userId for bot authorization, while DWS
  // group events normally expose openDingTalkId. Match the configured real
  // name as the cross-namespace fallback, but only for names already attached
  // to an allowed ID.
  const senderName = senderDisplayName(event);
  if (!senderName) return false;
  return Object.entries(config.botAllowedUserNames ?? {})
    .some(([id, name]) => allowedIds.has(id) && name?.trim() === senderName);
}

function acceptsTarget(event: DwsMessageEvent, config: DashboardConfig): boolean {
  // Stream events and history queries do not always use the same field name.
  // Keep the filtering path consistent with eventGroupId(), otherwise a valid
  // message can be received and then discarded before it reaches the queue.
  const groupId = eventGroupId(event);
  if (!groupId) return false;
  const senderId = getSenderId(event);
  // Group permissions are keyed by the exact DWS identifiers from the event:
  // conversation_id + sender_open_dingtalk_id. Do not fall back to names here,
  // because names are not stable identifiers and can be duplicated.
  return config.targets.some((target) => target.groupId === groupId && target.senderId === senderId);
}

function isCurrentDwsUser(event: DwsMessageEvent, currentUser: { userId?: string; openDingTalkId?: string; name?: string }): boolean {
  const senderId = getSenderId(event).toLowerCase();
  const senderName = senderDisplayName(event).toLowerCase();
  const ids = [currentUser.userId, currentUser.openDingTalkId].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase());
  return ids.includes(senderId) || Boolean(senderName && currentUser.name && senderName === currentUser.name.toLowerCase());
}

function configuredGroupIds(config: DashboardConfig): string[] {
  return Array.from(new Set(config.targets.map((target) => target.groupId)));
}

function formatReply(content: string, format: DashboardConfig["replyFormat"]): string {
  if (format === "markdown") return content;
  return content.replace(/[\\`*_{}\[\]<>()#+\-.!|]/g, "\\$&");
}

function completedCardContent(content: string, messageCount: number, toolStats: Record<string, number>): string {
  const toolCount = Object.values(toolStats).reduce((total, count) => total + count, 0);
  return [
    content.trim() || "(无输出)",
    "---",
    `处理详情 · ${messageCount} 条消息 · ${toolCount} 次工具调用`,
  ].join("\n\n");
}

function batchQuestion(events: DwsMessageEvent[]): string {
  return events.map((event) => event.content?.trim()).filter(Boolean).join("\n");
}

function batchSenderDetails(events: DwsMessageEvent[], config: DashboardConfig): ConversationMessage[] {
  return events.map((event) => {
    const sender = event.sender ?? {};
    const senderName = [sender.name, sender.nick, sender.displayName]
      .find((value): value is string => typeof value === "string" && Boolean(value.trim()))
      ?.trim() || config.targets.find((target) => target.senderId === getSenderId(event))?.senderName || getSenderId(event);
    return { senderName, senderId: getSenderId(event), content: event.content?.trim() || event.text?.trim() || "", createdAt: event.create_time };
  }).filter((message) => message.content);
}

function batchSenderNames(events: DwsMessageEvent[], config: DashboardConfig): string[] {
  const names = events.map((event) => {
    const sender = event.sender ?? {};
    const eventName = [sender.name, sender.nick, sender.displayName]
      .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
    return eventName?.trim() || config.targets.find((target) => target.senderId === getSenderId(event))?.senderName || getSenderId(event);
  });
  return [...new Set(names)];
}

function isMissingCardError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("DingTalk card API failed: 404") ||
    /card.*(not found|does not exist|不存在)/i.test(message);
}

function getSenderId(event: DwsMessageEvent): string {
  const sender = event.sender ?? {};
  return event.sender_open_dingtalk_id?.trim() ||
    event.senderOpenDingTalkId?.trim() ||
    event.sender_user_id?.trim() ||
    (typeof sender.openDingtalkId === "string" ? sender.openDingtalkId.trim() : "") ||
    (typeof sender.open_dingtalk_id === "string" ? sender.open_dingtalk_id.trim() : "") ||
    (typeof sender.userId === "string" ? sender.userId.trim() : "") ||
    (typeof sender.user_id === "string" ? sender.user_id.trim() : "") ||
    "unknown";
}

function isIgnoredRobotEvent(event: DwsMessageEvent, config: DashboardConfig): boolean {
  const sender = event.sender ?? {};
  const robotName = config.robotName.trim().toLowerCase();
  const senderValues = [sender.name, sender.nick, sender.displayName, sender.robotCode]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  // Robot callbacks are not consistent across the stream and history APIs:
  // some expose only a robotCode/bot marker, while others expose the sender's
  // display name. Inspect sender metadata first, then use the configured name
  // as a conservative fallback (the configured short name may prefix a real
  // DingTalk robot display name).
  const robotMarker = (value: unknown, depth = 0): boolean => {
    if (!value || depth > 3) return false;
    if (Array.isArray(value)) return value.some((item) => robotMarker(item, depth + 1));
    if (typeof value !== "object") return false;
    return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
      const normalized = key.toLowerCase().replace(/[-_]/g, "");
      if (normalized === "isbot" || normalized === "isrobot" || normalized === "bottype" || normalized === "sendertype") {
        return child === true || (typeof child === "string" && /bot|robot/i.test(child));
      }
      return normalized.includes("robotcode") || normalized === "botid" || normalized === "openbotid";
    });
  };
  const isRobot = robotMarker(sender) ||
    (robotName && senderValues.some((value) => value.includes(robotName)));
  if (isRobot) return true;

  // DWS history records are not consistent about exposing the sender name.
  // Never feed our own agent-switch acknowledgement back into the command
  // parser. The acknowledgement deliberately contains the words "Pi" or
  // "Codex", so parsing it as a new command causes duplicate acknowledgements.
  const content = (event.content || event.text || "").trim();
  const isSwitchAcknowledgement = /^当前已切换到\s*(?:Pi|Codex)(?:\s+Agent)?\s*[。.!！]?/i.test(content) &&
    /使用方法：?\s*直接发送问题或任务即可/i.test(content);
  const isMonitorAcknowledgement = /^已(?:开启|关闭)\s+.+\s+在本群的AI\s*能力[。.!！]?$/u.test(content);
  if (isSwitchAcknowledgement || isMonitorAcknowledgement) return true;
  return false;
}

function codexConfig(): Config {
  const workDir = process.env.CODEX_WORK_DIR?.trim() || DEFAULT_CODEX_WORK_DIR;
  const timeout = Number.parseInt(
    process.env.DWS_CODEX_TIMEOUT_MS || String(DEFAULT_DWS_CODEX_TIMEOUT_MS),
    10,
  );
  return {
    dingtalkClientId: "",
    dingtalkClientSecret: "",
    codexCliPath: process.env.CODEX_CLI_PATH?.trim() || "codex",
    codexWorkDir: workDir,
    codexModel: process.env.DWS_CODEX_MODEL?.trim() || undefined,
    codexProxy: process.env.CODEX_PROXY?.trim() || undefined,
    codexPermissionMode: "bypass",
    piCliPath: process.env.PI_CLI_PATH?.trim() || "pi",
    agent: "codex",
    allowedUserIds: [],
    cliTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 900000,
  };
}

function buildPrompt(events: DwsMessageEvent[], prefix: string): string {
  return [
    prefix.trim(),
    "DingTalk 消息事件:",
    JSON.stringify(events, null, 2),
  ].filter(Boolean).join("\n\n");
}

async function handleBatch(
  events: DwsMessageEvent[],
  groupId: string,
  cardState: CardState,
  sessions: Map<string, string>,
  cardClient: DingTalkCardClient,
  getDashboardConfig: () => DashboardConfig,
  replies: ReplyRecord[],
  liveReplies: Map<string, ReplyRecord>,
  queue?: GroupQueue,
): Promise<void> {
  if (events.length === 0) return;
  if (queue) queue.paused = false;
  const agent = getDashboardConfig().agent;
  const label = `${agentLabel(agent)} Agent`;
  const sessionKey = `${agent}:${groupId}`;
  const sessionId = sessions.get(sessionKey);
  log.info(
    `processing batch size=${events.length} groupSession=${sessionId ? "resume" : "new"}`,
  );
  let card: CardReplyHandle | undefined;
  let latestVisibleContent = `${label} 正在处理...`;
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;
  const title = `【${label}】`;
  const taskStartedAt = Date.now();
  const formatElapsed = () => {
    const totalSeconds = Math.max(0, Math.floor((Date.now() - taskStartedAt) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
  };
  const processingTitle = () => `🔵 ${title}处理中... (${formatElapsed()})`;
  try {
    const storedCard = cardState.cards[groupId];
    if (storedCard?.status === "processing") {
      card = { groupId, cardBizId: storedCard.cardBizId };
      try {
        await cardClient.update(card, processingTitle(), `[等一等] 正在分析...`);
      } catch (err) {
        if (!isMissingCardError(err)) throw err;
        log.warn(`stored card is unavailable; creating a replacement: ${String(err)}`);
        delete cardState.cards[groupId];
        card = undefined;
      }
    }
    if (!card) {
      const cardBizId = randomUUID();
      card = await cardClient.create(groupId, cardBizId, processingTitle(), `[等一等] 正在分析...`);
      cardState.cards[groupId] = { cardBizId, status: "processing" };
      await saveCardState(cardState);
    }
    const activeCard = card;
    const liveReply: ReplyRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      groupId,
      groupName: groupTitle(groupId, getDashboardConfig()).replace(/^钉钉群\s*/, ""),
      conversationType: "group",
      conversationName: groupTitle(groupId, getDashboardConfig()),
      status: "processing",
      question: batchQuestion(events),
      senderNames: batchSenderNames(events, getDashboardConfig()),
      senderDetails: batchSenderDetails(events, getDashboardConfig()),
      content: `[等一等] 正在分析...`,
      agent,
      messageCount: events.length,
    };
    liveReplies.set(groupId, liveReply);
    latestVisibleContent = liveReply.content;
    let lastCardUpdateAt = 0;
    let pendingCardUpdate: { title: string; content: string } | undefined;
    let pendingCardTimer: ReturnType<typeof setTimeout> | undefined;
    let cardUpdateInFlight: Promise<void> | undefined;
    // Pi emits very small deltas quickly. Coalesce them into one complete card
    // snapshot per second so DingTalk receives fresh content without a backlog.
    const intervalMs = agent === "pi" ? 1_000 : cardUpdateIntervalMs;
    const pumpCardUpdate = () => {
      if (cardUpdateInFlight || !pendingCardUpdate) return;
      const remaining = intervalMs - (Date.now() - lastCardUpdateAt);
      if (remaining > 0) {
        if (!pendingCardTimer) {
          pendingCardTimer = setTimeout(() => {
            pendingCardTimer = undefined;
            pumpCardUpdate();
          }, remaining);
          pendingCardTimer.unref();
        }
        return;
      }
      const latest = pendingCardUpdate;
      pendingCardUpdate = undefined;
      lastCardUpdateAt = Date.now();
      cardUpdateInFlight = cardClient.update(activeCard, latest.title, formatReply(latest.content, getDashboardConfig().replyFormat))
        .catch((err) => log.warn(`card update skipped: ${String(err)}`))
        .finally(() => {
          cardUpdateInFlight = undefined;
          // While DingTalk was processing this request, many Pi deltas may have
          // arrived. Send only their newest complete snapshot, never a backlog.
          pumpCardUpdate();
        });
    };
    const flushPendingCardUpdate = async () => {
      if (pendingCardTimer) {
        clearTimeout(pendingCardTimer);
        pendingCardTimer = undefined;
      }
      if (cardUpdateInFlight) await cardUpdateInFlight;
      if (pendingCardUpdate) {
        const latest = pendingCardUpdate;
        pendingCardUpdate = undefined;
        await cardClient.update(activeCard, latest.title, formatReply(latest.content, getDashboardConfig().replyFormat))
          .catch((err) => log.warn(`card update skipped: ${String(err)}`));
      }
    };
    const updateCard = (title: string, content: string) => {
      pendingCardUpdate = { title, content };
      pumpCardUpdate();
    };
    elapsedTimer = setInterval(() => {
      updateCard(processingTitle(), liveReply.content.slice(-8_000));
    }, 1_000);
    elapsedTimer.unref();
    let lastText = "";
    const result = await runAgent(agent, buildPrompt(events, getDashboardConfig().groupPromptPrefix), sessionId, codexConfig(), {
      onAbortReady: (abort) => { if (queue) queue.abort = abort; },
      onSteerReady: (steer) => { if (queue && agent === "pi") queue.steer = steer; },
      onToolUse: (toolName, stats) => {
        log.info(`codex tool=${toolName} count=${stats[toolName] ?? 1}`);
        liveReply.content = `正在调用工具：${toolName}`;
        latestVisibleContent = liveReply.content;
        updateCard(processingTitle(), `正在调用工具：${toolName}`);
      },
      onText: (text) => {
        const delta = text.startsWith(lastText) ? text.slice(lastText.length) : text;
        lastText = text;
        const visible = delta.trim();
        if (visible) {
          liveReply.content = text;
          latestVisibleContent = text;
          log.debug(`codex output: ${visible.slice(0, 2_000)}`);
          // DingTalk card updates replace the existing content, so always send the
          // complete accumulated response instead of only the latest delta.
          updateCard(processingTitle(), text.slice(-8_000));
        }
      },
    });
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = undefined;
    }
    // Codex may close cleanly after SIGTERM and Pi emits agent_settled after an
    // RPC abort. Do not mistake either outcome for a completed task.
    if (queue?.paused) throw new Error("Agent task paused by user");
    if (result.sessionId) sessions.set(sessionKey, result.sessionId);
    await flushPendingCardUpdate();
    const replyText = formatReply(
      completedCardContent(result.text, events.length, result.toolStats),
      getDashboardConfig().replyFormat,
    );
    await cardClient.update(activeCard, `✅ ${title}完成 总耗时 ${formatElapsed()}`, replyText);
    liveReplies.delete(groupId);
    cardState.cards[groupId] = { cardBizId: activeCard.cardBizId, status: "completed" };
    await saveCardState(cardState);
    await recordReply(replies, {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      groupId,
      groupName: groupTitle(groupId, getDashboardConfig()).replace(/^钉钉群\s*/, ""),
      conversationType: "group",
      conversationName: groupTitle(groupId, getDashboardConfig()),
      status: "completed",
      agent,
      question: batchQuestion(events),
      senderNames: batchSenderNames(events, getDashboardConfig()),
      senderDetails: batchSenderDetails(events, getDashboardConfig()),
      content: result.text,
      messageCount: events.length,
    });
    log.info(`replied batch size=${events.length}`);
  } catch (err) {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = undefined;
    }
    liveReplies.delete(groupId);
    const message = err instanceof Error ? err.message : String(err);
    log.error(`batch size=${events.length} failed: ${message}`);
    if (card) {
      const stopped = queue?.paused === true;
      const stoppedContent = latestVisibleContent;
      await cardClient.update(card, stopped ? `🔴 ${title}处理暂停 总耗时 ${formatElapsed()}` : `❌ ${title}处理失败 总耗时 ${formatElapsed()}`, stopped ? stoppedContent : `${label} 处理失败：${message.slice(0, 2_000)}`)
        .catch((updateErr) => log.warn(`card failure update skipped: ${String(updateErr)}`));
      cardState.cards[groupId] = { cardBizId: card.cardBizId, status: stopped ? "failed" : "failed" };
      await saveCardState(cardState);
      await recordReply(replies, {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        groupId,
        groupName: groupTitle(groupId, getDashboardConfig()).replace(/^钉钉群\s*/, ""),
        conversationType: "group",
        conversationName: groupTitle(groupId, getDashboardConfig()),
        status: "failed",
        agent,
        question: batchQuestion(events),
        senderNames: batchSenderNames(events, getDashboardConfig()),
        senderDetails: batchSenderDetails(events, getDashboardConfig()),
        content: message,
        messageCount: events.length,
      });
    } else {
      log.error(`no card reply sent for group=${groupId}`);
    }
  }
}

interface GroupQueue {
  pending: DwsMessageEvent[];
  running: boolean;
  paused?: boolean;
  activeAgent?: Config["agent"];
  abort?: () => void;
  steer?: (message: string) => boolean;
}

async function enqueueGroupEvent(
  event: DwsMessageEvent,
  groupId: string,
  queues: Map<string, GroupQueue>,
  cardState: CardState,
  sessions: Map<string, string>,
  cardClient: DingTalkCardClient,
  getDashboardConfig: () => DashboardConfig,
  replies: ReplyRecord[],
  liveReplies: Map<string, ReplyRecord>,
  runtime: ListenerRuntime,
): Promise<void> {
  const queue = queues.get(groupId) ?? { pending: [], running: false };
  queues.set(groupId, queue);
  if (queue.running) {
    const content = (event.content || event.text || "").trim();
    if (queue.activeAgent === "pi" && queue.steer && content) {
      const steered = queue.steer(content);
      if (steered) {
        void sendRobotText(groupId, getDashboardConfig(), "已将这条消息作为引导发送给当前 Pi 任务。")
          .catch((err) => log.warn(`steer acknowledgement failed: ${String(err)}`));
        log.info(`steered message=${event.message_id || "unknown"} group=${groupId}`);
        return;
      }
      void sendRobotText(groupId, getDashboardConfig(), "当前 Pi 任务暂时无法接收引导，消息已排队等待处理。")
        .catch((err) => log.warn(`queue acknowledgement failed: ${String(err)}`));
    } else if (queue.activeAgent === "codex" && content) {
      // Codex exec is a one-turn process; keep follow-up messages in the local
      // per-group queue and process them with exec resume after the turn ends.
      void sendRobotText(groupId, getDashboardConfig(), "当前 Codex 正在处理，消息已排队等待处理。")
        .catch((err) => log.warn(`queue acknowledgement failed: ${String(err)}`));
    }
    queue.pending.push(event);
    log.info(`queued message=${event.message_id || "unknown"} pending=${queue.pending.length}`);
    return;
  }
  queue.pending.push(event);

  queue.running = true;
  queue.activeAgent = getDashboardConfig().agent;
  runtime.activeBatches += 1;
  try {
    while (queue.pending.length > 0) {
      // Messages arriving while Codex runs are collected into the following batch.
      const batch = queue.pending.splice(0);
      await handleBatch(batch, groupId, cardState, sessions, cardClient, getDashboardConfig, replies, liveReplies, queue);
    }
  } finally {
    queue.running = false;
    queue.activeAgent = undefined;
    queue.abort = undefined;
    queue.steer = undefined;
    runtime.activeBatches -= 1;
  }
}

function startGroupListener(
  seen: Set<string>,
  queues: Map<string, GroupQueue>,
  cardState: CardState,
  sessions: Map<string, string>,
  cardClient: DingTalkCardClient,
  getDashboardConfig: () => DashboardConfig,
  updateDashboardConfig: (config: DashboardConfig) => Promise<void>,
  replies: ReplyRecord[],
  liveReplies: Map<string, ReplyRecord>,
  runtime: ListenerRuntime,
): Promise<void> {
  const args = [
    "event", "consume", DWS_GROUP_MESSAGE_EVENT,
    "--flatten", "--format", "ndjson",
  ];
  const maxEvents = process.env.DWS_MAX_EVENTS?.trim();
  if (maxEvents) args.push("--max-events", maxEvents);

  log.info(`starting ${dwsPath} ${args.join(" ")}`);
  const listener = startGroupEventStream(DWS_GROUP_MESSAGE_EVENT, maxEvents);
  // The DWS CLI keeps the event stream process open and normally produces no
  // stdout until an event arrives. Treat a successfully spawned, still-live
  // process as connected; waiting for message data made the dashboard report
  // a false "事件未连接" while the listener was healthy but idle.
  runtime.eventConnected = true;
  log.info("DWS group event stream process started");
  let monitorCommandChain = Promise.resolve();
  // DWS can expose the same control message through both the stream and the
  // history search with different event IDs. Suppress an identical command
  // briefly so it cannot produce repeated switch acknowledgements.
  const recentCommands = new Map<string, number>();
  const handledMentionCommands = new Set<string>();
  let currentDwsUser: { userId?: string; openDingTalkId?: string; name?: string } = {};
  void getCurrentDwsUser().then((user) => { currentDwsUser = user; log.info(`current DWS user resolved id=${user.userId || user.openDingTalkId || "<none>"} name=${user.name || "<none>"}`); }).catch((err) => log.warn(`unable to resolve current DWS user: ${String(err)}`));
  const commandDeduplicationMs = 60_000;
  const rl = createInterface({ input: listener.stdout });
  listener.stderr.on("data", (chunk: Buffer) => {
    const message = chunk.toString().trim();
    if (message) log.debug(`dws: ${message}`);
  });

  const acceptEvent = (event: DwsMessageEvent, options: { commandsOnly?: boolean } = {}) => {
    const groupId = eventGroupId(event);
    const config = getDashboardConfig();
    log.info(`group event received group=${groupId || "<none>"} sender=${getSenderId(event)} senderName=${senderDisplayName(event) || "<none>"} content=${JSON.stringify((event.content || event.text || "").slice(0, 300))} commandsOnly=${Boolean(options.commandsOnly)}`);
    if (!groupId) {
      log.warn("group event ignored: missing conversation_id");
      return;
    }
    if (isIgnoredRobotEvent(event, config)) {
      log.debug(`ignored robot message event=${event.event_id || "unknown"}`);
      return;
    }
    const key = eventKey(event, groupId);
    if (key && seen.has(key)) return;
    if (key) {
      seen.add(key);
      if (seen.size > 1_000) seen.delete(seen.values().next().value as string);
    }
    const rawContent = (event.content || event.text || "").trim();
    const mentionCommand = parseMentionMonitorCommand(rawContent, config.commandKeywords, mentionValues(event).length > 0);
    const authorizedOperator = isBotAuthorizedOperator(event, config);
    log.info(`command precheck group=${groupId} sender=${getSenderId(event)} senderName=${senderDisplayName(event) || "<none>"} content=${JSON.stringify(rawContent)} mentionCommand=${mentionCommand || "none"} authorized=${authorizedOperator} targets=${config.targets.filter((target) => target.groupId === groupId).length}`);
    if (mentionCommand && authorizedOperator) {
      const mentionKey = `${groupId}:mention:${getSenderId(event)}:${mentionCommand}:${rawContent.replace(/\s+/g, "").toLowerCase()}`;
      if (handledMentionCommands.has(mentionKey)) {
        log.debug(`handled mention command ignored group=${groupId} command=${rawContent}`);
        return;
      }
      handledMentionCommands.add(mentionKey);
      if (handledMentionCommands.size > 2_000) handledMentionCommands.delete(handledMentionCommands.values().next().value as string);
      const previousMention = recentCommands.get(mentionKey);
      const mentionNow = Date.now();
      if (previousMention && mentionNow - previousMention < commandDeduplicationMs) {
        log.debug(`duplicate mention command ignored group=${groupId} command=${rawContent}`);
        return;
      }
      recentCommands.set(mentionKey, mentionNow);
      void monitorCommandChain.then(async () => {
        if (!await groupHasConfiguredRobot(groupId, getDashboardConfig())) return;
        const mentions = mentionValues(event);
        const members = await listGroupMembers(groupId);
        const member = resolveMentionedMember(members, mentions);
        if (!member) {
          log.info(`ignored mention command with unresolved group member group=${groupId} mentions=${mentions.join(",")}`);
          return;
        }
        await handleMentionMonitorCommand(mentionCommand, event, groupId, getDashboardConfig(), {
          groupId,
          groupName: await resolveCommandGroupName(groupId, getDashboardConfig()),
          senderId: member.senderId,
          senderName: member.senderName,
        }, updateDashboardConfig);
      }).catch((err) => log.error(`mention monitor command failed: ${String(err)}`));
      return;
    }
    if (hasMention(event)) {
      log.info(`ignored mentioned group message group=${groupId} sender=${getSenderId(event)}`);
      return;
    }
    runtime.lastEventAt = new Date().toISOString();
    const command = parseMonitorCommand(
      { senderId: getSenderId(event), content: rawContent },
      config.commandKeywords,
    );
    log.info(`group event classified group=${groupId} sender=${getSenderId(event)} command=${typeof command === "object" ? `${command.type}:${command.agent}` : command || "message"} configuredTargets=${config.targets.filter((target) => target.groupId === groupId).length}`);
    if (options.commandsOnly && command !== "open" && command !== "stop") return;
    if (options.commandsOnly && !command) return;
    if (command) {
      // Agent switching is scoped to an existing "group + sender" monitor
      // rule. Group robot membership is checked asynchronously below before
      // changing the shared agent setting.
      if (typeof command === "object" && command.type === "switch-agent" && !acceptsTarget(event, config)) {
        log.debug(`ignored agent switch outside monitor rule group=${groupId} sender=${getSenderId(event)}`);
        return;
      }
      const commandName = typeof command === "object" ? `${command.type}:${command.agent}` : command;
      const normalizedCommandContent = rawContent.trim().toLowerCase();
      const commandKey = `${groupId}:${getSenderId(event)}:${commandName}:${normalizedCommandContent}`;
      const previous = recentCommands.get(commandKey);
      const now = Date.now();
      if (previous && now - previous < commandDeduplicationMs) {
        log.debug(`duplicate command ignored group=${groupId} sender=${getSenderId(event)} command=${rawContent}`);
        return;
      }
      recentCommands.set(commandKey, now);
      for (const [key, timestamp] of recentCommands) {
        if (now - timestamp >= commandDeduplicationMs) recentCommands.delete(key);
      }
      if (command === "pause") {
        if (!acceptsTarget(event, getDashboardConfig())) {
          log.debug(`ignored pause from unmonitored sender=${getSenderId(event)}`);
          return;
        }
        const queue = queues.get(groupId);
        if (queue?.running) {
          queue.paused = true;
          queue.pending.splice(0);
          queue.abort?.();
        } else {
          void sendRobotText(groupId, getDashboardConfig(), "当前没有正在处理的 Agent 任务。")
            .catch((err) => log.warn(`pause reply failed: ${String(err)}`));
        }
        return;
      }
      if ((command === "open" || command === "stop") && !isBotAuthorizedOperator(event, getDashboardConfig())) {
        log.debug(`ignored monitor command from unauthorized bot operator=${getSenderId(event)}`);
        return;
      }
      monitorCommandChain = monitorCommandChain
        .then(async () => {
          const requiresGroupRobot = command === "open" || command === "stop" ||
            (typeof command === "object" && command.type === "switch-agent");
          const hasRobot = await groupHasConfiguredRobot(groupId, getDashboardConfig());
          if (requiresGroupRobot && !hasRobot) {
            if (command === "open") {
              log.info(`open command needs bot installation group=${groupId} sender=${getSenderId(event)}`);
              const currentConfig = getDashboardConfig();
              if (!currentConfig.clientId.trim()) {
                log.warn(`ignored monitor open because client ID is missing group=${groupId}`);
                return;
              }
              const robotCode = currentConfig.clientId.trim();
              log.info(`adding configured bot to group=${groupId} robotCode=${robotCode}`);
              try {
                await addBotToGroup(groupId, robotCode);
                log.info(`configured bot added to group=${groupId}`);
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                log.error(`configured bot add failed group=${groupId}: ${reason}`);
                await sendDwsFallbackText(groupId, `AI 能力开启失败：配置机器人加入本群失败。\n失败原因：${reason}`)
                  .catch((notifyErr) => log.error(`DWS failure notification failed group=${groupId}: ${String(notifyErr)}`));
                return;
              }
            } else if (command === "stop") {
              // Stop must still remove the sender's own rule when the bot has
              // already been removed from the group; only the acknowledgement
              // depends on the bot being present.
              log.info(`stopping monitor rule without bot acknowledgement group=${groupId} sender=${getSenderId(event)}`);
            } else {
              log.info(`ignored command because configured robot is not in group=${groupId}`);
              return;
            }
          }
          if (command === "stop") queues.get(groupId)?.pending.splice(0);
          await handleMonitorCommand(command, event, groupId, getDashboardConfig, updateDashboardConfig, hasRobot);
        })
        .catch((err) => log.error(`monitor command failed: ${String(err)}`));
      return;
    }
    if (!acceptsTarget(event, config)) {
      log.info(`group message ignored by rule group=${groupId} sender=${getSenderId(event)} configuredSenders=${config.targets.filter((target) => target.groupId === groupId).map((target) => target.senderId).join(",") || "<none>"} event=${event.event_id || "unknown"}`);
      return;
    }
    void enqueueGroupEvent(event, groupId, queues, cardState, sessions, cardClient, getDashboardConfig, replies, liveReplies, runtime)
      .catch((err) => log.error(String(err)));
  };

  rl.on("line", (line) => {
    try {
      acceptEvent(JSON.parse(line) as DwsMessageEvent);
    } catch {
      log.warn(`ignored non-JSON event output: ${line.slice(0, 240)}`);
    }
  });

  // Keep the event stream for low-latency delivery, but also poll group history
  // as a reliability fallback. DWS may omit messages sent by the currently
  // authenticated user from the event stream, and a short overlap protects the
  // gap between two history queries. eventKey() makes the two sources safe to
  // combine without running the same message twice.
  let historyPollInFlight = false;
  const pollHistory = async () => {
    if (historyPollInFlight) return;
    historyPollInFlight = true;
    try {
      // Use a fixed short lookback instead of an ever-advancing cursor. If the
      // history API is unavailable for a long time, recovery will still query
      // only the recent window rather than replaying a large backlog.
      const from = new Date(Date.now() - historyLookbackMs);
      const groupIds = configuredGroupIds(getDashboardConfig());
      for (const groupId of groupIds) {
        const messages = await listGroupMessages(groupId, from);
        messages.filter((event) => isCurrentDwsUser(event, currentDwsUser)).forEach((event) => acceptEvent(event));
      }
    } finally {
      historyPollInFlight = false;
    }
  };
  const historyPollTimer = setInterval(() => {
    void pollHistory().catch((err) => log.warn(`history poll failed: ${String(err)}`));
  }, historyPollIntervalMs);
  historyPollTimer.unref();

  // The DWS event stream may omit messages sent by the account used to log in.
  // Poll recent messages from every known conversation as a second path so
  // that this account can also use @person open/stop binding commands. Normal
  // messages are still discarded by acceptEvent() unless they match a rule.
  let mentionPollInFlight = false;
  const pollMentionCommands = async () => {
    if (mentionPollInFlight) return;
    mentionPollInFlight = true;
    try {
      const conversations = await listConversations();
      const groupIds = [...new Set(conversations
        .map((conversation) => conversation.openConversationId?.trim())
        .filter((id): id is string => Boolean(id)))];
      const configuredIds = configuredGroupIds(getDashboardConfig());
      for (const groupId of [...new Set([...configuredIds, ...groupIds])]) {
        try {
          const messages = await listGroupMessages(groupId, new Date(Date.now() - historyLookbackMs));
          messages.filter((event) => isCurrentDwsUser(event, currentDwsUser)).forEach((event) => {
            const content = (event.content || event.text || "").trim();
            if (parseMentionMonitorCommand(content, getDashboardConfig().commandKeywords)) acceptEvent(event);
          });
        } catch (err) {
          log.debug(`mention command poll skipped group=${groupId}: ${String(err)}`);
        }
      }
    } finally {
      mentionPollInFlight = false;
    }
  };
  const mentionPollTimer = setInterval(() => {
    void pollMentionCommands().catch((err) => log.warn(`mention command poll failed: ${String(err)}`));
  }, mentionPollIntervalMs);
  mentionPollTimer.unref();

  return new Promise<void>((resolve, reject) => {
    listener.on("error", (err) => {
      runtime.eventConnected = false;
      log.error(`DWS group event stream error: ${String(err)}`);
      reject(err);
    });
    listener.on("close", (code) => {
      runtime.eventConnected = false;
      clearInterval(historyPollTimer);
      clearInterval(mentionPollTimer);
      const close = code === 0
        ? Promise.resolve()
        : Promise.reject(new Error(`dws event consume exited with code ${code}`));
      close.then(resolve).catch(reject);
    });
  });
}

async function main(): Promise<void> {
  const releaseLock = await acquireListenerLock();
  let lockReleased = false;
  const shutdown = () => {
    if (lockReleased) return;
    lockReleased = true;
    void releaseLock();
  };
  process.once("exit", () => {
    try {
      unlinkSync(LISTENER_LOCK_FILE);
    } catch {
      // The lock is already absent or was removed by a replacement process.
    }
  });
  process.once("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });
  const seen = new Set<string>();
  const queues = new Map<string, GroupQueue>();
  const cardState = await loadCardState();
  const sessions = new Map<string, string>();
  const cardClient = new DingTalkCardClient();
  let dashboardConfig = await loadDashboardConfig();
  const applyDashboardConfig = async (config: DashboardConfig): Promise<void> => {
    await saveDashboardConfig(config);
    dashboardConfig = config;
    cardClient.setCredentials(config.clientId, config.clientSecret);
    cardClient.setRobotCode(config.clientId);
    log.info(`dashboard config applied: ${configuredGroupIds(config).length} group(s), ${config.targets.length} rule(s)`);
  };
  await saveDashboardConfig(dashboardConfig);
  const dashboardServerConfig = await loadDashboardServerConfig();
  cardClient.setCredentials(dashboardConfig.clientId, dashboardConfig.clientSecret);
  cardClient.setRobotCode(dashboardConfig.clientId);
  const replies = await loadReplyHistory();
  const liveReplies = new Map<string, ReplyRecord>();
  // The bot worker writes personal-chat logs in the same daily files. Reload
  // them periodically so the dashboard can show personal and group exchanges
  // without requiring a listener restart.
  const reloadReplyHistory = async () => {
    const latest = await loadReplyHistory();
    const byId = new Map([...replies, ...latest].map((reply) => [reply.id, reply]));
    replies.splice(0, replies.length, ...Array.from(byId.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100));
  };
  const replyReloadTimer = setInterval(() => {
    void reloadReplyHistory().catch((err) => log.warn(`reply history reload failed: ${String(err)}`));
  }, 1_000);
  replyReloadTimer.unref();
  const runtime: ListenerRuntime = {
    startedAt: new Date().toISOString(),
    eventConnected: false,
    activeBatches: 0,
  };
  startDashboard(dashboardServerConfig.port, {
    getConfig: () => dashboardConfig,
    updateConfig: applyDashboardConfig,
    getStatus: (): DashboardStatus => ({ ...runtime }),
    getReplies: () => [...liveReplies.values(), ...replies],
    searchGroups,
    listGroupMembers,
    searchUsers,
    searchBots,
    getCurrentDwsUser: async () => {
      const [user, auth] = await Promise.all([getCurrentDwsUser(), getDwsAuthStatus()]);
      return { ...user, auth };
    },
    getDwsAuthStatus,
    startDwsDeviceLogin,
    getDwsDeviceLoginOutput,
    logoutDws,
    getBotStatus: async () => {
      const enabled = dashboardConfig.privateChatEnabled !== false;
      try {
        const value = JSON.parse(await readFile(join(DATA_DIR, "omi-bot-status.json"), "utf8")) as { connected?: boolean; updatedAt?: string };
        return { enabled, connected: enabled && value.connected !== false, updatedAt: value.updatedAt };
      } catch {
        return { enabled, connected: false };
      }
    },
  }, { host: dashboardServerConfig.host });
  log.info(`dashboard started at http://${dashboardServerConfig.host}:${dashboardServerConfig.port}`);
  log.info(`monitoring ${configuredGroupIds(dashboardConfig).length} group(s) with ${dashboardConfig.targets.length} rule(s)`);
  try {
    await startGroupListener(seen, queues, cardState, sessions, cardClient, () => dashboardConfig, applyDashboardConfig, replies, liveReplies, runtime);
  } finally {
    clearInterval(replyReloadTimer);
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
