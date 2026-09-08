import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationMessage, ReplyRecord } from "./dws-dashboard.js";

const LOG_ROOT = join(process.env.OHMIM_DATA_DIR?.trim() || join(process.env.HOME || ".", ".oh-my-im"), "replies");



function dateKey(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
}

function displayDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function appendRecord(directory: string, record: ReplyRecord): Promise<void> {
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${dateKey(record.createdAt)}.json`);
  const existing = await readFile(file, "utf8").then((text) => JSON.parse(text) as ReplyRecord[]).catch(() => []);
  const records = [record, ...existing.filter((item) => item.id !== record.id)];
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

/** Store a complete agent exchange in a human-readable, per-conversation directory. */
export async function appendConversationLog(
  record: ReplyRecord,
  messages?: ConversationMessage[],
): Promise<void> {
  const normalized = {
    ...(messages?.length ? { ...record, senderDetails: messages } : record),
    createdAt: displayDateTime(record.createdAt),
  };
  await appendRecord(LOG_ROOT, normalized);
}
