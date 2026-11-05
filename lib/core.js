/**
 * Keyword index core for dsh-session-keyword-search.
 *
 * Deliberately free of any Cordis / harness import so it can run inside the
 * host plugin, inside a standalone verification script, and inside tests.
 * The host adapter supplies three async capabilities and this module never
 * learns where session logs actually live:
 *
 *   listSessions(signal)        -> [{ header, live, persisted, formatStatus? }]
 *   stat(sessionId)             -> { revision, eventCount?, sizeBytes? }
 *   readSession(sessionId)      -> { session, inheritedEventCount, events }
 *
 * Storage is a single SQLite database (derived, disposable). It holds only
 * message-level extracted text plus per-session bookkeeping; substring search
 * is done with LIKE over a lowercased column so CJK behaves like any other
 * text (no tokenizer, no FTS).
 */

import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 4;
export const APPLICATION_ID = 0x44534b53; // "DSKS"
export const MESSAGE_TYPES = Object.freeze(["user/message", "assistant/message"]);
export const DEFAULT_SNIPPET_CHARS = 240;

/**
 * Machine-injected user messages are not things the user typed; indexing them
 * makes every template word match every session. Patterns are matched against
 * the trimmed leading text of one message.
 */
export const DEFAULT_INJECTED_PREFIXES = Object.freeze([
  "Current runtime context",
  "Time sampled while preparing",
  "<system-reminder>",
  "[dsh-mnemon:",
  "[mnemon:",
]);

/** Placeholder text used when a session title is the only thing that matched. */
export const TITLE_MATCH_SNIPPET = "";

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

/**
 * Content identity of one message, used to recognise boilerplate.
 *
 * Injected context (memory snapshots, runtime headers) lands in nearly every
 * session verbatim, so a long message that repeats across sessions is context,
 * not conversation.
 */
