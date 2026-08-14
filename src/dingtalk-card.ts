import { createLogger } from "./logger.js";

const log = createLogger("DingTalkCard");
const apiBase = "https://api.dingtalk.com";

export interface CardReplyHandle {
  groupId: string;
  cardBizId: string;
}

function buildCardData(title: string, content: string): string {
  return JSON.stringify({
    config: { autoLayout: true, enableForward: true },
    header: {
      title: { type: "text", text: title.trim() || "映客活动AI" },
      logo: "@lALPDfJ6V_FPDmvNAfTNAfQ",
    },
    contents: [{ type: "markdown", text: content.trim() || "处理中...", id: "content" }],
  });
}

export class DingTalkCardClient {
  private accessToken?: string;
  private accessTokenExpiresAt = 0;
  private robotCode: string;
  private clientId?: string;
  private clientSecret?: string;

  constructor(
    clientId = "",
    clientSecret = "",
    robotCode = "dingn9wrup8mqq1ptabn",
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.robotCode = robotCode;
  }

  setCredentials(clientId: string, clientSecret: string): void {
    const nextClientId = clientId.trim();
    const nextClientSecret = clientSecret.trim();
    if (this.clientId === nextClientId && this.clientSecret === nextClientSecret) return;
    this.clientId = nextClientId;
    this.clientSecret = nextClientSecret;
    this.accessToken = undefined;
    this.accessTokenExpiresAt = 0;
  }

  setRobotCode(robotCode: string): void {
    this.robotCode = robotCode.trim();
  }

  get enabled(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.robotCode);
  }

  async create(groupId: string, cardBizId: string, title: string, content: string): Promise<CardReplyHandle> {
    if (!this.enabled) {
      throw new Error("映客活动AI 卡片未启用：DINGTALK_CLIENT_ID 或 DINGTALK_CLIENT_SECRET 缺失");
    }

    try {
      await this.call("POST", "/v1.0/im/v1.0/robot/interactiveCards/send", {
        cardTemplateId: "StandardCard",
        cardBizId,
        outTrackId: cardBizId,
        robotCode: this.robotCode,
        openConversationId: groupId,
        cardData: buildCardData(title, content),
      });
      log.info(`card started group=${groupId} card=${cardBizId}`);
      return { groupId, cardBizId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`card start failed: ${message}`);
      throw new Error(`映客活动AI 卡片发送失败：${message}`);
    }
  }

  async update(handle: CardReplyHandle, title: string, content: string): Promise<void> {
    await this.call("PUT", "/v1.0/im/robots/interactiveCards", {
      cardBizId: handle.cardBizId,
      cardData: buildCardData(title, content),
    });
    log.debug(`card updated group=${handle.groupId} card=${handle.cardBizId}`);
  }

  private async call(method: string, path: string, body: Record<string, unknown>): Promise<unknown> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`DingTalk card API failed: ${response.status} ${text}`);
    if (!text) return {};
    const result = JSON.parse(text) as Record<string, unknown>;
    const code = result.errcode ?? result.errorCode ?? result.code;
    if (
      (typeof code === "number" && code !== 0) ||
      (typeof code === "string" && code && code !== "0" && code.toLowerCase() !== "ok") ||
      result.success === false
    ) {
      throw new Error(`DingTalk card business error: ${text.slice(0, 1_000)}`);
    }
    return result;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) return this.accessToken;
    if (!this.clientId || !this.clientSecret) throw new Error("DingTalk app credentials are missing");

    const response = await fetch(`${apiBase}/v1.0/oauth2/accessToken`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appKey: this.clientId, appSecret: this.clientSecret }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`DingTalk token API failed: ${response.status}`);
    const result = JSON.parse(text) as { accessToken?: string; expireIn?: number };
    if (!result.accessToken) throw new Error("DingTalk token API returned no accessToken");
    this.accessToken = result.accessToken;
    this.accessTokenExpiresAt = Date.now() + Math.max((result.expireIn ?? 7200) - 120, 60) * 1000;
    return result.accessToken;
  }
}
