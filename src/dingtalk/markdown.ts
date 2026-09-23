/**
 * DingTalk 的互动卡片与机器人消息使用钉钉自有的 Markdown 渲染器，它只支持
 * 标题、加粗、列表、链接、引用和分割线等有限语法，**不支持 GitHub 风格的表格**。
 * 因此 Agent 输出的 `| a | b |` 表格会被原样显示成一堆竖线，在手机端尤其难读。
 *
 * 这里把表格块转换成移动端/桌面端都好读的紧凑结构：行内用第一列序号 +
 * 名称类列做强标题，其余字段用 ` ｜ ` 拼成一行；字段过多或过长时才退化成列表。
 *
 *   | 排名 | 次数 | UID | 昵称 | 收礼主播 |
 *   |---|---|---|---|---|
 *   | 1 | 3 | 778339247 | 不语 | Dh·幽月 |
 *
 * 变成：
 *
 *   **1. 不语**
 *   次数：3 ｜ UID：778339247 ｜ 收礼主播：Dh·幽月
 */

const INDEX_HEADER = /^(#|序号|编号|排名|名次|排位|no\.?|index|id|rank)$/i;
const NAME_HEADER = /^(昵称|名称|名字|用户|用户名|用户昵称|主播|收礼主播|送礼用户|送礼人|项目|项目名|活动|活动名|name|user|nick|nickname|title)$/i;
// 表格分隔行：支持 - / – / — 三种横线，以及可选的居中对齐冒号。
const SEPARATOR_CELL = /^:?[-\u2013\u2014]{1,}:?$/;

function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => SEPARATOR_CELL.test(cell));
}

function looksLikeTableRow(line: string): boolean {
  return line.includes("|") && line.trim().length > 0;
}

function renderTable(header: string[], rows: string[][]): string {
  // 序号列：优先识别常见的排序列，否则回退到第一列。
  const indexColumn = header.findIndex((cell, column) => Boolean(cell) && INDEX_HEADER.test(cell));
  // 标题列：优先用名称类列（昵称/项目等），否则用第一个非序号列。
  let titleColumn = header.findIndex((cell, column) => column !== indexColumn && Boolean(cell) && NAME_HEADER.test(cell));
  if (titleColumn < 0) titleColumn = header.findIndex((cell, column) => column !== indexColumn && Boolean(cell));
  if (titleColumn < 0) titleColumn = indexColumn >= 0 ? indexColumn : 0;

  const blocks = rows.map((row) => {
    const title = (row[titleColumn] ?? "").trim() || "(空)";
    const indexValue = indexColumn >= 0 ? (row[indexColumn] ?? "").trim() : "";
    const prefix = indexColumn >= 0 && indexColumn !== titleColumn && indexValue ? `${indexValue}. ` : "";
    const lines = [`**${prefix}${title}**`];

    const fields: string[] = [];
    header.forEach((name, column) => {
      if (column === indexColumn || column === titleColumn) return;
      const value = (row[column] ?? "").trim();
      if (!value) return;
      fields.push(`${name || `列${column + 1}`}：${value}`);
    });
    if (fields.length > 0) {
      const joined = fields.join(" ｜ ");
      // 字段少且不长时并成一行，卡片更紧凑；否则退回列表便于逐条阅读。
      if (fields.length <= 4 && joined.length <= 60) lines.push(joined);
      else lines.push(...fields.map((field) => `- ${field}`));
    }
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

/**
 * 把内容中的 Markdown 表格转成钉钉可读的列表，其它内容保持不变。
 * 代码块（``` 或 ~~~）内的竖线不会被处理。
 */
export function normalizeDingTalkMarkdown(content: string): string {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let inFence = false;
  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      output.push(line);
      cursor += 1;
      continue;
    }
    // 表头行 + 分隔行才算一个表格，且列数要一致，避免误伤正文中的单个竖线
    // 或紧跟在横线下方的普通文本。
    if (!inFence && looksLikeTableRow(line) && cursor + 1 < lines.length && isSeparatorRow(lines[cursor + 1])) {
      const header = splitRow(line);
      const separator = splitRow(lines[cursor + 1]);
      if (separator.length !== header.length) {
        output.push(line);
        cursor += 1;
        continue;
      }
      const rows: string[][] = [];
      cursor += 2;
      while (cursor < lines.length && looksLikeTableRow(lines[cursor]) && !isSeparatorRow(lines[cursor])) {
        rows.push(splitRow(lines[cursor]));
        cursor += 1;
      }
      output.push(renderTable(header, rows));
      continue;
    }
    output.push(line);
    cursor += 1;
  }
  return output.join("\n");
}
