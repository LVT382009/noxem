import os from "os";
import path from "path";
import fs from "fs";

const TRAFFIC_DIR = path.join(os.homedir(), ".lemma", "traffic");
const MAX_TRAFFIC_FILES = 3;
const MAX_BODY_LENGTH = 5000;

let _enabled = true;

export function setTrafficEnabled(enabled: boolean): void {
  _enabled = enabled;
}

function ensureDir(): void {
  if (!fs.existsSync(TRAFFIC_DIR)) {
    fs.mkdirSync(TRAFFIC_DIR, { recursive: true });
  }
}

function getFilePath(): string {
  const date = new Date().toISOString().split("T")[0];
  return path.join(TRAFFIC_DIR, `traffic-${date}.jsonl`);
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.substring(0, max) + `... [truncated, total ${str.length} chars]`;
}

function rotate(): void {
  if (!fs.existsSync(TRAFFIC_DIR)) return;
  try {
    const files = fs
      .readdirSync(TRAFFIC_DIR)
      .filter(f => f.startsWith("traffic-") && f.endsWith(".jsonl"))
      .sort();
    while (files.length > MAX_TRAFFIC_FILES) {
      const old = files.shift();
      if (old) fs.unlinkSync(path.join(TRAFFIC_DIR, old));
    }
  } catch {}
}

interface TrafficEntry {
  ts: string;
  dir: "IN" | "OUT";
  method: string;
  id?: unknown;
  body: unknown;
}

function writeEntry(entry: TrafficEntry): void {
  if (!_enabled) return;
  try {
    ensureDir();
    const line = JSON.stringify(entry);
    fs.appendFileSync(getFilePath(), line + "\n", "utf-8");
  } catch {}
}

export function logIncoming(raw: unknown): void {
  if (!_enabled) return;
  try {
    const msg = raw as Record<string, unknown>;
    const method = (msg.method as string) || "unknown";
    const id = msg.id ?? null;
    let body: unknown;

    if (method === "initialize") {
      body = {
        protocolVersion: (msg.params as Record<string, unknown>)?.protocolVersion,
        clientInfo: (msg.params as Record<string, unknown>)?.clientInfo,
        capabilities: (msg.params as Record<string, unknown>)?.capabilities,
      };
    } else if (method === "tools/call") {
      const params = msg.params as Record<string, unknown>;
      body = {
        name: params?.name,
        arguments: truncate(JSON.stringify(params?.arguments ?? {}), MAX_BODY_LENGTH),
      };
    } else if (method === "resources/read") {
      body = { uri: (msg.params as Record<string, unknown>)?.uri };
    } else if (method === "tools/list" || method === "resources/list" || method === "prompts/list") {
      body = null;
    } else {
      body = truncate(JSON.stringify(msg.params ?? {}), MAX_BODY_LENGTH);
    }

    writeEntry({ ts: new Date().toISOString(), dir: "IN", method, id, body });
  } catch {}
}

export function logOutgoing(raw: unknown): void {
  if (!_enabled) return;
  try {
    const msg = raw as Record<string, unknown>;

    if (msg.error) {
      writeEntry({
        ts: new Date().toISOString(),
        dir: "OUT",
        method: "error",
        id: msg.id ?? null,
        body: msg.error,
      });
      return;
    }

    const result = msg.result as Record<string, unknown>;
    if (!result) {
      writeEntry({
        ts: new Date().toISOString(),
        dir: "OUT",
        method: "response",
        id: msg.id ?? null,
        body: truncate(JSON.stringify(msg), MAX_BODY_LENGTH),
      });
      return;
    }

    if (result.tools) {
      const tools = (result.tools as Array<Record<string, unknown>>).map(t => ({
        name: t.name,
        description: truncate(String(t.description ?? ""), 200),
      }));
      writeEntry({
        ts: new Date().toISOString(),
        dir: "OUT",
        method: "tools/list",
        id: msg.id ?? null,
        body: { tool_count: tools.length, tools },
      });
      return;
    }

    if (result.resources) {
      writeEntry({
        ts: new Date().toISOString(),
        dir: "OUT",
        method: "resources/list",
        id: msg.id ?? null,
        body: { resource_count: (result.resources as unknown[]).length },
      });
      return;
    }

    if (result.instructions !== undefined || result.serverInfo) {
      writeEntry({
        ts: new Date().toISOString(),
        dir: "OUT",
        method: "initialize",
        id: msg.id ?? null,
        body: {
          serverInfo: result.serverInfo,
          instructions_length: (result.instructions as string)?.length ?? 0,
          instructions_preview: truncate(result.instructions as string ?? "", 2000),
          capabilities: result.capabilities,
        },
      });
      return;
    }

    if (result.content) {
      const content = result.content as Array<Record<string, unknown>>;
      const text = content
        .filter(c => c.type === "text")
        .map(c => truncate(String(c.text ?? ""), 2000))
        .join("\n");
      writeEntry({
        ts: new Date().toISOString(),
        dir: "OUT",
        method: "tools/call_response",
        id: msg.id ?? null,
        body: { text },
      });
      return;
    }

    writeEntry({
      ts: new Date().toISOString(),
      dir: "OUT",
      method: "response",
      id: msg.id ?? null,
      body: truncate(JSON.stringify(result), MAX_BODY_LENGTH),
    });
  } catch {}
}

export function initTrafficLogger(): void {
  ensureDir();
  rotate();
}
