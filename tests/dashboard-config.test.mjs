import test from "node:test";
import assert from "node:assert/strict";
import { startDashboard } from "../dist/dws-dashboard.js";

test("dashboard accepts an empty target list after the final group is stopped", async () => {
  let config = {
    targets: [{ groupId: "group", groupName: "群", senderId: "user", senderName: "人员" }],
    botAllowedUserIds: ["user"],
    replyFormat: "markdown",
    robotName: "机器人",
    clientId: "client",
    clientSecret: "secret",
    robotCode: "robot",
  };
  const server = startDashboard(0, {
    getConfig: () => config,
    updateConfig: async (next) => { config = next; },
    getStatus: () => ({ startedAt: "now", eventConnected: true, activeBatches: 0 }),
    getReplies: () => [],
    searchGroups: async () => [],
    listGroupMembers: async () => [],
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const response = await fetch(`http://127.0.0.1:${address.port}/api/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...config, targets: [], clientSecret: "" }),
  });
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));

  assert.equal(response.status, 200);
  assert.deepEqual(config.targets, []);
  assert.equal(config.clientSecret, "secret");
});
