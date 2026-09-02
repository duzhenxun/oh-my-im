import { getCurrentDwsUser, listConversations, listGroupMessages, type DwsMessageEvent } from "./dws-client.js";
import type { DashboardConfig } from "./dws-dashboard.js";
import { createLogger } from "./logger.js";

const log = createLogger("DwsHistory");
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_GROUP_LIMIT = 10;

export interface DwsHistoryPollingOptions {
  getConfig: () => DashboardConfig;
  configuredGroupIds: (config: DashboardConfig) => string[];
  acceptEvent: (event: DwsMessageEvent) => void;
}

function senderName(event: DwsMessageEvent): string {
  const raw = event.sender as unknown;
  if (typeof raw === "string") return raw.trim();
  if (!raw || typeof raw !== "object") return "";
  const sender = raw as Record<string, unknown>;
  return [sender.name, sender.nick, sender.displayName]
    .find((value): value is string => typeof value === "string" && Boolean(value.trim()))
    ?.trim() || "";
}

function isCurrentUser(event: DwsMessageEvent, currentName?: string): boolean {
  return Boolean(currentName && senderName(event) === currentName);
}

/**
 * Single historical-message compensation loop.
 * It reads only the first ten group chats, keeps at most twenty messages per
 * group (the message client applies --limit 20), and only forwards messages
 * authored by the current DWS login account. All command classification,
 * de-duplication and permission checks remain in the listener's acceptEvent().
 */
export function startDwsHistoryPolling(options: DwsHistoryPollingOptions): () => void {
  let stopped = false;
  let polling = false;
  let currentName = "";

  const refreshCurrentUser = async () => {
    try {
      const user = await getCurrentDwsUser();
      currentName = user.name?.trim() || "";
      log.debug(`current DWS user for history name=${currentName || "<none>"}`);
    } catch (err) {
      log.warn(`unable to resolve current DWS user for history: ${String(err)}`);
    }
  };

  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      if (!currentName) await refreshCurrentUser();
      const config = options.getConfig();
      const intervalSeconds = Number.isFinite(config.historyPollIntervalSeconds) ? config.historyPollIntervalSeconds : DEFAULT_POLL_INTERVAL_SECONDS;
      if (intervalSeconds <= 0) return;
      const conversations = await listConversations();
      const allGroups = conversations
        .map((item) => item.openConversationId?.trim())
        .filter((id): id is string => Boolean(id));
      const groups = [...new Set([...options.configuredGroupIds(config), ...allGroups])].slice(0, config.historyGroupLimit || DEFAULT_GROUP_LIMIT);
      log.debug(`history poll groups=${groups.length}/${config.historyGroupLimit} messages=${config.historyMessageLimit} interval=${intervalSeconds}s currentUser=${currentName || "<none>"}`);
      for (const groupId of groups) {
        if (stopped) break;
        try {
          const messages = await listGroupMessages(groupId, new Date(Date.now() - 20_000), config.historyMessageLimit || 20);
          messages.filter((event) => isCurrentUser(event, currentName)).forEach(options.acceptEvent);
        } catch (err) {
          log.warn(`history poll group failed group=${groupId}: ${String(err)}`);
        }
      }
    } finally {
      polling = false;
    }
  };

  void poll();
  const timer = setInterval(() => { void poll(); }, Math.max(1, Number(options.getConfig().historyPollIntervalSeconds || DEFAULT_POLL_INTERVAL_SECONDS)) * 1_000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
