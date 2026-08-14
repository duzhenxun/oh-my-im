import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { DWClient, TOPIC_ROBOT, type DWClientDownStream, type RobotMessage } from "dingtalk-stream";
import type { Config } from "./config.js";
import { createLogger } from "./logger.js";

export interface DingTalkAttachment {
  type: "picture" | "audio" | "video" | "file";
  downloadCode: string;
  fileName?: string;
  duration?: number;
  recognition?: string;
}

export interface DownloadedAttachment extends DingTalkAttachment {
  path: string;
  size: number;
  contentType?: string;
}

export interface DingTalkTextMessage {
  callbackId: string;
  conversationId: string;
  conversationType?: string;
  sessionWebhook: string;
  senderId: string;
  senderStaffId?: string;
  senderNick?: string;
  robotCode?: string;
  text: string;
  msgtype: string;
  attachments: DingTalkAttachment[];
}

export interface DingTalkReplyHandle {
  conversationId: string;
  mode: "card" | "text";
  cardBizId?: string;
}

type RobotPayload = RobotMessage & Record<string, unknown>;
const log = createLogger("DingTalk");

function safePreview(value: unknown, limit = 160): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export function isSingleConversation(type?: string): boolean {
  const normalized = type?.trim().toLowerCase();
  return normalized === "0" || normalized === "single" || normalized === "singlechat" || normalized === "oto";
}

function buildStandardCardData(title: string, content: string): string {
  const safeTitle = title.trim() || "Codex";
  const safeContent = content.trim() || "...";
  return JSON.stringify({
    config: { autoLayout: true, enableForward: true },
    header: {
      title: { type: "text", text: safeTitle },
      logo: "@lALPDfJ6V_FPDmvNAfTNAfQ",
    },
    contents: [
      { type: "markdown", text: safeContent, id: "content" },
    ],
  });
}

export function parseDingTalkMessage(data: DWClientDownStream): DingTalkTextMessage | null {
  let payload: RobotPayload;
  try {
    payload = JSON.parse(data.data) as RobotPayload;
  } catch {
    log.warn(`Failed to parse DingTalk payload: ${safePreview(data.data, 240)}`);
    return null;
  }

  const conversationId = payload.conversationId;
  const sessionWebhook = payload.sessionWebhook;
  const senderStaffId = payload.senderStaffId;
  const senderId = payload.senderId;
  const conversationType = payload.conversationType;
  const robotCode = payload.robotCode;
  const msgtype = payload.msgtype;
  const textPayload = asRecord(payload.text);
  const contentPayload = asRecord(payload.content);

  if (
    typeof conversationId !== "string" ||
    typeof sessionWebhook !== "string" ||
    typeof senderId !== "string" ||
    typeof msgtype !== "string"
  ) {
    return null;
  }

  const text = extractText(msgtype, textPayload, contentPayload);
  const attachments = extractAttachments(msgtype, contentPayload, payload);

  return {
    callbackId: data.headers.messageId,
    conversationId,
    conversationType: typeof conversationType === "string" ? conversationType : undefined,
    sessionWebhook,
    senderId,
    senderStaffId: typeof senderStaffId === "string" ? senderStaffId : undefined,
    senderNick: typeof payload.senderNick === "string" ? payload.senderNick : undefined,
    robotCode: typeof robotCode === "string" ? robotCode : undefined,
    text,
    msgtype,
    attachments,
  };
}

