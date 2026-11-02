#!/usr/bin/env node
/**
 * Standalone acceptance harness for dsh-session-keyword-search.
 *
 * This script is a *test fixture*, not part of the plugin: it supplies the
 * three corpus capabilities (listSessions / stat / readSession) straight from
 * the on-disk session store, so the core indexer can be exercised without a
 * running harness. The plugin itself never reads files — inside DSH those
 * capabilities come from ctx.sessionQuery / ctx.sessionPersistence.
 *
 * Usage:
 *   node scripts/verify.mjs --queries "槟榔 价格" "沉静式翻译 气泡" "大麦 x-sign"
 *   node scripts/verify.mjs --db %TEMP%/skw.db --rebuild --json
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { KeywordIndex } from "../lib/core.js";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSION_FILE = "session.v4.jsonl.zstd";
const FALLBACK_SESSION_FILE = "session.v4.jsonl";

function args(argv) {
  const out = { queries: [], json: false, rebuild: false, db: undefined, verbose: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--rebuild") out.rebuild = true;
    else if (arg === "--verbose") out.verbose = true;
    else if (arg === "--db") out.db = argv[++i];
    else if (arg === "--queries") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out.queries.push(argv[++i]);
    } else if (!arg.startsWith("--")) out.queries.push(arg);
  }
  if (out.queries.length === 0) out.queries = ["槟榔 价格", "沉静式翻译 气泡", "大麦 x-sign"];
  return out;
}

function sessionRoot() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : join(homedir(), ".dsh");
  return join(home, "sessions");
}

function frameOffsets(buffer) {
  const offsets = [];
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) {
      offsets.push(i);
    }
  }
  return offsets;
}

/** Decode one persisted session log: multi-frame zstd or plain JSONL. */
function decodeLog(file) {
  const buffer = readFileSync(file);
  if (buffer.length === 0) return "";
  const offsets = frameOffsets(buffer);
  if (offsets.length === 0) return buffer.toString("utf8");
  const parts = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length;
    parts.push(zstdDecompressSync(buffer.subarray(start, end)));
  }
  return Buffer.concat(parts).toString("utf8");
}

function parseLog(text) {
  const events = [];
  let header;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const event = record.event ?? record;
    if (header === undefined && (record.type === "session" || event.type === "session")) header = record;
    events.push(event);
  }
  return { header, events };
}

function titleOf(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== "session/title") continue;
    const value = event.data?.title ?? event.data?.value;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** File-backed corpus adapter used only by this harness. */
function fileAdapter(root) {
  const index = [];
  for (const workspace of readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = join(root, workspace.name);
    for (const entry of readdirSync(workspaceDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(workspaceDir, entry.name);
      let file = join(dir, SESSION_FILE);
      try {
        statSync(file);
      } catch {
        const plain = join(dir, FALLBACK_SESSION_FILE);
        try {
          statSync(plain);
          file = plain;
        } catch {
          continue;
        }
      }
      index.push({ id: entry.name, file, workspace: workspace.name });
    }
  }
  const byId = new Map(index.map((entry) => [entry.id, entry]));
  return {
    async listSessions() {
      const records = [];
      for (const entry of index) {
        const { header, events } = parseLog(decodeLog(entry.file));
        records.push({
          header: {
            id: entry.id,
            createdAt: Number(header?.createdAt ?? 0),
            ...(typeof header?.cwd === "string" ? { cwd: header.cwd } : {}),
            ...(typeof header?.parentSession === "string" ? { parentSession: header.parentSession } : {}),
            ...(header?.isSeeded === true ? { isSeeded: true } : {}),
          },
          live: false,
          persisted: true,
          title: titleOf(events),
          workspace: entry.workspace,
        });
      }
      return records;
    },
    async stat(sessionId) {
      const entry = byId.get(sessionId);
      if (entry === undefined) throw new Error(`unknown session ${sessionId}`);
      const info = statSync(entry.file);
      return { revision: `${info.mtimeMs}:${info.size}` };
    },
    async readSession(sessionId) {
      const entry = byId.get(sessionId);
      if (entry === undefined) throw new Error(`unknown session ${sessionId}`);
      const { header, events } = parseLog(decodeLog(entry.file));
      return { session: header, events };
    },
  };
}

const options = args(process.argv);
const root = sessionRoot();
if (!existsSyncSafe(root)) {
  console.error(`no session root at ${root}`);
  process.exit(2);
}
function existsSyncSafe(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

const dbPath = resolve(options.db ?? join(tmpdir(), "dsh-session-keyword-search-verify.db"));
const adapter = fileAdapter(root);
const index = new KeywordIndex({ path: dbPath });
if (options.rebuild) index.clear();

const started = performance.now();
const stats = await index.sync(adapter);
const syncMs = performance.now() - started;

const results = [];
for (const query of options.queries) {
  const queryStarted = performance.now();
  const page = index.search({ query, limit: 10 });
  const elapsed = performance.now() - queryStarted;
  const records = new Map((await adapter.listSessions()).map((record) => [record.header.id, record]));
  results.push({
    query,
    ms: Number(elapsed.toFixed(1)),
    sessions: page.items.map((item) => ({
      sessionId: item.sessionId,
      title: records.get(item.sessionId)?.title ?? null,
      cwd: item.cwd,
      hitCount: item.hitCount,
      bestMatch: item.bestMatch,
      matches: item.matches,
    })),
  });
}

const status = index.status();
index.close();

if (options.json) {
  console.log(JSON.stringify({ db: dbPath, syncMs: Number(syncMs.toFixed(1)), stats, status, results }, null, 2));
} else {
  console.log(`db        ${dbPath}`);
  console.log(`sync      ${syncMs.toFixed(0)} ms  read=${stats.read} skipped=${stats.skipped} messages=${stats.messages} removed=${stats.removed}`);
  console.log(`index     sessions=${status.sessions} messages=${status.messages} chars=${status.chars}`);
  for (const result of results) {
    console.log(`\n=== "${result.query}"  (${result.ms} ms, ${result.sessions.length} sessions) ===`);
    for (const hit of result.sessions.slice(0, 6)) {
      const title = hit.title ?? "(untitled)";
      console.log(`  [${hit.hitCount}x] ${title}  · ${hit.cwd ?? "no-cwd"}`);
      console.log(`        ${hit.bestMatch.snippet.replace(/\s+/g, " ").slice(0, 150)}`);
    }
    if (result.sessions.length === 0) console.log("  (no hits)");
  }
}