export function textKey(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  return createHash("sha1").update(flat).digest("hex");
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function isInjected(text, prefixes, patterns) {
  const trimmed = text.trimStart();
  for (const prefix of prefixes) {
    if (prefix.length > 0 && trimmed.startsWith(prefix)) return true;
  }
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

/**
 * Flatten one message content payload into plain text.
 * @param content - string or content-block array from a session event.
 * @returns the text blocks joined with newlines, or "" when none carry text.
 */
export function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (block.type !== "text") continue;
    if (typeof block.text !== "string") continue;
    parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * Split one message into indexable blocks (paragraphs).
 *
 * Injected context is embedded inside otherwise ordinary messages: the same
 * memory snapshot paragraph rides along in every turn of every session. Only
 * block-level units make that repetition observable, so the boilerplate sweep
 * can drop it without discarding the user's own text in the same message.
 *
 * @param text - message text.
 * @param maxLength - hard cap for one block; longer paragraphs split at lines.
 * @returns non-empty blocks in order.
 */
export function splitBlocks(text, maxLength = 1500) {
  const value = typeof text === "string" ? text : "";
  if (value.trim().length === 0) return [];
  const blocks = [];
  for (const paragraph of value.split(/\n\s*\n/)) {
    if (paragraph.trim().length === 0) continue;
    if (paragraph.length <= maxLength) {
      blocks.push(paragraph);
      continue;
    }
    let current = "";
    for (const line of paragraph.split("\n")) {
      if (current.length === 0) {
        current = line;
        continue;
      }
      if (current.length + 1 + line.length > maxLength) {
        if (current.trim().length > 0) blocks.push(current);
        current = line;
      } else {
        current = `${current}\n${line}`;
      }
    }
    if (current.trim().length > 0) blocks.push(current);
  }
  return blocks;
}

/**
 * Extract searchable messages from one session event log.
 * @param events - raw session events, each `{ seq, time, type, data }`.
 * @param options - extraction options.
 * @returns `[{ seq, time, role, text }]` in log order.
 */
export function extractMessages(events, options = {}) {
  const prefixes = options.injectedPrefixes ?? DEFAULT_INJECTED_PREFIXES;
  const userSourceKinds = options.userSourceKinds ?? ["user"];
  const patterns = (options.injectedPatterns ?? []).map((value) =>
    value instanceof RegExp ? value : new RegExp(value, "u"),
  );
  const includeToolEvents = options.includeToolEvents === true;
  const maxChars = options.maxCharsPerMessage ?? 200_000;
  const out = [];
  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    const type = event.type;
    let role;
    let raw;
    if (type === "user/message") {
      // Provenance decides whether a user message is actually a human turn.
      // The harness stores injections (memory recalls, runtime snapshots, skill
      // catalogs, time context, job notices) as user/message events too, so the
      // event type alone would put context into the index.
      const kind = event.data?.source?.kind;
      if (typeof kind === "string" && userSourceKinds.length > 0 && !userSourceKinds.includes(kind)) continue;
      role = "user";
      raw = contentText(event.data?.content);
    } else if (type === "assistant/message") {
      role = "assistant";
      raw = contentText(event.data?.message?.content);
    } else if (includeToolEvents && type === "tool/call") {
      role = "tool-call";
      raw = [event.data?.name, typeof event.data?.arguments === "string" ? event.data.arguments : JSON.stringify(event.data?.arguments ?? "")]
        .filter(Boolean)
        .join("\n");
    } else if (includeToolEvents && type === "tool/result") {
      role = "tool-result";
      raw = contentText(event.data?.message?.content);
    } else {
      continue;
    }
    const text = typeof raw === "string" ? raw : "";
    if (text.trim().length === 0) continue;
    if (isInjected(text, prefixes, patterns)) continue;
    const blocks = splitBlocks(text.length > maxChars ? text.slice(0, maxChars) : text);
    for (let index = 0; index < blocks.length; index += 1) {
      out.push({
        seq: Number(event.seq ?? 0),
        block: index,
        time: Number(event.time ?? 0),
        role,
        text: blocks[index],
      });
    }
  }
  return out;
}

/**
 * Split a raw query into match tokens.
 *
 * Rules (documented in the README):
 *   - whitespace separates tokens; every token must match somewhere in a session
 *   - "double quoted" text is one token and must appear verbatim inside a single message
 *   - matching is case-insensitive for ASCII and byte-exact for everything else
 *
 * @param raw - the user's query string.
 * @param maxTokens - token budget; extra tokens are ignored.
 * @returns `{ tokens, phrases }` where each token carries its raw text.
 */
export function parseQuery(raw, maxTokens = 8) {
  const tokens = [];
  const text = typeof raw === "string" ? raw : "";
  let i = 0;
  let buffer = "";
  const flush = () => {
    const value = buffer.trim();
    buffer = "";
    if (value.length > 0) tokens.push(value);
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "\u201c" || ch === "\u201d") {
      flush();
      const closing = text.indexOf('"', i + 1);
      const end = closing === -1 ? -1 : closing;
      const body = end === -1 ? text.slice(i + 1) : text.slice(i + 1, end);
      const value = body.trim();
      if (value.length > 0) tokens.push(value);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      i += 1;
      continue;
    }
    buffer += ch;
    i += 1;
  }
  flush();
  const unique = [];
  const seen = new Set();
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(token);
    if (unique.length >= maxTokens) break;
  }
  return unique;
}

/**
 * Distinguishing opening text of one message.
 *
 * The browser half has no event ids in the DOM, so it re-finds the message by
 * its content. Whitespace is collapsed because the rendered text is reflowed.
 */
export function messagePrefix(text, maxChars = 160) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? flat.slice(0, maxChars) : flat;
}

/**
 * The line of `text` that contains the first occurrence of `token`.
 *
 * Used for cross-session echo detection: an injected paragraph rides along in
 * many sessions with slightly different surrounding metadata, but the line that
 * carries the phrase is the same sentence everywhere.
 */
export function matchedLine(text, token) {
  const value = String(text ?? "");
  const needle = lower(token);
  if (needle.length === 0) return "";
  const lines = value.split(/\n/);
  for (const line of lines) {
    if (lower(line).includes(needle)) return line.trim();
  }
  return "";
}

/**
 * Normalize one line for echo comparison.
 *
 * Bracket annotations such as `[created=2d]` differ between snapshots of the
 * same text, so they are removed before comparing.
 */
