import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMonitorCommand,
  parseMonitorCommand,
} from "../dist/monitor-command.js";

const AUTHORIZED_USER = "authorized-user";

const config = {
  targets: [{ groupId: "group-a", groupName: "已有群", senderId: "other", senderName: "其他人" }],
  botAllowedUserIds: [AUTHORIZED_USER],
  botSuperAdminUserIds: [],
  replyFormat: "markdown",
  robotName: "映客活动AI",
  clientId: "client",
  clientSecret: "secret",
  robotCode: "robot",
};

const keywords = {
  pause: ["停", "暂停", "停止当前任务"],
  monitorOpen: ["打开ai", "启动ai", "醒醒"],
  monitorStop: ["停止ai", "关闭ai", "睡吧"],
  switchPi: ["切pi", "切换pi", "切换 Pi Agent", "换pi"],
  switchCodex: ["切codex", "请切换到 codex", "改用 Codex Agent 处理", "换 Codex"],
};
const parse = (event) => parseMonitorCommand(event, keywords);

const duTarget = {
  groupId: "group-a",
  groupName: "已有群",
  senderId: AUTHORIZED_USER,
  senderName: "授权用户",
};

test("configured keywords parse monitor commands", () => {
  assert.equal(parse({ senderId: AUTHORIZED_USER, content: " 打开ai " }), "open");
  assert.equal(parse({ senderId: AUTHORIZED_USER, content: "启动ai" }), "open");
  assert.equal(parse({ senderId: AUTHORIZED_USER, content: "醒醒" }), "open");
  assert.equal(parse({ senderId: AUTHORIZED_USER, content: "停止ai" }), "stop");
  assert.equal(parse({ senderId: AUTHORIZED_USER, content: "关闭ai" }), "stop");
  assert.equal(parse({ senderId: AUTHORIZED_USER, content: "睡吧" }), "stop");
  assert.equal(parse({ senderId: "another-user", content: "打开ai" }), "open");
  assert.equal(parse({ senderId: AUTHORIZED_USER, content: "打开机器人" }), undefined);
  assert.deepEqual(parse({ senderId: AUTHORIZED_USER, content: "切换pi" }), { type: "switch-agent", agent: "pi" });
  assert.deepEqual(parse({ senderId: AUTHORIZED_USER, content: "切换 Pi Agent" }), { type: "switch-agent", agent: "pi" });
  assert.deepEqual(parse({ senderId: AUTHORIZED_USER, content: "换pi" }), { type: "switch-agent", agent: "pi" });
  assert.deepEqual(parse({ senderId: AUTHORIZED_USER, content: "换 Codex" }), { type: "switch-agent", agent: "codex" });
  assert.deepEqual(parse({ senderId: AUTHORIZED_USER, content: "请切换到 codex" }), { type: "switch-agent", agent: "codex" });
  assert.deepEqual(parse({ senderId: AUTHORIZED_USER, content: "改用 Codex Agent 处理" }), { type: "switch-agent", agent: "codex" });
  assert.equal(parse({ senderId: AUTHORIZED_USER, content: "切换一下" }), undefined);
  assert.deepEqual(parse({ senderId: "another-user", content: "切换pi" }), { type: "switch-agent", agent: "pi" });
  assert.equal(parse({ senderId: "another-user", content: "当前已切换到 Codex。 当前 Agent：Codex Agent（使用本机 Codex CLI）" }), undefined);
  assert.equal(parse({ senderId: AUTHORIZED_USER, content: "停" }), "pause");
  assert.equal(parse({ senderId: AUTHORIZED_USER, content: "暂停" }), "pause");
  assert.equal(parse({ senderId: "another-user", content: "停止当前任务" }), "pause");
});

test("open adds only the current group and configured user once", () => {
  const opened = applyMonitorCommand(config, "open", duTarget);
  assert.equal(opened.changed, true);
  assert.equal(opened.config.targets.length, 2);
  assert.deepEqual(opened.config.targets.at(-1), duTarget);

  const openedAgain = applyMonitorCommand(opened.config, "open", duTarget);
  assert.equal(openedAgain.changed, false);
  assert.equal(openedAgain.config.targets.length, 2);

  const corrected = applyMonitorCommand({ ...opened.config, targets: [{ ...duTarget, groupName: duTarget.groupId }] }, "open", duTarget);
  assert.equal(corrected.changed, true);
  assert.equal(corrected.config.targets[0].groupName, "已有群");
});

test("stop removes only the configured user from the current group", () => {
  const opened = applyMonitorCommand(config, "open", duTarget);
  const stopped = applyMonitorCommand(opened.config, "stop", duTarget);
  assert.equal(stopped.changed, true);
  assert.deepEqual(stopped.config.targets, config.targets);
});
