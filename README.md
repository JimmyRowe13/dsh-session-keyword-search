# dsh-session-keyword-search

Keyword search across **every** DeepSeek Harness session — the kind of search you
want when you remember a phrase but not the conversation.

It takes over the sidebar search box instead of adding a second entry point: type
`大麦 x-sign` and the existing search lists the sessions that talked about it.

## Why this exists

The harness ships an SQLite FTS5 search behind `ctx.sessionQuery.searchSessions`.
Its tokenizer is `unicode61`, so one contiguous CJK run is a **single token**:
a document containing `大麦协议劫持已在真机验证通过` does not match `大麦`, and
`会话搜索` does not match `搜索`. This plugin replaces those two search methods
with a substring index, so Chinese, English and mixed queries all behave the same.

## What it does

- **Substring recall.** `LIKE` over a lowercased text column: no tokenizer, no
  phrase quoting rules to remember, no minimum token length.
- **Session-level AND.** Whitespace separates terms; every term must appear
  somewhere in the session, but not necessarily in the same message. A quoted
  `"phrase"` must appear verbatim inside one message.
- **Ranked sessions.** More matching messages first, then recent activity, with
  the current workspace winning ties.
- **Provenance decides, not guessing.** Every `user/message` carries
  `data.source.kind`: `user` is a human turn, while `dsh-mnemon`,
  `runtime-context`, `time-context`, `skill-catalog` and `tool-jobs` are
  injections. Only kinds listed in `userSourceKinds` (default `["user"]`) are
  indexed, and `assistant/message` contributes `text` blocks only — reasoning is
  never searchable.
- **Paragraph units.** A message is split at blank lines (and long paragraphs at
  line boundaries) before indexing, so a snippet points at one paragraph rather
  than a whole message.
- **Fast warm path.** The first search builds a derived SQLite index (one table of
  message rows); later searches only re-read sessions whose revision changed.
- **Marks in the result list.** Query terms are wrapped in `<mark>` inside the
  sidebar rows.
- **Opens at the match.** After a result is opened, the transcript scrolls to the
  matched message and flashes it; older pages are pulled first, up to
  `revealAttempts` times, and it quietly stays put when the text cannot be found.

## Install

```bash
# from this repository
node scripts/install.mjs --tgz ./dsh-session-keyword-search-0.1.0.tgz
# then restart DeepSeek Harness
```

The script backs up `<profile>/package.json`, adds the dependency and the
`dsh.profile.bundles` entry, and runs the package manager. `--dry-run` prints the
planned manifest change. Nothing under the application directory is touched, so a
harness update cannot eat the plugin.

Uninstall:

```bash
node scripts/uninstall.mjs            # keep the index
node scripts/uninstall.mjs --drop-index
```

## Configuration

Every field is optional; the bundle's `cordis.patch.yml` carries the same defaults.

| Field | Default | Meaning |
|---|---|---|
| `path` | `<dataHome>/storages/session-keyword-search/index.db` | Derived SQLite index. |
| `dataHome` | `$DSH_HOME`, else `~/.dsh` | Base directory for the default path. |
| `takeover` | `auto` | `off` leaves the host's own search untouched (and never builds an index). |
| `includeToolEvents` | `false` | Also index `tool/call` and `tool/result` text. |
| `injectedPrefixes` | built-in list | Leading text that marks a machine-injected user message. |
| `injectedPatterns` | `[]` | Extra regular expressions (source strings) treated the same way. |
| `excludeSessionIds` | `[]` | Sessions that must never enter the index. |
| `snippetChars` | `240` | Snippet length in code points. |
| `maxTokens` | `8` | Query token budget. |
| `refreshDebounceMs` | `5000` | Minimum gap between two corpus reconciliations. |
| `uiHighlight` | `true` | Mark query terms inside sidebar result rows (browser enhancement). |
| `uiReveal` | `true` | Scroll to the matched message after a result is opened. |
| `revealAttempts` | `20` | How many older-page pulls the reveal may attempt. |
| `userSourceKinds` | `["user"]` | `source.kind` allow-list for human turns; injections stay out of the index. |

Override the row by id in the profile's own patch:

```yaml
- id: session-keyword-search
  config:
    takeover: off
```

## How it stays compatible

- Corpus access uses **public services only**: `ctx.sessionQuery.listSessions()`,
  `ctx.sessionQuery.readSession(id)`, and the optional `ctx.sessionPersistence.stat(id)`
  revision. The plugin never learns where session logs live, never decodes the
  zstd log format, and never parses paths.
- It augments the live `sessionQuery` instance (`ctx.effect` restores the original
  methods on dispose) instead of replacing the service row, so an incompatible
  harness keeps its own behaviour instead of failing to boot.
- Every search degrades through three stages: **our index → the original provider
  → session-title/workspace substring**, and records the failure for the settings
  panel.

## Settings panel

`Settings → Session keyword search` shows the index path, session/message counts,
indexed text size, the last sync counters, the last error, and offers
**Rebuild** / **Delete index** / **Refresh**. It talks to the host over the
`/dsh-session-keyword-search` RPC channel.

Channel registration is recorded in `rpc-registration.json` next to the index. If
the panel reports `HTTP 405`, read that file first: it states whether `connection`
and `webServer` were visible, whether the route registered, and why it failed.

The panel is not required for maintenance:

```bash
node scripts/status.mjs            # index state plus the registration record
node scripts/status.mjs --rebuild  # rebuild from the on-disk sessions
node scripts/status.mjs --clear    # drop every indexed row
```

## Verification

`scripts/verify.mjs` is a standalone harness: it feeds the indexer from the
on-disk store and prints the hits for a set of queries, so recall can be checked
without a running harness.

```bash
node scripts/verify.mjs --rebuild --queries "槟榔 价格" "沉静式翻译 气泡" "大麦 x-sign"
```

Measured on a real profile (106 sessions, 48.5k events): 2,114 indexable
messages, 1.25 MB of text, full cold build ≈ 2.5 s, warm queries 16–60 ms.

Inside a live harness, one boot-time probe reports what the plugin sees through
the **real** services and writes it to `%TEMP%/dsh-session-keyword-search-selftest.json`:

```bash
DSH_SESSION_KEYWORD_SEARCH_SELFTEST="槟榔 价格" dsh <profile> ...
```

## Known limits

- A session's last turn or two may not be on disk yet, so a just-written message
  can be missing until the harness flushes.
- Sessions written before `data.source` existed are treated as human turns (an empty
  `userSourceKinds` list disables the allow-list).
- Highlight and reveal are heuristics over DOM contracts (`[role="treeitem"]`,
  `[data-chat-node-key]`, `[data-conversation-scroll]`): losing them never affects
  search, and a message rewritten substantially by markdown may not match its
  stored prefix.
- A session log the harness itself rejects as corrupt (for example
  `step/start does not match the open turn`) is skipped on its own without
  affecting the rest; the count shows in the settings panel as "Unreadable
  sessions skipped", and the same revision is not retried.
- Nothing is encrypted: the index holds message text in plain SQLite. Delete it
  from the settings panel or with `--drop-index`.
- Search results come from the harness's own result row component; the plugin
  supplies session id plus snippet, exactly like the stock provider.

## License

MIT.
