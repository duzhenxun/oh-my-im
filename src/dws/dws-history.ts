import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCurrentDwsUser, searchRecentGroupMessages, DwsTransientSearchError, type DwsMessageEvent } from "./dws-client.js";
import type { DashboardConfig } from "../dws-dashboard.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("personal_history");
const DEFAULT_INTERVAL_SECONDS = 15;
const DEFAULT_LOOKBACK_MINUTES = 10;
const DEFAULT_LIMIT = 10;
const CURSOR_DIR = join(homedir(), ".oh-my-im");
const CURSOR_FILE = join(CURSOR_DIR, "dws-history-cursor.json");
const MAX_SEEN_KEYS = 2_000;
// dws search lags behind delivery by a few seconds, so a resumed cursor is
// rewound a little instead of being trusted to the millisecond. Re-read
// messages are dropped by the seen-key set.
const INDEX_LAG_PAD_MS = 60_000;
const TRANSIENT_LOG_INTERVAL_MS = 600_000;

interface HistoryCursor {
  lastPollAt?: number;
  seenKeys?: string[];
}

export interface PersonalHistoryOptions {
  getConfig: () => DashboardConfig;
  acceptEvent: (event: DwsMessageEvent) => void;
}

/** Short local-time stamp so poll logs line up with the logger's own timestamps. */
function localStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function senderName(event: DwsMessageEvent): string {
  const sender = event.sender;
  if (!sender || typeof sender !== "object") return "";
  const value = sender as Record<string, unknown>;
  return [value.name, value.nick, value.displayName]
    .find((item): item is string => typeof item === "string" && Boolean(item.trim()))?.trim() || "";
}

function messageKey(event: DwsMessageEvent): string | undefined {
  const id = event.message_id || event.messageId || event.openMessageId;
  if (typeof id === "string" && id.trim()) return "id:" + id.trim();
  const sender = senderName(event);
  const content = (event.content || event.text || "").trim();
  const createdAt = event.create_time?.trim();
  if (!sender || !content || !createdAt) return undefined;
  return "fallback:" + sender + ":" + createdAt + ":" + content;
}

async function loadCursor(): Promise<HistoryCursor> {
  try {
    const value = JSON.parse(await readFile(CURSOR_FILE, "utf8")) as HistoryCursor;
    return {
      lastPollAt: Number.isFinite(value.lastPollAt) ? value.lastPollAt : undefined,
      seenKeys: Array.isArray(value.seenKeys)
        ? value.seenKeys.filter((key): key is string => typeof key === "string").slice(-MAX_SEEN_KEYS)
        : [],
    };
  } catch {
    return {};
  }
}

async function saveCursor(cursor: HistoryCursor): Promise<void> {
  await mkdir(CURSOR_DIR, { recursive: true });
  const temporary = CURSOR_FILE + "." + process.pid + ".tmp";
  await writeFile(temporary, JSON.stringify(cursor, null, 2) + "\n", "utf8");
  await rename(temporary, CURSOR_FILE);
}

/** Pull only the current DWS user's recent group messages as compensation. */
export function startPersonalHistoryPolling(options: PersonalHistoryOptions): () => void {
  let stopped = false;
  let polling = false;
  let currentName = "";
  const processStartedAt = Date.now();
  let lastPollStartedAt = processStartedAt;
  let lastPollAt: number | undefined;
  let resumed = false;
  let lastTransientLogAt = 0;
  const seenKeys = new Set<string>();
  let cursorLoaded = false;

  const poll = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    try {
      const config = options.getConfig();
      const interval = Number.isFinite(config.personalHistoryPollIntervalSeconds)
        ? config.personalHistoryPollIntervalSeconds : DEFAULT_INTERVAL_SECONDS;
      if (interval <= 0) return;
      if (!currentName) currentName = (await getCurrentDwsUser()).name?.trim() || "";
      if (!currentName) return;
      if (!cursorLoaded) {
        const cursor = await loadCursor();
        // The legacy cursor only stored lastMessageAt. The first poll after a
        // restart must begin at the current process start time.
        lastPollAt = cursor.lastPollAt ?? processStartedAt;
        resumed = cursor.lastPollAt !== undefined;
        (cursor.seenKeys ?? []).forEach((key) => seenKeys.add(key));
        cursorLoaded = true;
      }
      const minutes = config.personalHistoryLookbackMinutes || DEFAULT_LOOKBACK_MINUTES;
      const limit = config.personalHistoryMessageLimit || DEFAULT_LIMIT;
      const endAt = Math.floor(Date.now() / 1_000) * 1_000;
      const startAt = Math.min((lastPollAt ?? processStartedAt) - (resumed ? INDEX_LAG_PAD_MS : 0), endAt - 1_000);
      const start = new Date(startAt);
      const end = new Date(endAt);
      const messages = await searchRecentGroupMessages(currentName, minutes, limit, { start, end });
      const ownMessages = messages.filter((event) => senderName(event) === currentName);
      const freshMessages = ownMessages.filter((event) => {
        const key = messageKey(event);
        if (!key || seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });
      while (seenKeys.size > MAX_SEEN_KEYS) seenKeys.delete(seenKeys.values().next().value as string);
      lastPollAt = endAt;
      await saveCursor({ lastPollAt, seenKeys: [...seenKeys] });
      log.info("personal history poll messages=" + messages.length + " own=" + ownMessages.length + " fresh=" + freshMessages.length + " start=" + localStamp(start) + " end=" + localStamp(end) + " limit=" + limit);
      freshMessages.forEach(options.acceptEvent);
    } catch (err) {
      // dws sometimes cannot describe the search result at all. The cursor stays
      // put, so the next tick covers the same window again; only say so now and
      // then instead of warning on every poll.
      if (err instanceof DwsTransientSearchError) {
        if (Date.now() - lastTransientLogAt >= TRANSIENT_LOG_INTERVAL_MS) {
          lastTransientLogAt = Date.now();
          log.info("personal history poll deferred: " + err.message);
        }
        return;
      }
      log.warn(`personal history poll failed: ${String(err)}`);
    } finally {
      polling = false;
    }
  };

  void poll();
  const timer = setInterval(() => {
    const interval = Number(options.getConfig().personalHistoryPollIntervalSeconds);
    const intervalMs = Math.max(1, Number.isFinite(interval) ? interval : DEFAULT_INTERVAL_SECONDS) * 1_000;
    if (Date.now() - lastPollStartedAt < intervalMs) return;
    lastPollStartedAt = Date.now();
    void poll();
  }, 1_000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