function extractText(msgtype: unknown, textPayload: Record<string, unknown>, contentPayload: Record<string, unknown>): string {
  const directText = asString(textPayload.content) ?? asString(contentPayload.text);
  if (directText) return directText;
  if (msgtype === "audio" || msgtype === "voice") return asString(contentPayload.recognition) ?? "";
  if (msgtype === "richText") {
    const richText = contentPayload.richText;
    if (!Array.isArray(richText)) return "";
    return richText
      .map((item) => asString(asRecord(item).text) ?? "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractAttachments(
  msgtype: string,
  contentPayload: Record<string, unknown>,
  payload: RobotPayload,
): DingTalkAttachment[] {
  const attachments: DingTalkAttachment[] = [];
  const seen = new Set<string>();
  const append = (typeValue: string, item: Record<string, unknown>) => {
    const type = normalizeAttachmentType(typeValue);
    const downloadCode = asString(item.downloadCode) ?? asString(item.pictureDownloadCode);
    if (!type || !downloadCode) return;
    if (seen.has(downloadCode)) return;
    seen.add(downloadCode);
    attachments.push({
      type,
      downloadCode,
      fileName: asString(item.fileName) ?? asString(item.name),
      duration: asNumber(item.duration),
      recognition: asString(item.recognition),
    });
  };

  append(msgtype, contentPayload);
  append(msgtype, asRecord(payload));

  if (msgtype === "richText" && Array.isArray(contentPayload.richText)) {
    for (const item of contentPayload.richText) {
      const record = asRecord(item);
      append(asString(record.type) ?? "picture", record);
    }
  }

  return attachments;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeAttachmentType(value: string): DingTalkAttachment["type"] | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "picture" || normalized === "image") return "picture";
  if (normalized === "audio" || normalized === "voice") return "audio";
  if (normalized === "video") return "video";
  if (normalized === "file") return "file";
  return undefined;
}

function fileExtension(attachment: DingTalkAttachment, contentType?: string): string {
  const fromName = attachment.fileName ? extname(attachment.fileName) : "";
  if (fromName) return fromName;
  if (attachment.type === "picture") {
    if (contentType?.includes("png")) return ".png";
    if (contentType?.includes("webp")) return ".webp";
    return ".jpg";
  }
  if (attachment.type === "audio") return ".amr";
  if (attachment.type === "video") return ".mp4";
  return ".bin";
}

function sanitizeFileName(name: string): string {
  const clean = basename(name).replace(/[^\w.-]+/g, "_");
  return clean || "attachment";
}

export class DingTalkBot {
  private client: DWClient | null = null;
  private readonly webhooks = new Map<string, string>();

  constructor(private readonly config: Config) {}

  async start(onMessage: (message: DingTalkTextMessage) => Promise<void>): Promise<void> {
    this.client = new DWClient({
      clientId: this.config.dingtalkClientId,
      clientSecret: this.config.dingtalkClientSecret,
      keepAlive: true,
      debug: false,
    });

    this.client.registerCallbackListener(TOPIC_ROBOT, async (data: DWClientDownStream) => {
      const message = this.parseMessage(data);
      if (!message) {
        log.warn("Ignored invalid DingTalk payload");
        log.debug(
          `downstream topic=${data.headers.topic} messageId=${data.headers.messageId} dataLen=${data.data.length}`,
        );
        this.ack(data.headers.messageId, { ignored: true });
        return;
      }

      log.info(
        `incoming conversation=${message.conversationId} msgtype=${message.msgtype} sender=${message.senderStaffId ?? message.senderId} textLen=${message.text.length} attachments=${message.attachments.length} hasWebhook=${Boolean(message.sessionWebhook)} hasRobotCode=${Boolean(message.robotCode)}`,
      );

      try {
        await onMessage(message);
        this.ack(message.callbackId, { handled: true });
      } catch (err) {
        console.error("[DingTalk] message handling failed:", err);
        this.ack(message.callbackId, { error: String(err) });
      }
    });

    await this.client.connect();
    console.log("[DingTalk] stream connected");
  }

  stop(): void {
    this.client?.disconnect();
    this.client = null;
    this.webhooks.clear();
  }

  async sendText(conversationId: string, content: string): Promise<void> {
    const webhook = this.webhooks.get(conversationId);
    if (!webhook) {
      log.warn(`No sessionWebhook for conversation=${conversationId}`);
      throw new Error(`No sessionWebhook for conversation: ${conversationId}`);
    }

    const accessToken = await this.getAccessToken();
    log.debug(`replying conversation=${conversationId} contentLen=${content.length}`);
    const res = await fetch(webhook, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify({
        msgtype: "text",
        text: { content },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text();
      log.warn(
        `reply failed conversation=${conversationId} status=${res.status} body=${safePreview(text)}`,
      );
      throw new Error(`DingTalk reply failed: ${res.status} ${text}`);
    }
    log.debug(`reply ok conversation=${conversationId} status=${res.status}`);
  }

  async sendThinkingCard(message: DingTalkTextMessage, content: string): Promise<DingTalkReplyHandle> {
    if (!message.robotCode) {
      await this.sendText(message.conversationId, content);
      return { conversationId: message.conversationId, mode: "text" };
    }

    const cardBizId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const body: Record<string, unknown> = {
      cardTemplateId: "StandardCard",
      cardBizId,
      outTrackId: cardBizId,
      robotCode: message.robotCode,
      cardData: buildStandardCardData("Codex - 执行中", content),
    };

    if (isSingleConversation(message.conversationType) && message.senderStaffId) {
      body.singleChatReceiver = JSON.stringify({ userid: message.senderStaffId });
    } else {
      body.openConversationId = message.conversationId;
    }

    try {
      await this.callOpenApi("POST", "/v1.0/im/v1.0/robot/interactiveCards/send", body);
      log.debug(`card sent conversation=${message.conversationId} cardBizId=${cardBizId}`);
      return { conversationId: message.conversationId, mode: "card", cardBizId };
    } catch (err) {
      log.warn(`card send failed, fallback to text: ${err instanceof Error ? err.message : String(err)}`);
      await this.sendText(message.conversationId, content);
      return { conversationId: message.conversationId, mode: "text" };
    }
  }

  async updateReply(
    handle: DingTalkReplyHandle,
    title: string,
    content: string,
    options: { fallbackToText?: boolean } = { fallbackToText: true },
  ): Promise<void> {
    if (handle.mode !== "card" || !handle.cardBizId) {
      await this.sendText(handle.conversationId, content);
      return;
    }

    try {
      await this.callOpenApi("PUT", "/v1.0/im/robots/interactiveCards", {
        cardBizId: handle.cardBizId,
        cardData: buildStandardCardData(title, content),
      });
      log.debug(`card updated conversation=${handle.conversationId} cardBizId=${handle.cardBizId}`);
    } catch (err) {
      log.warn(`card update failed${options.fallbackToText === false ? "" : ", fallback to text"}: ${err instanceof Error ? err.message : String(err)}`);
      if (options.fallbackToText !== false) {
        await this.sendText(handle.conversationId, content);
      }
    }
  }

  async downloadAttachments(message: DingTalkTextMessage): Promise<DownloadedAttachment[]> {
    if (message.attachments.length === 0) return [];
    if (!message.robotCode) {
      throw new Error("DingTalk media download requires robotCode, but this message did not include it");
    }

    const dir = resolve(this.config.codexWorkDir, ".oh-my-im", "media");
    await mkdir(dir, { recursive: true });

    const downloaded: DownloadedAttachment[] = [];
    for (let index = 0; index < message.attachments.length; index += 1) {
      const attachment = message.attachments[index];
      const result = await this.callOpenApi("POST", "/v1.0/robot/messageFiles/download", {
        downloadCode: attachment.downloadCode,
        robotCode: message.robotCode,
      });
      const resultRecord = asRecord(result);
      const downloadUrl = asString(resultRecord.downloadUrl) ?? asString(resultRecord.url);
      if (!downloadUrl) {
        throw new Error(`DingTalk media download response did not include downloadUrl: ${safePreview(result)}`);
      }

      const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) {
        throw new Error(`DingTalk media file download failed: ${res.status}`);
      }

      const contentType = res.headers.get("content-type") ?? undefined;
      const nameBase = attachment.fileName ? sanitizeFileName(attachment.fileName) : attachment.type;
      const withExt = extname(nameBase) ? nameBase : `${nameBase}${fileExtension(attachment, contentType)}`;
      const path = join(dir, `${Date.now()}-${index}-${withExt}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      await writeFile(path, buffer);
      const size = buffer.byteLength;
      downloaded.push({ ...attachment, path, size, contentType });
      log.info(`downloaded attachment type=${attachment.type} path=${path} size=${size || "unknown"}`);
    }

    return downloaded;
  }

  private parseMessage(data: DWClientDownStream): DingTalkTextMessage | null {
    const message = parseDingTalkMessage(data);
    if (!message) return null;

    this.webhooks.set(message.conversationId, message.sessionWebhook);
    log.debug(
      `parsed conversation=${message.conversationId} sender=${message.senderStaffId ?? message.senderId} msgtype=${message.msgtype} textLen=${message.text.length} attachments=${message.attachments.length} webhookLen=${message.sessionWebhook.length}`,
    );

    return message;
  }

  private async callOpenApi(method: string, path: string, body: Record<string, unknown>): Promise<unknown> {
    const accessToken = await this.getAccessToken();
    const res = await fetch(`https://api.dingtalk.com${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`DingTalk OpenAPI failed: ${res.status} ${text}`);
    if (!text) return {};

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return text;
    }

    const code = parsed.errcode ?? parsed.errorCode ?? parsed.code;
    const success = parsed.success;
    if (
      (typeof code === "number" && code !== 0) ||
      (typeof code === "string" && code && code !== "0" && code.toLowerCase() !== "ok") ||
      success === false
    ) {
      throw new Error(`DingTalk OpenAPI business error: ${safePreview(parsed)}`);
    }
    return parsed;
  }

  private async getAccessToken(): Promise<string> {
    if (!this.client) throw new Error("DingTalk client is not initialized");
    return this.client.getAccessToken();
  }

  private ack(messageId: string, result: unknown): void {
    try {
      this.client?.socketCallBackResponse(messageId, result);
    } catch (err) {
      log.warn("DingTalk ack failed:", err);
    }
  }
}
