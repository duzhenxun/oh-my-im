import {
  getCurrentDwsUser,
  listConversations,
  listGroupMessages,
  type DwsMessageEvent,
} from "./dws-client.js";
import type { DashboardConfig } from "./dws-dashboard.js";
import { createLogger } from "./logger.js";

const log = createLogger("DwsHistory");

const HISTORY_POLL_INTERVAL_MS = 2_000;
const MENTION_POLL_INTERVAL_MS = 5_000;
const HISTORY_LOOKBACK_MS = 20_000;

export interface DwsHistoryPollingOptions {
  getConfig: () => DashboardConfig;
  configuredGroupIds: (config: DashboardConfig) => string[];
  parseMentionMonitorCommand: (content: string, keywords: DashboardConfig["commandKeywords"]) => "open" | "stop" | undefined;
  acceptEvent: (event: DwsMessageEvent) => void;
}

interface CurrentDwsUser {
  userId?: string;
  openDingTalkId?: string;
  name?: string;
}

function senderDisplayName(event: DwsMessageEvent): string {
  const sender = event.sender ?? {};
  return [sender.name, sender.nick, sender.displayName]
    .find((value): value is string => typeof value === "string" && Boolean(value.trim()))
    ?.trim() || "";
}

function senderId(event: DwsMessageEvent): string {
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

function isCurrentDwsUser(event: DwsMessageEvent, currentUser: CurrentDwsUser): boolean {
  const eventId = senderId(event).toLowerCase();
  const ids = [currentUser.userId, currentUser.openDingTalkId]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.toLowerCase());
  if (ids.includes(eventId)) return true;
  const eventName = senderDisplayName(event).toLowerCase();
  return Boolean(eventName && currentUser.name && eventName === currentUser.name.trim().toLowerCase());
}

function recentFrom(): Date {
  return new Date(Date.now() - HISTORY_LOOKBACK_MS);
}

/**
 * Historical-message compensation only.
 *
 * The live DWS event stream is intentionally not handled here. This module
 * only reads recent history for the currently logged-in DWS account:
 * - every 2 seconds: configured groups, for the account's key commands;
 * - every 5 seconds: all joined groups, only for @person open/stop binding.
 */
export function startDwsHistoryPolling(options: DwsHistoryPollingOptions): () => void {
  let stopped = false;
  let currentUser: CurrentDwsUser = {};
  let historyInFlight = false;
  let mentionInFlight = false;

  void getCurrentDwsUser()
    .then((user) => {
      if (stopped) return;
      currentUser = user;
      log.info(`current DWS user resolved id=${user.userId || user.openDingTalkId || "<none>"} name=${user.name || "<none>"}`);
    })
    .catch((err) => log.warn(`unable to resolve current DWS user: ${String(err)}`));

  const pollHistory = async (): Promise<void> => {
    if (stopped || historyInFlight) return;
    historyInFlight = true;
    try {
      for (const groupId of options.configuredGroupIds(options.getConfig())) {
        const messages = await listGroupMessages(groupId, recentFrom());
        messages
          .filter((event) => isCurrentDwsUser(event, currentUser))
          .forEach(options.acceptEvent);
      }
    } finally {
      historyInFlight = false;
    }
  };

  const pollMentionCommands = async (): Promise<void> => {
    if (stopped || mentionInFlight) return;
    mentionInFlight = true;
    try {
      const conversations = await listConversations();
      const allGroups = conversations
        .map((conversation) => conversation.openConversationId?.trim())
        .filter((id): id is string => Boolean(id));
      const groups = [...new Set([...options.configuredGroupIds(options.getConfig()), ...allGroups])];
      for (const groupId of groups) {
        try {
          const messages = await listGroupMessages(groupId, recentFrom());
          messages
            .filter((event) => isCurrentDwsUser(event, currentUser))
            .filter((event) => options.parseMentionMonitorCommand(
              (event.content || event.text || "").trim(),
              options.getConfig().commandKeywords,
            ))
            .forEach(options.acceptEvent);
        } catch (err) {
          log.debug(`mention command poll skipped group=${groupId}: ${String(err)}`);
        }
      }
    } finally {
      mentionInFlight = false;
    }
  };

  // Temporarily disabled: the live group event stream is the only active
  // source for command handling. Keep the implementation here for a later
  // opt-in history compensation pass after the event behavior is confirmed.
  /*
  void pollHistory().catch((err) => log.warn(`history poll failed: ${String(err)}`));
  void pollMentionCommands().catch((err) => log.warn(`mention command poll failed: ${String(err)}`));
  const historyTimer = setInterval(() => {
    void pollHistory().catch((err) => log.warn(`history poll failed: ${String(err)}`));
  }, HISTORY_POLL_INTERVAL_MS);
  const mentionTimer = setInterval(() => {
    void pollMentionCommands().catch((err) => log.warn(`mention command poll failed: ${String(err)}`));
  }, MENTION_POLL_INTERVAL_MS);
  historyTimer.unref();
  mentionTimer.unref();

  return () => {
    stopped = true;
    clearInterval(historyTimer);
    clearInterval(mentionTimer);
  };
  */
  return () => { stopped = true; };

}