export function echoKey(line) {
  return String(line ?? "")
    .replace(/\[[a-z_]+=[^\]]*\]/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Characters of context shown before the match inside a snippet. */
const SNIPPET_LEAD = 10;

/**
 * Build the one-line window shown in a search result row.
 *
 * Result rows render a single ellipsised line (~25 characters visible), so the
 * matched term has to sit near the start: a wide lead pushes it out of view and
 * the row looks unmatched. Short messages are returned whole; the window is
 * never pulled back to fill `maxChars`, because that would move the term away
 * from the visible part again.
 *
 * @param text - block text the hit was found in.
 * @param token - the term to centre on (the one this hit actually matched).
 * @param maxChars - window length in code points.
 * @returns the snippet, with ellipses only where text was cut.
 */
export function makeSnippet(text, token, maxChars = DEFAULT_SNIPPET_CHARS) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  const haystack = flat.toLowerCase();
  const needle = lower(token);
  const at = needle.length === 0 ? 0 : haystack.indexOf(needle);
  const start = at < 0 ? 0 : Math.max(0, at - SNIPPET_LEAD);
  const end = Math.min(flat.length, start + maxChars);
  const head = start > 0 ? "\u2026" : "";
  const tail = end < flat.length ? "\u2026" : "";
  return `${head}${flat.slice(start, end)}${tail}`;
}

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  try {
    return JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Derived keyword index over one harness profile's session corpus.
 */
export class KeywordIndex {
  #db;
  #path;
  #options;

  /**
   * @param options - index location and behaviour.
   * @param options.path - absolute SQLite file path.
   * @param options.injectedPrefixes - leading-text prefixes to ignore.
   * @param options.injectedPatterns - extra JS regex sources to ignore.
   * @param options.includeToolEvents - also index tool calls/results.
   * @param options.snippetChars - snippet length in code points.
   * @param options.maxTokens - query token budget.
   * @param options.excludeSessionIds - session ids never indexed.
   */
  constructor(options) {
    if (typeof options?.path !== "string" || options.path.length === 0) {
      throw new TypeError("KeywordIndex needs an absolute path");
    }
    this.#path = options.path;
    this.#options = {
      injectedPrefixes: options.injectedPrefixes ?? [...DEFAULT_INJECTED_PREFIXES],
      injectedPatterns: options.injectedPatterns ?? [],
      includeToolEvents: options.includeToolEvents === true,
      snippetChars: options.snippetChars ?? DEFAULT_SNIPPET_CHARS,
      maxTokens: options.maxTokens ?? 8,
      excludeSessionIds: new Set(options.excludeSessionIds ?? []),
    };
    if (this.#path !== ":memory:") mkdirSync(dirname(this.#path), { recursive: true });
    this.#db = new DatabaseSync(this.#path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA busy_timeout = 4000");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#migrate();
    this.#failed = this.#loadFailures();
  }

  /**
   * Revisions that could not be read last time.
   *
   * A log the harness itself rejects as corrupt stays corrupt until `flush`
   * rewrites it, so retrying it on every search only burns the read budget.
   * The revision is the cache key: a repaired log gets a new revision and is
   * read again automatically.
   */
  #failed = new Map();
  #failedDirty = false;

  #loadFailures() {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'failed_revisions'").get();
    if (row === undefined) return new Map();
    try {
      const parsed = JSON.parse(String(row.value));
      if (parsed === null || typeof parsed !== "object") return new Map();
      return new Map(Object.entries(parsed).filter(([, value]) => typeof value === "string"));
    } catch {
      return new Map();
    }
  }

  #flushFailures() {
    if (!this.#failedDirty) return;
    const value = JSON.stringify(Object.fromEntries([...this.#failed].slice(-500)));
    this.#db
      .prepare("INSERT INTO meta(key, value) VALUES ('failed_revisions', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(value);
    this.#failedDirty = false;
  }

  get path() {
    return this.#path;
  }

  #migrate() {
    const db = this.#db;
    // A derived index is disposable: when the shape changes, rebuild it from
    // scratch. Only bumping the version leaves stale tables in place and the
    // next CREATE INDEX fails on the missing column.
    let current;
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
      current = row === undefined ? undefined : Number(row.value);
    } catch {
      current = undefined; // meta itself is missing
    }
    if (current !== undefined && current !== SCHEMA_VERSION) {
      db.exec("DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS meta;");
      current = undefined;
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        revision      TEXT NOT NULL,
        title         TEXT,
        cwd           TEXT,
        created_at    INTEGER NOT NULL DEFAULT 0,
        updated_at    INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        char_count    INTEGER NOT NULL DEFAULT 0,
        indexed_at    INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS messages (
        session_id TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        block      INTEGER NOT NULL DEFAULT 0,
        time       INTEGER NOT NULL DEFAULT 0,
        role       TEXT NOT NULL,
        text       TEXT NOT NULL,
        text_lc    TEXT NOT NULL,
        text_key   TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (session_id, seq, block)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS messages_session_time ON messages(session_id, time);
      CREATE INDEX IF NOT EXISTS messages_text_key ON messages(text_key);
    `);
    if (current === undefined) {
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('application_id', ?)").run(String(APPLICATION_ID));
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('generation', '0')").run();
    }
  }

  #bumpGeneration() {
    this.#db.prepare("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'generation'").run();
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'generation'").get();
    return String(row?.value ?? "0");
  }

  generation() {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'generation'").get();
    return String(row?.value ?? "0");
  }

  /**
   * Bring the index in line with the corpus.
   *
   * Only sessions whose revision changed are read; everything else is skipped
   * without touching the log.
   *
   * @param adapter - corpus capabilities (see module docs).
   * @param options - sync options.
   * @returns per-run statistics.
   */
  async sync(adapter, options = {}) {
    const signal = options.signal;
    const records = await adapter.listSessions(signal);
    signal?.throwIfAborted?.();
    const known = new Map();
    for (const row of this.#db.prepare("SELECT id, revision FROM sessions").all()) {
      known.set(row.id, String(row.revision));
    }
    const stats = {
      sessions: records.length,
      read: 0,
      skipped: 0,
      failed: 0,
      messages: 0,
      chars: 0,
      removed: 0,
      failures: [],
      boilerplate: 0,
    };
    const live = new Set();
    for (const record of records) {
      const id = record?.header?.id;
      if (typeof id !== "string") continue;
      live.add(id);
      if (this.#options.excludeSessionIds.has(id)) continue;
      // One unreadable log must never stop the whole reconciliation: a single
      // corrupt session would otherwise leave the index silting up and make
      // every later search look broken.
      let revision;
      try {
        revision = await this.#revisionOf(adapter, record, signal);
        if (revision === undefined) {
          stats.skipped += 1;
          continue;
        }
        if (known.get(id) === revision) {
          stats.skipped += 1;
          continue;
        }
        if (this.#failed.get(id) === revision) {
          stats.skipped += 1;
          stats.failed += 1;
          if (stats.failures.length < 10) {
            stats.failures.push({ id, message: "unreadable at this revision; skipped until it changes" });
          }
          continue;
        }
        const log = await adapter.readSession(id, signal);
        signal?.throwIfAborted?.();
        const messages = extractMessages(log?.events ?? [], {
          injectedPrefixes: this.#options.injectedPrefixes,
          injectedPatterns: this.#options.injectedPatterns,
          includeToolEvents: this.#options.includeToolEvents,
        });
        const header = log?.session ?? record.header;
        const chars = messages.reduce((sum, message) => sum + message.text.length, 0);
        const updatedAt = messages.reduce((max, message) => Math.max(max, message.time), Number(header?.createdAt ?? 0));
        this.#writeSession(id, {
          revision,
          title: typeof record?.title === "string" ? record.title : null,
          cwd: typeof header?.cwd === "string" ? header.cwd : null,
          createdAt: Number(header?.createdAt ?? 0),
          updatedAt,
          messages,
        });
        stats.read += 1;
        stats.messages += messages.length;
        stats.chars += chars;
        if (this.#failed.delete(id)) this.#failedDirty = true;
      } catch (error) {
        stats.failed += 1;
        if (this.#failed.get(id) !== revision) {
          this.#failed.set(id, typeof revision === "string" ? revision : "");
          this.#failedDirty = true;
        }
        if (stats.failures.length < 10) {
          stats.failures.push({ id, message: String(error?.message ?? error).slice(0, 300) });
        }
      }
    }
    for (const id of known.keys()) {
      if (live.has(id)) continue;
      this.#db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
      this.#db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      stats.removed += 1;
    }
    if (stats.read > 0 || stats.removed > 0) this.#bumpGeneration();
    this.#flushFailures();
    return stats;
  }

  async #revisionOf(adapter, record, signal, knownRevision) {
    if (typeof adapter.stat === "function") {
      try {
        const stat = await adapter.stat(record.header.id, signal);
        if (stat !== undefined && stat !== null && stat.revision !== undefined) return String(stat.revision);
      } catch {
        // A failing stat must not lose content, but it also must not turn every
        // reconcile into a full corpus read.
      }
    }
    // No cheap revision signal. Keep what is already indexed: re-reading every
    // log on every search is exactly the cost this seam exists to avoid.
    if (knownRevision !== undefined) return knownRevision;
    try {
      const log = await adapter.readSession(record.header.id, signal);
      const events = log?.events ?? [];
      const last = events[events.length - 1];
      return `log:${events.length}:${String(last?.seq ?? -1)}`;
    } catch {
      return undefined;
    }
  }

  #writeSession(id, payload) {
    const db = this.#db;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
      const insert = db.prepare(
        "INSERT OR REPLACE INTO messages(session_id, seq, block, time, role, text, text_lc, text_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const message of payload.messages) {
        insert.run(id, message.seq, message.block ?? 0, message.time, message.role, message.text, lower(message.text), textKey(message.text));
      }
      db.prepare(
        `INSERT INTO sessions(id, revision, title, cwd, created_at, updated_at, message_count, char_count, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           revision = excluded.revision, title = excluded.title, cwd = excluded.cwd,
           created_at = excluded.created_at, updated_at = excluded.updated_at,
           message_count = excluded.message_count, char_count = excluded.char_count,
           indexed_at = excluded.indexed_at`,
      ).run(
        id,
        payload.revision,
        payload.title,
        payload.cwd,
        payload.createdAt,
        payload.updatedAt,
        payload.messages.length,
        payload.messages.reduce((sum, message) => sum + message.text.length, 0),
        Date.now(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Search indexed messages.
   *
   * Every token must match at least one message of a session (session-level
   * AND); per-session hit count and recency order the results.
   *
   * @param request - `{ query, cwd?, limit?, cursor? }`.
   * @returns `{ items, nextCursor? }` in provider-neutral shape.
   */
  search(request) {
    const tokens = parseQuery(request?.query, this.#options.maxTokens);
    if (tokens.length === 0) return { items: [] };
    const limit = clampLimit(request?.limit);
    const cursor = request?.cursor === undefined ? undefined : decodeCursor(request.cursor);
    const generation = this.generation();
    if (cursor !== undefined && cursor.generation !== generation) {
      const error = new Error("session keyword index changed while paging");
      error.code = "SESSION_QUERY_STALE_CURSOR";
      throw error;
    }
    const offset = cursor?.offset ?? 0;

    const perSession = new Map();
    const select = this.#db.prepare(
      "SELECT session_id, seq, block, time, role, text FROM messages WHERE text_lc LIKE ? ESCAPE '\\' ORDER BY time DESC LIMIT 4000",
    );
    for (const token of tokens) {
      const needle = `%${escapeLike(token.toLowerCase())}%`;
      for (const row of select.all(needle)) {
        let entry = perSession.get(row.session_id);
        if (entry === undefined) {
          entry = { hits: new Map(), tokens: new Set() };
          perSession.set(row.session_id, entry);
        }
        entry.tokens.add(token);
        const key = `${row.seq}:${row.block}`;
        const existing = entry.hits.get(key);
        if (existing === undefined) {
          entry.hits.set(key, {
            seq: Number(row.seq),
            block: Number(row.block),
            time: Number(row.time),
            role: row.role,
            text: row.text,
            token,
            tokens: new Set([token]),
          });
        } else {
          existing.tokens.add(token);
        }
      }
    }

    const required = tokens.length;
    const rows = [];
    for (const [sessionId, entry] of perSession) {
      if (entry.tokens.size < required) continue;
      const meta = this.#db
        .prepare("SELECT id, cwd, created_at, updated_at FROM sessions WHERE id = ?")
        .get(sessionId);
      if (meta === undefined) continue;
      rows.push({ sessionId, meta, hits: [...entry.hits.values()] });
    }

    const wantsCwd = typeof request?.cwd === "string" && request.cwd.length > 0 ? request.cwd : undefined;
    rows.sort((a, b) => {
      if (b.hits.length !== a.hits.length) return b.hits.length - a.hits.length;
      if (wantsCwd !== undefined) {
        const aw = a.meta.cwd === wantsCwd ? 1 : 0;
        const bw = b.meta.cwd === wantsCwd ? 1 : 0;
        if (aw !== bw) return bw - aw;
      }
      if (b.meta.updated_at !== a.meta.updated_at) return b.meta.updated_at - a.meta.updated_at;
      return String(a.sessionId).localeCompare(String(b.sessionId));
    });

    const slice = rows.slice(offset, offset + limit);
    const items = slice.map((row) => {
      const hits = [...row.hits].sort((a, b) => b.time - a.time);
      // A session can match a multi-term query across different blocks. The row
      // must show the block that covers the most terms, and the snippet must be
      // framed on a term that block actually contains — framing on the first
      // query term would fall back to position 0 for the others.
      const best = [...hits].sort((a, b) => (b.tokens?.size ?? 1) - (a.tokens?.size ?? 1) || b.time - a.time)[0];
      const bestToken = tokens.find((token) => best.tokens?.has(token) === true) ?? best.token;
      return {
        sessionId: row.sessionId,
        cwd: row.meta.cwd,
        createdAt: Number(row.meta.created_at),
        updatedAt: Number(row.meta.updated_at),
        hitCount: row.hits.length,
        bestMatch: {
          sessionId: row.sessionId,
          seq: best.seq,
          type: best.role === "user" ? "user/message" : "assistant/message",
          time: best.time,
          surface: "current",
          snippet: makeSnippet(best.text, bestToken, this.#options.snippetChars),
          // Not part of the stock hit shape: the browser half uses it to find
          // the rendered message again when the user opens the hit.
          prefix: messagePrefix(best.text),
        },
        matches: hits.slice(0, 3).map((hit) => ({
          seq: hit.seq,
          time: hit.time,
          type: hit.role === "user" ? "user/message" : "assistant/message",
          snippet: makeSnippet(
            hit.text,
            tokens.find((token) => hit.tokens?.has(token) === true) ?? hit.token,
            this.#options.snippetChars,
          ),
          prefix: messagePrefix(hit.text),
        })),
      };
    });
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < rows.length ? encodeCursor({ offset: nextOffset, generation }) : undefined;
    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  /**
   * Title-and-workspace-only fallback used when the index cannot answer.
   * @param request - `{ query, limit? }`.
   * @param records - live corpus records from `listSessions`.
   * @returns provider-shaped items built without any message text.
   */
  titleFallback(request, records) {
    const tokens = parseQuery(request?.query, this.#options.maxTokens);
    if (tokens.length === 0) return { items: [] };
    const limit = clampLimit(request?.limit);
    const items = [];
    for (const record of records) {
      const title = typeof record?.title === "string" ? record.title : "";
      const cwd = typeof record?.header?.cwd === "string" ? record.header.cwd : "";
      const haystack = `${title}\n${cwd}`.toLowerCase();
      if (!tokens.every((token) => haystack.includes(token.toLowerCase()))) continue;
      items.push({
        header: record.header,
        live: record.live === true,
        persisted: record.persisted === true,
        bestMatch: {
          sessionId: record.header.id,
          seq: 0,
          type: "user/message",
          time: Number(record.header?.createdAt ?? 0),
          surface: "current",
          snippet: title.length > 0 ? title : TITLE_MATCH_SNIPPET,
        },
      });
      if (items.length >= limit) break;
    }
    return { items };
  }

  /** Counters for the settings panel. */
  status() {
    const sessions = this.#db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(message_count), 0) AS m, COALESCE(SUM(char_count), 0) AS c FROM sessions").get();
    const meta = this.#db.prepare("SELECT key, value FROM meta").all();
    return {
      path: this.#path,
      sessions: Number(sessions?.n ?? 0),
      messages: Number(sessions?.m ?? 0),
      chars: Number(sessions?.c ?? 0),
      generation: this.generation(),
      meta: Object.fromEntries(meta.map((row) => [row.key, row.value])),
    };
  }

  /** Drop every indexed row, keeping the database file and schema. */
  clear() {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec("DELETE FROM messages; DELETE FROM sessions;");
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    this.#bumpGeneration();
  }

  close() {
    try {
      this.#db.close();
    } catch {
      /* already closed */
    }
  }
}

function clampLimit(value) {
  const limit = Number.isFinite(value) ? Math.trunc(value) : 20;
  if (limit < 1) return 1;
  if (limit > 100) return 100;
  return limit;
}
