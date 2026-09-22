/**
 * DingTalk 的互动卡片与机器人消息使用钉钉自有的 Markdown 渲染器，它只支持
 * 标题、加粗、列表、链接、引用和分割线等有限语法，**不支持 GitHub 风格的表格**。
 * 因此 Agent 输出的 `| a | b |` 表格会被原样显示成一堆竖线，在手机端尤其难读。
 *
 * 这里把表格块转换成移动端/桌面端都好读的列表结构：
 *
 *   1 | ka古堡探秘 | act202605_gubao_tanmi | 09-05 ~ 09-27
 *
 * 变成：
 *
 *   **1. ka古堡探秘**
 *   - module_name：act202605_gubao_tanmi
 *   - 时间：09-05 ~ 09-27
 */

const INDEX_HEADER = /^(#|序号|编号|no\.?|index|id)$/i;
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
  // Prefer the first real column as the item title; a leading "#"/"序号" column
  // is only used as a numeric prefix.
  const titleIndex = header.findIndex((cell) => Boolean(cell) && !INDEX_HEADER.test(cell));
  const index = titleIndex >= 0 ? titleIndex : 0;
  const useIndexPrefix = index > 0;
  const blocks = rows.map((row) => {
    const title = (row[index] ?? "").trim() || "(空)";
    const prefix = useIndexPrefix && (row[0] ?? "").trim() ? `${(row[0] ?? "").trim()}. ` : "";
    const lines = [`**${prefix}${title}**`];
    header.forEach((name, column) => {
      if (column === index) return;
      // A leading index column is already shown as the title prefix.
      if (useIndexPrefix && column === 0) return;
      const value = (row[column] ?? "").trim();
      if (!value) return;
      lines.push(`- ${name || `列${column + 1}`}：${value}`);
    });
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
