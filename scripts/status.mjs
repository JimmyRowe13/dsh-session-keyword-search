#!/usr/bin/env node
/**
 * Inspect (and optionally rebuild or clear) the keyword index without a running
 * harness. Ops insurance: the settings panel needs the host RPC channel, while
 * this script only needs files.
 *
 * Usage:
 *   node scripts/status.mjs
 *   node scripts/status.mjs --rebuild        # same corpus sync the plugin does
 *   node scripts/status.mjs --clear
 *   node scripts/status.mjs --db <path>
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { KeywordIndex } from "../lib/core.js";

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function parseArgs(argv) {
  const out = { db: undefined, rebuild: false, clear: false, home: undefined };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") out.db = argv[++i];
    else if (arg === "--rebuild") out.rebuild = true;
    else if (arg === "--clear") out.clear = true;
    else if (arg === "--home") out.home = argv[++i];
  }
  return out;
}

function decodeLog(file) {
  const buffer = readFileSync(file);
  const offsets = [];
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (buffer[i] === MAGIC[0] && buffer[i + 1] === MAGIC[1] && buffer[i + 2] === MAGIC[2] && buffer[i + 3] === MAGIC[3]) offsets.push(i);
  }
  if (offsets.length === 0) return buffer.toString("utf8");
  const parts = [];
  for (let i = 0; i < offsets.length; i += 1) {
    parts.push(zstdDecompressSync(buffer.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : buffer.length)));
  }
  return Buffer.concat(parts).toString("utf8");
}

function fileAdapter(root) {
  const entries = [];
  for (const workspace of readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    for (const session of readdirSync(join(root, workspace.name), { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const file = join(root, workspace.name, session.name, "session.v4.jsonl.zstd");
      try {
        statSync(file);
      } catch {
        continue;
      }
      entries.push({ id: session.name, file });
    }
  }
  const parsed = new Map();
  const parse = (entry) => {
    if (parsed.has(entry.id)) return parsed.get(entry.id);
    const events = [];
    let header;
    for (const line of decodeLog(entry.file).split("\n")) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const event = record.event ?? record;
      if (header === undefined && event?.type === "session") header = record;
      events.push(event);
    }
    const value = { header, events };
    parsed.set(entry.id, value);
    return value;
  };
  return {
    async listSessions() {
      return entries.map((entry) => {
        const { header } = parse(entry);
        return { header: { id: entry.id, createdAt: Number(header?.createdAt ?? 0), ...(header?.cwd ? { cwd: header.cwd } : {}) }, live: false, persisted: true };
      });
    },
    async stat(sessionId) {
      const entry = entries.find((candidate) => candidate.id === sessionId);
      const info = statSync(entry.file);
      return { revision: `${info.mtimeMs}:${info.size}` };
    },
    async readSession(sessionId) {
      const entry = entries.find((candidate) => candidate.id === sessionId);
      return parse(entry);
    },
  };
}

const options = parseArgs(process.argv);
const home = options.home ?? (process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"));
const dbPath = resolve(options.db ?? join(home, "storages", "session-keyword-search", "index.db"));
console.log(`db        ${dbPath}`);
if (!existsSync(dbPath)) {
  console.log("status    index does not exist yet (the first search inside the harness creates it)");
}

const index = new KeywordIndex({ path: dbPath });
if (options.clear) {
  index.clear();
  console.log("cleared   every indexed row removed");
}
if (options.rebuild) {
  const adapter = fileAdapter(join(home, "sessions"));
  const started = performance.now();
  const stats = await index.sync(adapter);
  console.log(`rebuilt   ${(performance.now() - started).toFixed(0)} ms read=${stats.read} skipped=${stats.skipped} messages=${stats.messages}`);
}
const status = index.status();
index.close();
console.log(`sessions  ${status.sessions}`);
console.log(`messages  ${status.messages}`);
console.log(`text      ${(status.chars / 1024 / 1024).toFixed(2)} MB`);
console.log(`generation ${status.generation}`);
const registration = join(home, "storages", "session-keyword-search", "rpc-registration.json");
if (existsSync(registration)) {
  console.log(`rpc       ${readFileSync(registration, "utf8").replace(/\s+/g, " ").trim()}`);
}
void tmpdir;
