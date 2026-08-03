#!/usr/bin/env node
import { runApp } from "./index.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const command = process.argv[2] ?? "start";
const here = dirname(fileURLToPath(import.meta.url));

if (command === "--help" || command === "-h" || command === "help") {
  console.log([
    "oh-my-im",
    "",
    "Commands:",
    "  start   start the DingTalk to Codex bridge (default)",
    "  version print version",
  ].join("\n"));
  process.exit(0);
}

if (command === "--version" || command === "-v" || command === "version") {
  const pkgPath = join(here, "..", "package.json");
  const version = JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "0.1.0";
  console.log(version);
  process.exit(0);
}

if (command !== "start") {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

await runApp();
