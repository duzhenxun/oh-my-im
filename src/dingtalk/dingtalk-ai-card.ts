import { randomUUID } from "node:crypto";
import { createLogger } from "../core/logger.js";

const log = createLogger("DingTalkAiCard");
const apiBase = "https://api.dingtalk.com";
// 模板里用于展示结束语的变量名。
const END_TEXT_KEY = "end_text";

/** 5xx 与网络错误可重试；4xx 业务错误不重试。 */
function isRetryableCardError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const status = /API failed:\s*(\d{3})/.exec(message)?.[1];
  if (status) return Number(status) >= 500;
  return true;
}

/**
 * 钉钉 AI 卡片（流式卡片）客户端。
 *
 * 与内置的 StandardCard 不同，AI 卡片需要在卡片平台手工创建模板（消息卡片 +
 * 场景「AI 卡片」，并在 Markdown 组件上开启流式开关、绑定一个变量名）。流程：
 *   1. POST /v1.0/card/instances/createAndDeliver  投放卡片，进入「处理中」状态
 *   2. PUT  /v1.0/card/streaming                   反复推送全量 markdown，进入「输入中」
 *   3. 最后一帧 isFinalize=true（完成）或 isError=true（失败）
 *
 * 依赖权限：Card.Instance.Write（投放）+ Card.Streaming.Write（流式更新）。
 */
export class DingTalkAiCardClient {
  private accessToken?: string;
  private accessTokenExpiresAt = 0;
  private clientId = "";
  private clientSecret = "";
  private robotCode = "";
  // Last streamed content length per card, used to type out content that the
  // agent produced in one burst instead of as incremental deltas.
  private readonly streamedLengths = new Map<string, number>();

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

  get robotCodeValue(): string {
    return this.robotCode;
  }

  /** 投放一张群聊 AI 卡片。outTrackId 由调用方生成，后续流式更新必须复用。 */
  async createForGroup(params: {
    outTrackId: string;
    templateId: string;
    contentKey: string;
    openConversationId: string;
    title?: string;
  }): Promise<void> {
    await this.createAndDeliver({
      cardTemplateId: params.templateId,
      outTrackId: params.outTrackId,
      cardData: { cardParamMap: { [params.contentKey]: "", [END_TEXT_KEY]: "", ...(params.title ? { title: params.title } : {}) } },
      openSpaceId: `dtv1.card//IM_GROUP.${params.openConversationId}`,
      imGroupOpenSpaceModel: { supportForward: true },
      imGroupOpenDeliverModel: { robotCode: this.robotCode },
      userIdType: 1,
    });
    log.info(`ai card delivered group=${params.openConversationId} outTrackId=${params.outTrackId}`);
  }

  /** 投放一张机器人单聊 AI 卡片。 */
  async createForSingle(params: {
    outTrackId: string;
    templateId: string;
    contentKey: string;
    userId: string;
    title?: string;
  }): Promise<void> {
    await this.createAndDeliver({
      cardTemplateId: params.templateId,
      outTrackId: params.outTrackId,
      cardData: { cardParamMap: { [params.contentKey]: "", [END_TEXT_KEY]: "", ...(params.title ? { title: params.title } : {}) } },
      openSpaceId: `dtv1.card//IM_ROBOT.${params.userId}`,
      imRobotOpenSpaceModel: { supportForward: false },
      imRobotOpenDeliverModel: { spaceType: "IM_ROBOT", robotCode: this.robotCode },
      userIdType: 1,
    });
    log.info(`ai card delivered single user=${params.userId} outTrackId=${params.outTrackId}`);
  }

  /**
   * 流式更新。markdown 场景必须使用全量内容且 isFull=true；最后一帧传
   * isFinalize=true，异常传 isError=true。
   */
  async stream(params: {
    outTrackId: string;
    contentKey: string;
    content: string;
    isFinalize?: boolean;
    isError?: boolean;
  }): Promise<void> {
    log.info(`ai card stream outTrackId=${params.outTrackId} len=${params.content.length}${params.isFinalize ? " FINALIZE" : ""}${params.isError ? " ERROR" : ""}`);
    // guid 在重试时保持不变，保证服务端幂等；钉钉流式接口偶发返回 500，
    // 尤其首帧与 finalize 帧，重试可以显著降低卡片空白/卡在输入中的概率。
    await this.callWithRetry("PUT", "/v1.0/card/streaming", {
      outTrackId: params.outTrackId,
      guid: randomUUID(),
      key: params.contentKey,
      content: params.content,
      isFull: true,
      isFinalize: params.isFinalize === true,
      isError: params.isError === true,
    });
    this.streamedLengths.set(params.outTrackId, params.content.length);
    if (params.isFinalize || params.isError) this.streamedLengths.delete(params.outTrackId);
  }

