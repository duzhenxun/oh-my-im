import test from "node:test";
import assert from "node:assert/strict";
import {
  DU_ZHENXUN_OPEN_DINGTALK_ID,
  applyMonitorCommand,
  parseMonitorCommand,
} from "../dist/monitor-command.js";

const config = {
  targets: [{ groupId: "group-a", groupName: "已有群", senderId: "other", senderName: "其他人" }],
  botAllowedUserIds: [DU_ZHENXUN_OPEN_DINGTALK_ID],
  replyFormat: "markdown",
  robotName: "映客活动AI",
  clientId: "client",
  clientSecret: "secret",
  robotCode: "robot",
};

const duTarget = {
  groupId: "group-a",
  groupName: "已有群",
  senderId: DU_ZHENXUN_OPEN_DINGTALK_ID,
  senderName: "杜振训",
};

test("only 杜振训 can issue open and stop monitoring commands", () => {
  assert.equal(parseMonitorCommand({ senderId: DU_ZHENXUN_OPEN_DINGTALK_ID, content: " 打开ai " }), "open");
  assert.equal(parseMonitorCommand({ senderId: DU_ZHENXUN_OPEN_DINGTALK_ID, content: "启动ai" }), "open");
  assert.equal(parseMonitorCommand({ senderId: DU_ZHENXUN_OPEN_DINGTALK_ID, content: "停止ai" }), "stop");
  assert.equal(parseMonitorCommand({ senderId: DU_ZHENXUN_OPEN_DINGTALK_ID, content: "关闭ai" }), "stop");
  assert.equal(parseMonitorCommand({ senderId: "another-user", content: "打开ai" }), undefined);
  assert.equal(parseMonitorCommand({ senderId: DU_ZHENXUN_OPEN_DINGTALK_ID, content: "打开机器人" }), undefined);
});

test("open adds only the current group and 杜振训 once", () => {
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

test("stop removes only 杜振训 from the current group", () => {
  const opened = applyMonitorCommand(config, "open", duTarget);
  const stopped = applyMonitorCommand(opened.config, "stop", duTarget);
  assert.equal(stopped.changed, true);
  assert.deepEqual(stopped.config.targets, config.targets);
});
