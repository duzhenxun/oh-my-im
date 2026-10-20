import { createLogger } from "../core/logger.js";

const log = createLogger("dingtalk_robot");

let accessToken: { value: string; expiresAt: number; clientId: string } | undefined;

const MARKDOWN_TITLE_MAX = 20;
// 某些企业/机器人只允许发纯文本（Markdown 会被接口拒绝）。记住这类机器人，
// 避免每条消息都先失败一次再重发，白白翻倍请求量。
const markdownUnsupportedRobots = new Set<string>();

interface RobotPayload {
  msgKey: string;
  msgParam: string;
}

interface RobotSendResponse {
  success?: boolean;
  errcode?: number;
  errmsg?: string;
  invalidStaffIdList?: string[];
}

/** 已经确认不能渲染 Markdown 时，只可能被格式拒绝的错误才值得用纯文本重发。 */
class RobotFormatRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RobotFormatRejected";
  }
}

/** 钉钉 Markdown 消息需要在通知栏显示标题，从正文第一行取一个短纯文本标题。 */
export function robotMarkdownTitle(content: string): string {
  const firstLine = content.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  const plain = firstLine
    .replace(/^[#>*\-\s]+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
  const title = plain || "回复";
  return title.length > MARKDOWN_TITLE_MAX ? `${title.slice(0, MARKDOWN_TITLE_MAX)}…` : title;
}

function markdownPayload(content: string): RobotPayload {
  return { msgKey: "sampleMarkdown", msgParam: JSON.stringify({ title: robotMarkdownTitle(content), text: content }) };
}

function textPayload(content: string): RobotPayload {
  return { msgKey: "sampleText", msgParam: JSON.stringify({ content }) };
}

/**
 * 「普通消息」回复默认按 Markdown 发送（加粗/列表/引用才能正常渲染）。
 * 接口或企业策略拒绝 Markdown 时自动降级为纯文本，保证消息一定发得出去。
 */
async function sendRobotMessage(
  robotCode: string,
  label: string,
  content: string,
  attempt: (payload: RobotPayload) => Promise<void>,
): Promise<void> {
  if (!markdownUnsupportedRobots.has(robotCode)) {
    try {
      await attempt(markdownPayload(content));
      return;
    } catch (err) {
      if (!(err instanceof RobotFormatRejected)) throw err;
      markdownUnsupportedRobots.add(robotCode);
      log.warn(`${label} Markdown 发送被拒绝，后续改用纯文本：${err.message.slice(0, 200)}`);
    }
  }
  await attempt(textPayload(content));
}

export async function sendRobotWebhookText(webhookUrl: string, content: string): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content } }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`机器人 Webhook 发送失败：${response.status} ${body.slice(0, 500)}`);
  if (!body) return;
  const result = JSON.parse(body) as { errcode?: number; errmsg?: string };
  if ((typeof result.errcode === "number" && result.errcode !== 0) || result.errmsg) {
    throw new Error(`机器人 Webhook 发送失败：${result.errmsg || body.slice(0, 500)}`);
  }
}

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  if (accessToken && accessToken.clientId === clientId && accessToken.expiresAt > Date.now()) return accessToken.value;
  const response = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`钉钉 Token 获取失败：${response.status} ${body.slice(0, 500)}`);
  const result = JSON.parse(body) as { accessToken?: string; expireIn?: number };
  if (!result.accessToken) throw new Error("钉钉 Token 接口未返回 accessToken");
  accessToken = {
    value: result.accessToken,
    clientId,
    expiresAt: Date.now() + Math.max((result.expireIn ?? 7200) - 120, 60) * 1_000,
  };
  return result.accessToken;
}

/** Send a group message through the DingTalk application robot OpenAPI (Markdown first, text fallback). */
export async function sendRobotGroupText(
  groupId: string,
  content: string,
  robotCode: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const token = await getAccessToken(clientId, clientSecret);
  const attempt = async (payload: RobotPayload): Promise<void> => {
    const response = await fetch("https://api.dingtalk.com/v1.0/robot/groupMessages/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-acs-dingtalk-access-token": token,
      },
      body: JSON.stringify({
        // The OpenAPI send endpoint expects the application's Client ID here.
        robotCode,
        openConversationId: groupId,
        msgKey: payload.msgKey,
        msgParam: payload.msgParam,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    if (!response.ok) throw new RobotFormatRejected(`机器人 OpenAPI 发送失败：${response.status} ${body.slice(0, 1_000)}`);
    if (!body) return;
    const result = JSON.parse(body) as RobotSendResponse;
    if (result.success === false || (typeof result.errcode === "number" && result.errcode !== 0)) {
      throw new RobotFormatRejected(`机器人 OpenAPI 发送失败：${result.errmsg || body.slice(0, 1_000)}`);
    }
  };
  await sendRobotMessage(clientId, "群聊回复", content, attempt);
}

/** Send a single-chat (person <-> robot) message through the robot OpenAPI (Markdown first, text fallback). */
export async function sendRobotSingleText(
  userId: string,
  content: string,
  robotCode: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const token = await getAccessToken(clientId, clientSecret);
  const attempt = async (payload: RobotPayload): Promise<void> => {
    const response = await fetch("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-acs-dingtalk-access-token": token,
      },
      body: JSON.stringify({
        robotCode,
        userIds: [userId],
        msgKey: payload.msgKey,
        msgParam: payload.msgParam,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    if (!response.ok) throw new RobotFormatRejected(`机器人单聊 OpenAPI 发送失败：${response.status} ${body.slice(0, 1_000)}`);
    if (!body) return;
    const result = JSON.parse(body) as RobotSendResponse;
    if (typeof result.errcode === "number" && result.errcode !== 0) {
      throw new RobotFormatRejected(`机器人单聊 OpenAPI 发送失败：${result.errmsg || body.slice(0, 1_000)}`);
    }
    // 200 只代表请求被接受；userIds 无效时消息不会送达，必须当作失败以便回退。
    // 这与消息格式无关，不能靠改成纯文本重发解决。
    if (Array.isArray(result.invalidStaffIdList) && result.invalidStaffIdList.length > 0) {
      throw new Error(`机器人单聊 OpenAPI 未送达：${result.invalidStaffIdList.join(",")}`);
    }
  };
  await sendRobotMessage(clientId, "单聊回复", content, attempt);
}
