import { StringDecoder } from "node:string_decoder";

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" ? value as JsonObject : undefined;
}

export function createAgentEnv(proxy?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!proxy) return env;
  env.HTTP_PROXY = proxy;
  env.HTTPS_PROXY = proxy;
  env.http_proxy = proxy;
  env.https_proxy = proxy;
  env.ALL_PROXY = proxy;
  env.all_proxy = proxy;
  return env;
}

/** Read strict LF-delimited JSONL without treating Unicode separators as records. */
export function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) onLine(line);
    }
  });
  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
  });
}
