import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Single source of truth for the running version: the package.json that ships
 * next to the compiled code. Both the CLI (omi) and the dashboard worker read
 * through here instead of parsing package.json on their own, and callers can
 * read it again after an in-place upgrade so they never report a stale value.
 */
const packageFile = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");

export function readVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(packageFile, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function formatVersion(version: string): string {
  return `v${version.replace(/^v/i, "")}`;
}
