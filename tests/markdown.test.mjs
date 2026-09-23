import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDingTalkMarkdown } from "../dist/dingtalk/markdown.js";

test("converts a markdown table into compact two-line records", () => {
  const input = [
    "**礼物送礼用户**",
    "",
    "| 排名 | 次数 | UID | 昵称 | 收礼主播 |",
    "|---|---|---|---|---|",
    "| 1 | 3 | 778339247 | 不语（幽月专属小陪档） | Dh·幽月 |",
    "| 2 | 1 | 728170623 | 崔力 | ON·林一 |",
  ].join("\n");
  const output = normalizeDingTalkMarkdown(input);
  assert.match(output, /\*\*1\. 不语（幽月专属小陪档）\*\*/);
  assert.match(output, /次数：3 ｜ UID：778339247 ｜ 收礼主播：Dh·幽月/);
  assert.match(output, /\*\*2\. 崔力\*\*/);
  assert.ok(!output.includes("|---|"), "the raw table separator must not survive");
  assert.ok(!output.includes("| 排名 |"), "the raw header must not survive");
});

test("keeps code fences untouched", () => {
  const input = ["```", "| a | b |", "|---|---|", "| 1 | 2 |", "```"].join("\n");
  assert.equal(normalizeDingTalkMarkdown(input), input);
});

test("prefers a name column as the title and uses the leading column as a prefix", () => {
  const input = ["| 序号 | 项目 | module_name | 时间 |", "|---|---|---|---|", "| 1 | ka古堡探秘 | act2026 | 09-05 |"].join("\n");
  const output = normalizeDingTalkMarkdown(input);
  assert.match(output, /\*\*1\. ka古堡探秘\*\*/);
  assert.match(output, /module_name：act2026 ｜ 时间：09-05/);
});
