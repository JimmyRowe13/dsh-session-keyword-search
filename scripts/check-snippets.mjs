#!/usr/bin/env node
/**
 * Snippet framing check.
 *
 * A result row renders one ellipsised line (~25 characters visible), so the
 * matched term must sit near the start of the snippet. This script runs real
 * queries against an index and reports where the term landed.
 *
 * Usage:
 *   node scripts/check-snippets.mjs --db <index.db> --queries 插件 搜索 MCP 工具 pnpm
 *   node scripts/check-snippets.mjs --db <index.db> --limit 25 --max-position 30
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { KeywordIndex, parseQuery } from "../lib/core.js";

function args(argv) {
  const out = { db: undefined, queries: [], limit: 3, maxPosition: 30, home: undefined };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") out.db = argv[++i];
    else if (arg === "--limit") out.limit = Number(argv[++i]);
    else if (arg === "--max-position") out.maxPosition = Number(argv[++i]);
    else if (arg === "--home") out.home = argv[++i];
    else if (arg === "--queries") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out.queries.push(argv[++i]);
    } else if (!arg.startsWith("--")) out.queries.push(arg);
  }
  if (out.queries.length === 0) out.queries = ["插件", "搜索", "MCP", "工具", "pnpm"];
  return out;
}

const options = args(process.argv);
const home = options.home ?? (process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"));
const dbPath = resolve(options.db ?? join(home, "storages", "session-keyword-search", "index.db"));
if (!existsSync(dbPath)) {
  console.error(`no index at ${dbPath}`);
  process.exit(2);
}

const index = new KeywordIndex({ path: dbPath });
const rows = [];
let failures = 0;

for (const query of options.queries) {
  const page = index.search({ query, limit: options.limit });
  const tokens = parseQuery(query);
  for (const hit of page.items) {
    const snippet = hit.bestMatch.snippet;
    // The snippet must contain a term the query asked for; position measured on
    // the text as rendered (ellipsis counts as one visible character).
    let best = Number.POSITIVE_INFINITY;
    let which = "";
    for (const token of tokens) {
      const at = snippet.toLowerCase().indexOf(token.toLowerCase());
      if (at >= 0 && at < best) {
        best = at;
        which = token;
      }
    }
    const ok = best <= options.maxPosition;
    if (!ok) failures += 1;
    rows.push({ query, session: hit.sessionId.slice(0, 12), hits: hit.hitCount, token: which || "(missing)", position: best === Number.POSITIVE_INFINITY ? -1 : best, ok, snippet: snippet.replace(/\s+/g, " ").slice(0, 60) });
  }
}
index.close();

for (const row of rows) {
  const flag = row.ok ? "ok " : "BAD";
  console.log(`${flag} ${row.query.padEnd(12)} ${row.session}  hits=${String(row.hits).padStart(3)}  "${row.token}"@${row.position}`);
  console.log(`    ${row.snippet}`);
}
console.log(`\n${rows.length - failures}/${rows.length} hits put the term within ${options.maxPosition} characters`);
process.exit(failures === 0 ? 0 : 1);
