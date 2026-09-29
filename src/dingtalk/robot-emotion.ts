import { createLogger } from "../core/logger.js";

const log = createLogger("DingTalkRobotEmotion");
const apiBase = "https://api.dingtalk.com";
// 钉钉机器人表情接口用字符串 "1" 表示内置 emoji（表情列表里的 emotion_xxx）。
const EMOTION_TYPE_EMOJI = "1";

export interface RobotEmotion {
  /** 内置表情 ID，例如「思考」= emotion_040。 */
  emotionId?: string;
  /** 表情名称，例如「思考」。 */
  emotionName?: string;
}

/** 处理中贴在用户消息上的默认表情。 */
export const THINKING_EMOTION: RobotEmotion = { emotionId: "emotion_040", emotionName: "思考" };

export interface RobotEmotionTarget {
  openConversationId: string;
  openMsgId: string;
}

function isRetryableEmotionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const status = /API failed:\s*(\d{3})/.exec(message)?.[1];
  if (status) return Number(status) >= 500;
  return true;
}

/**
 * 机器人消息表情（贴表情）客户端。
 *
 * 普通消息模式不再额外发一条「正在分析...」，而是由机器人在用户消息上贴一个
 * 表情（如「思考」），完成后撤回，因此整个过程只发一条最终回复。
 *
 * 依赖钉钉 OpenAPI：
 *   POST /v1.0/robot/emotion/reply   贴表情（robotCode + openConversationId + openMsgId）
 * 需要应用具备机器人消息相关权限，并已把机器人加到对应会话。
 */
export class DingTalkRobotEmotionClient {
  private accessToken?: string;
  private accessTokenExpiresAt = 0;
  private clientId = "";
  private clientSecret = "";
  private robotCode = "";

  setCredentials(clientId: string, clientSecret: string, robotCode?: string): void {
    const nextClientId = clientId.trim();
    const nextClientSecret = clientSecret.trim();
    const nextRobotCode = (robotCode ?? clientId).trim();
    if (this.clientId === nextClientId && this.clientSecret === nextClientSecret && this.robotCode === nextRobotCode) return;
    this.clientId = nextClientId;
    this.clientSecret = nextClientSecret;
    this.robotCode = nextRobotCode;
    this.accessToken = undefined;
    this.accessTokenExpiresAt = 0;
  }

  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.robotCode);
  }

  /** 在用户消息上贴一个表情。 */
  async add(target: RobotEmotionTarget, emotion: RobotEmotion): Promise<void> {
    await this.call("/v1.0/robot/emotion/reply", target, emotion);
  }

  private async call(path: string, target: RobotEmotionTarget, emotion: RobotEmotion): Promise<void> {
    if (!this.configured) throw new Error("DingTalk robot emotion credentials are missing");
    const body: Record<string, unknown> = {
      robotCode: this.robotCode,
      openConversationId: target.openConversationId,
      openMsgId: target.openMsgId,
      emotionType: EMOTION_TYPE_EMOJI,
    };
    if (emotion.emotionId) body.emotionId = emotion.emotionId;
    if (emotion.emotionName) body.emotionName = emotion.emotionName;
    await this.callWithRetry(path, body);
  }

  private async callWithRetry(path: string, body: Record<string, unknown>, attempts = 3): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.request(path, body);
        return;
      } catch (err) {
        lastError = err;
        if (attempt === attempts - 1 || !isRetryableEmotionError(err)) throw err;
        const delayMs = 250 * 2 ** attempt;
        log.warn(`robot emotion retry ${attempt + 1}/${attempts - 1} in ${delayMs}ms: ${err instanceof Error ? err.message : String(err)}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  private async request(path: string, body: Record<string, unknown>): Promise<void> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`DingTalk robot emotion API failed: ${response.status} ${text.slice(0, 1_000)}`);
    if (!text) return;
    const result = JSON.parse(text) as Record<string, unknown>;
    const code = result.errcode ?? result.errorCode ?? result.code;
    if (
      (typeof code === "number" && code !== 0) ||
      (typeof code === "string" && code && code !== "0" && code.toLowerCase() !== "ok") ||
      result.success === false
    ) {
      throw new Error(`DingTalk robot emotion business error: ${text.slice(0, 1_000)}`);
    }
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
    this.accessTokenExpiresAt = Date.now() + Math.max((result.expireIn ?? 7200) - 120, 60) * 1_000;
    return result.accessToken;
  }
}
