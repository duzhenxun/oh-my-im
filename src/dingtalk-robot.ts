let accessToken: { value: string; expiresAt: number; clientId: string } | undefined;

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

/** Send a plain-text group message through the DingTalk application robot OpenAPI. */
export async function sendRobotGroupText(
  groupId: string,
  content: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const token = await getAccessToken(clientId, clientSecret);
  const response = await fetch("https://api.dingtalk.com/v1.0/robot/groupMessages/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-acs-dingtalk-access-token": token,
    },
    body: JSON.stringify({
      // For an enterprise internal application robot, robotCode is the
      // application's Client ID (AppKey).
      robotCode: clientId,
      openConversationId: groupId,
      msgKey: "sampleText",
      msgParam: JSON.stringify({ content }),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`机器人 OpenAPI 发送失败：${response.status} ${body.slice(0, 1_000)}`);
  if (!body) return;
  const result = JSON.parse(body) as { success?: boolean; errcode?: number; errmsg?: string };
  if (result.success === false || (typeof result.errcode === "number" && result.errcode !== 0)) {
    throw new Error(`机器人 OpenAPI 发送失败：${result.errmsg || body.slice(0, 1_000)}`);
  }
}
