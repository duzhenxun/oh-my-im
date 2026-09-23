import { randomUUID } from "node:crypto";
import type { Logger } from "../core/logger.js";
import { DingTalkAiCardClient } from "./dingtalk-ai-card.js";

export interface AiCardSessionOptions {
  client: DingTalkAiCardClient;
  templateId: string;
  contentKey: string;
  log: Logger;
  /** 复用已有卡片（例如重启后关闭残留的卡片），不传则自动生成。 */
  outTrackId?: string;
}

export interface AiCardFinishOptions {
  /** 已格式化好的 Markdown 正文（调用方先完成表格转换等处理）。 */
  content: string;
  /** 完成 / 处理暂停 / 处理失败 的状态标题。 */
  title: string;
  /** 写入模板 $end_text 的结束语，例如「deepseek-v4.1-flash 1条消息,1次工具」。 */
  endText?: string;
  /** true 表示暂停/失败，发送 isError 帧进入「失败」状态。 */
  error?: boolean;
}

/**
 * 一张 AI 卡片的完整生命周期封装：投放 → 流式推送（含打字机补帧）→ 收尾
 * （finalize + $end_text + $title），并内置接口失败时的降级。
 *
 * 与底层 {@link DingTalkAiCardClient} 分开：客户端只管钉钉 API 协议，本类
 * 只管「一张卡片」的业务流程，让私聊（bot-app）和群聊（group-worker）
 * 共用同一套逻辑，后续要改 AI 卡片行为只需要动这一个文件。
 */
export class AiCardSession {
  readonly outTrackId: string;
  private readonly client: DingTalkAiCardClient;
  private readonly templateId: string;
  private readonly contentKey: string;
  private readonly log: Logger;

  constructor(options: AiCardSessionOptions) {
    this.client = options.client;
    this.templateId = options.templateId;
    this.contentKey = options.contentKey;
    this.log = options.log;
    this.outTrackId = options.outTrackId ?? randomUUID();
  }

  /** 投放一张群聊卡片。 */
  async openForGroup(params: { openConversationId: string; title?: string }): Promise<void> {
    await this.client.createForGroup({
      outTrackId: this.outTrackId,
      templateId: this.templateId,
      contentKey: this.contentKey,
      openConversationId: params.openConversationId,
      title: params.title,
    });
  }

  /** 投放一张机器人单聊卡片。 */
  async openForSingle(params: { userId: string; title?: string }): Promise<void> {
    await this.client.createForSingle({
      outTrackId: this.outTrackId,
      templateId: this.templateId,
      contentKey: this.contentKey,
      userId: params.userId,
      title: params.title,
    });
  }

  /** 中间帧：逐帧补推增量，尽量呈现打字机效果；失败只记日志，不影响主流程。 */
  async push(content: string): Promise<void> {
    await this.client
      .typeOutRemaining({ outTrackId: this.outTrackId, contentKey: this.contentKey, content, maxFrames: 5, maxDurationMs: 400 })
      .catch((err) => this.log.warn(`AI card stream skipped: ${String(err)}`));
  }

  /** 用 isError 关闭一张残留的卡片（例如进程重启后卡片停在「输入中」）。 */
  async closeStale(): Promise<void> {
    await this.client
      .stream({ outTrackId: this.outTrackId, contentKey: this.contentKey, content: "", isError: true })
      .catch((err) => this.log.warn(`stale AI card finalize skipped: ${String(err)}`));
  }

  /**
   * 收尾：finalize 正文 + 写 $end_text + 改 $title。
   * @returns 正文是否成功写入卡片；false 表示调用方应改用文本兜底。
   */
  async finish(options: AiCardFinishOptions): Promise<boolean> {
    const isError = options.error === true;
    let contentDelivered = true;
    try {
      if (!isError) {
        await this.client
          .typeOutRemaining({ outTrackId: this.outTrackId, contentKey: this.contentKey, content: options.content })
          .catch((err) => this.log.warn(`AI card type-out skipped: ${String(err)}`));
      }
      // 必须在 finalize 之前写入 $end_text：卡片进入「完成」状态那一刻就会渲染，
      // 之后再改变量部分模板不会重新渲染。
      if (!isError && options.endText) {
        await this.client
          .setEndText({ outTrackId: this.outTrackId, text: options.endText })
          .catch((err) => this.log.warn(`AI card end_text update skipped: ${String(err)}`));
      }
      await this.client.stream({
        outTrackId: this.outTrackId,
        contentKey: this.contentKey,
        content: options.content,
        isFinalize: !isError,
        isError,
      });
    } catch (err) {
      // 流式接口失败时用实例更新接口兜底写正文，避免卡片停留在空白/输入中。
      this.log.warn(`AI card finalize failed: ${String(err)}`);
      contentDelivered = await this.client
        .updateCardData({ outTrackId: this.outTrackId, data: { [this.contentKey]: options.content } })
        .then(() => true)
        .catch((updateErr) => {
          this.log.warn(`AI card content fallback skipped: ${String(updateErr)}`);
          return false;
        });
    }
    await this.client
      .updateTitle({ outTrackId: this.outTrackId, title: options.title })
      .catch((err) => this.log.warn(`AI card title update skipped: ${String(err)}`));
    return contentDelivered;
  }
}