  /**
   * 若最终内容比已经流式推送过的内容更长（模型一次性吐出整段），按几帧逐步
   * 补推剩余内容，保证卡片仍然呈现“打字机”效果；已经逐字流过的则几乎不做额外请求。
   */
  async typeOutRemaining(params: {
    outTrackId: string;
    contentKey: string;
    content: string;
    maxFrames?: number;
    maxDurationMs?: number;
  }): Promise<void> {
    const already = this.streamedLengths.get(params.outTrackId) ?? 0;
    if (params.content.length <= already + 1) return;
    const remaining = params.content.length - already;
    const frames = Math.max(1, Math.min(params.maxFrames ?? 8, remaining));
    const step = Math.max(1, Math.ceil(remaining / frames));
    const delayMs = Math.max(0, Math.floor((params.maxDurationMs ?? 1_200) / frames));
    for (let end = already + step; end < params.content.length; end += step) {
      await this.stream({ outTrackId: params.outTrackId, contentKey: params.contentKey, content: params.content.slice(0, end) });
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  /**
   * 按 key 更新卡片变量（不覆盖其它变量）。用于完成后把标题改成
   * 「【Pi】完成 总耗时 15s」这类状态文案。
   */
  async updateTitle(params: { outTrackId: string; title: string }): Promise<void> {
    await this.updateCardData({ outTrackId: params.outTrackId, data: { title: params.title } });
    log.info(`ai card title updated outTrackId=${params.outTrackId} title=${params.title}`);
  }

  /**
   * 完成后把「模型 x条消息 y次工具」这类结束语写到模板的 $end_text，
   * 不再拼接到正文里。
   */
  async setEndText(params: { outTrackId: string; text: string }): Promise<void> {
    await this.updateCardData({ outTrackId: params.outTrackId, data: { [END_TEXT_KEY]: params.text } });
    log.info(`ai card end_text updated outTrackId=${params.outTrackId} len=${params.text.length}`);
  }

  /** 按 key 更新一个或多个卡片变量，其它变量保持不变。 */
  async updateCardData(params: { outTrackId: string; data: Record<string, string> }): Promise<void> {
    await this.callWithRetry("PUT", "/v1.0/card/instances", {
      outTrackId: params.outTrackId,
      cardData: { cardParamMap: params.data },
      cardUpdateOptions: { updateCardDataByKey: true },
      userIdType: 1,
    });
  }

  private async createAndDeliver(body: Record<string, unknown>): Promise<void> {
    await this.call("POST", "/v1.0/card/instances/createAndDeliver", body);
  }

  /** 对 5xx / 网络错误做指数退避重试；4xx 业务错误不重试。 */
  private async callWithRetry(method: string, path: string, body: Record<string, unknown>, attempts = 3): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.call(method, path, body);
      } catch (err) {
        lastError = err;
        if (attempt === attempts - 1 || !isRetryableCardError(err)) throw err;
        const delayMs = 250 * 2 ** attempt;
        log.warn(`ai card API retry ${attempt + 1}/${attempts - 1} in ${delayMs}ms: ${err instanceof Error ? err.message : String(err)}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
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
    if (!response.ok) throw new Error(`DingTalk AI card API failed: ${response.status} ${text.slice(0, 1_000)}`);
    if (!text) return {};
    const result = JSON.parse(text) as Record<string, unknown>;
    const code = result.errcode ?? result.errorCode ?? result.code;
    if (
      (typeof code === "number" && code !== 0) ||
      (typeof code === "string" && code && code !== "0" && code.toLowerCase() !== "ok") ||
      result.success === false
    ) {
      throw new Error(`DingTalk AI card business error: ${text.slice(0, 1_000)}`);
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
    this.accessTokenExpiresAt = Date.now() + Math.max((result.expireIn ?? 7200) - 120, 60) * 1_000;
    return result.accessToken;
  }
}
