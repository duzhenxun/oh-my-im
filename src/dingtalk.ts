import { DWClient, TOPIC_ROBOT, type DWClientDownStream, type RobotMessage } from "dingtalk-stream";
import type { Config } from "./config.js";
import { createLogger } from "./logger.js";

export interface DingTalkTextMessage {
  callbackId: string;
  conversationId: string;
  sessionWebhook: string;
  senderId: string;
  senderStaffId?: string;
  senderNick?: string;
  text: string;
  msgtype: string;
}

type RobotPayload = RobotMessage & Record<string, unknown>;
const log = createLogger("DingTalk");

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
        this.ack(data.headers.messageId, { ignored: true });
        return;
      }

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
    if (!webhook) throw new Error(`No sessionWebhook for conversation: ${conversationId}`);

    const accessToken = await this.getAccessToken();
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
      throw new Error(`DingTalk reply failed: ${res.status} ${text}`);
    }
    log.debug(`Sent DingTalk text to conversation=${conversationId}`);
  }

  private parseMessage(data: DWClientDownStream): DingTalkTextMessage | null {
    let payload: RobotPayload;
    try {
      payload = JSON.parse(data.data) as RobotPayload;
    } catch {
      log.warn("Failed to parse DingTalk payload");
      return null;
    }

    const conversationId = payload.conversationId;
    const sessionWebhook = payload.sessionWebhook;
    const senderStaffId = payload.senderStaffId;
    const senderId = payload.senderId;
    const msgtype = payload.msgtype;
    const textPayload = payload.text as { content?: string } | undefined;
    const text = msgtype === "text" ? textPayload?.content?.trim() ?? "" : "";

    if (
      typeof conversationId !== "string" ||
      typeof sessionWebhook !== "string" ||
      typeof senderId !== "string" ||
      typeof msgtype !== "string"
    ) {
      return null;
    }

    this.webhooks.set(conversationId, sessionWebhook);

    return {
      callbackId: data.headers.messageId,
      conversationId,
      sessionWebhook,
      senderId,
      senderStaffId: typeof senderStaffId === "string" ? senderStaffId : undefined,
      senderNick: typeof payload.senderNick === "string" ? payload.senderNick : undefined,
      text,
      msgtype,
    };
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
