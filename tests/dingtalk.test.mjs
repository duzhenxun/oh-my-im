import test from "node:test";
import assert from "node:assert/strict";
import { isSingleConversation } from "../dist/dingtalk.js";

test("DingTalk conversationType 1 is a one-to-one conversation", () => {
  assert.equal(isSingleConversation("1"), true);
  assert.equal(isSingleConversation("single"), true);
  assert.equal(isSingleConversation("2"), false);
});
