/**
 * dsh-session-keyword-search — host half.
 *
 * Strategy: borrow the *existing* sidebar search instead of adding a second
 * entry point. The stock search box already talks to `ctx.sessionQuery
 * .searchSessions`, so this plugin replaces those two methods on the live
 * service instance with a substring index that behaves the same for CJK and
 * ASCII text. Nothing else is replaced and no row in the composition changes,
 * so an incompatible harness simply keeps its original behaviour.
 *
 * Degradation ladder for every search call:
 *   1. our SQLite keyword index
 *   2. the original provider method (whatever the host mounts)
 *   3. session title / workspace substring match from the corpus listing
 *
 * The plugin never reads session files: corpus access goes through the public
 * services (`ctx.sessionQuery`, optional `ctx.sessionPersistence`).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { KeywordIndex, DEFAULT_INJECTED_PREFIXES, MESSAGE_TYPES, extractMessages } from "./core.js";

/** Optional peer: the harness error class lets the stock API map our cursor errors. */
let SessionQueryErrorClass;
try {
  const contract = await import("@deepseek-ai/dsh-session-query");
  SessionQueryErrorClass = contract.SessionQueryError;
} catch {
  SessionQueryErrorClass = undefined;
}

function searchError(message, code) {
  if (typeof SessionQueryErrorClass === "function") {
    try {
      return new SessionQueryErrorClass(message, code);
    } catch {
      /* fall through to a plain error */
    }
  }
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Resolve the harness data home using the documented precedence. */
function resolveDataHome(explicit) {
  if (typeof explicit === "string" && explicit.trim().length > 0) return explicit.trim();
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return join(homedir(), ".dsh");
}

/** Channel the settings panel calls through `connection.rpc`. */
export const RPC_CHANNEL = "/dsh-session-keyword-search";

function nowIso() {
  return new Date().toISOString();
}

/**
 * Apply defaults locally instead of trusting the loader.
 *
 * The loader validates `Config` and hands over a filled object, but the plugin
 * is also constructed directly by tests, the settings panel preview, and other
 * embedders; a missing field must never change behaviour silently.
 */
function normalizeConfig(input = {}) {
  const config = input ?? {};
  const strings = (value, fallback) =>
    Array.isArray(value) ? value.filter((item) => typeof item === "string") : fallback;
  return {
    path: typeof config.path === "string" ? config.path : "",
    dataHome: typeof config.dataHome === "string" ? config.dataHome : "",
    takeover: config.takeover === "off" ? "off" : "auto",
    includeToolEvents: config.includeToolEvents === true,
    injectedPrefixes: strings(config.injectedPrefixes, [...DEFAULT_INJECTED_PREFIXES]),
    injectedPatterns: strings(config.injectedPatterns, []),
    excludeSessionIds: strings(config.excludeSessionIds, []),
    snippetChars: Number.isFinite(config.snippetChars) ? Math.max(20, Math.trunc(config.snippetChars)) : 240,
    maxTokens: Number.isFinite(config.maxTokens) ? Math.min(32, Math.max(1, Math.trunc(config.maxTokens))) : 8,
    refreshDebounceMs: Number.isFinite(config.refreshDebounceMs) ? Math.max(0, Math.trunc(config.refreshDebounceMs)) : 5000,
    uiHighlight: config.uiHighlight !== false,
    uiReveal: config.uiReveal !== false,
    revealAttempts: Number.isFinite(config.revealAttempts) ? Math.min(60, Math.max(0, Math.trunc(config.revealAttempts))) : 20,
    userSourceKinds: Array.isArray(config.userSourceKinds) ? config.userSourceKinds.filter((value) => typeof value === "string") : ["user"],
  };
}

/** @returns whether one corpus record belongs to the requested event filter set. */
function acceptsType(filters, type) {
  if (!Array.isArray(filters) || filters.length === 0) return true;
  for (const filter of filters) {
    if (filter?.kind !== "type") continue;
    if (!Array.isArray(filter.values)) continue;
    return filter.values.includes(type);
  }
  return true;
}

function acceptsSurface(filters) {
  if (!Array.isArray(filters) || filters.length === 0) return true;
  for (const filter of filters) {
    if (filter?.kind !== "surface") continue;
    if (!Array.isArray(filter.values)) continue;
    return filter.values.includes("current");
  }
  return true;
}

/**
 * Host plugin.
 *
 * A class plugin (rather than a service) because it owns no new service name:
 * it augments one that already exists.
 */
export default class SessionKeywordSearch {
  static inject = ["sessionQuery"];

  static Config = z.object({
    /** Absolute SQLite path; defaults to <dataHome>/storages/session-keyword-search/index.db. */
    path: z.string().default(""),
    /** Explicit harness data home; defaults to $DSH_HOME, then ~/.dsh. */
    dataHome: z.string().default(""),
    /** `auto` takes over the stock search; `off` leaves the host untouched. */
    takeover: z.union(["auto", "off"]).default("auto"),
    /** Also index tool calls and tool results. */
    includeToolEvents: z.boolean().default(false),
    /** Leading-text prefixes that mark machine-injected user messages. */
    injectedPrefixes: z.array(z.string()).default([...DEFAULT_INJECTED_PREFIXES]),
    /** Extra JS regular expressions (source strings) treated as injected text. */
    injectedPatterns: z.array(z.string()).default([]),
    /** Session ids to keep out of the index entirely. */
    excludeSessionIds: z.array(z.string()).default([]),
    /** Snippet length in code points. */
    snippetChars: z.number().step(1).min(20).default(240),
    /** Token budget per query. */
    maxTokens: z.number().step(1).min(1).max(32).default(8),
    /** Minimum delay between two corpus reconciliations. */
    refreshDebounceMs: z.number().step(1).min(0).default(5000),
    /** Mark the query inside the sidebar result rows (browser enhancement). */
    uiHighlight: z.boolean().default(true),
    /** Scroll to the matched message after a result is opened. */
    uiReveal: z.boolean().default(true),
    /** How many older-page pulls the reveal may attempt before giving up. */
    revealAttempts: z.number().step(1).min(0).max(60).default(20),
    /** `user/message` provenance kinds treated as real human turns. */
    userSourceKinds: z.array(z.string()).default(["user"]),
  });

  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = normalizeConfig(config);
    this.index = undefined;
    this.ready = undefined;
    this.lastSyncAt = 0;
    this.syncStats = undefined;
    this.lastError = undefined;
    this.patched = false;
    this.stats = { searches: 0, degraded: 0, titleFallbacks: 0, failures: 0 };

    ctx.inject(["sessionQuery"], (scoped) => {
      const service = scoped.sessionQuery;
      if (service === undefined || service === null) return;
      if (this.config.takeover !== "auto") return;
      this.#install(scoped, service);
    });

    // Revision source for incremental sync. Without it every reconcile has to
    // read every log, which is the difference between ~50 ms and seconds.
    ctx.inject(["sessionPersistence"], (scoped) => {
      this.persistence = scoped.sessionPersistence;
      scoped.effect(
        () => () => {
          this.persistence = undefined;
        },
        "sessionKeywordSearch.persistence",
      );
    });

    // Diagnostics: exercise the real corpus once after boot when asked.
    // `DSH_SESSION_KEYWORD_SEARCH_SELFTEST='<query>'` logs the hit counts and
    // never changes what a user sees.
    const selftestQuery = process.env.DSH_SESSION_KEYWORD_SEARCH_SELFTEST;
    if (typeof selftestQuery === "string" && selftestQuery.trim().length > 0) {
      setTimeout(() => {
        void (async () => {
          try {
            const reply = await this.#guarded("sessions", { query: selftestQuery.trim(), limit: 5 }, {});
            const probe = { records: 0, sample: undefined, persistence: "unknown" };
            try {
              const records = await this.ctx.sessionQuery.listSessions();
              probe.records = Array.isArray(records) ? records.length : -1;
              const first = Array.isArray(records) ? records[0] : undefined;
              if (first !== undefined) {
                const log = await this.ctx.sessionQuery.readSession(first.header.id);
                const events = log?.events ?? [];
                const types = [...new Set(events.map((event) => event?.type ?? "(none)"))].slice(0, 8);
                const extracted = extractMessages(events, { injectedPrefixes: this.config.injectedPrefixes });
                probe.sample = {
                  id: first.header.id,
                  cwd: first.header.cwd,
                  live: first.live,
                  persisted: first.persisted,
                  events: events.length,
                  types,
                  extracted: extracted.length,
                  firstText: extracted[0]?.text?.slice(0, 60),
                };
              }
            } catch (error) {
              probe.sample = { error: String(error?.message ?? error) };
            }
            try {
              const persistence = this.ctx.get("sessionPersistence");
              probe.persistence = persistence === undefined ? "absent" : typeof persistence.stat === "function" ? "present" : "no-stat";
            } catch (error) {
              probe.persistence = `throw: ${String(error?.message ?? error)}`;
            }
            const report = {
              query: selftestQuery.trim(),
              sessions: reply?.items?.length ?? 0,
              ids: (reply?.items ?? []).map((item) => item?.header?.id ?? item?.sessionId ?? ""),
              probe,
              stats: { ...this.stats },
              index: this.#ensureIndex().status(),
              lastError: this.lastError,
            };
            this.#log("info", `selftest: ${JSON.stringify(report)}`);
            try {
              const { writeFileSync } = await import("node:fs");
              const { tmpdir } = await import("node:os");
              const { join: joinPath } = await import("node:path");
              writeFileSync(joinPath(tmpdir(), "dsh-session-keyword-search-selftest.json"), JSON.stringify(report, null, 2), "utf8");
            } catch {
              /* file reporting is best effort */
            }
          } catch (error) {
            this.#log("error", `selftest failed: ${String(error?.message ?? error)}`);
          }
        })();
      }, 800).unref?.();
    }
    // The settings panel is optional: a headless deployment has no connection
    // service and simply keeps the plugin without its maintenance UI.
    //
    // `webServer` must be injected alongside `connection`: the channel registry
    // resolves `owner.webServer.register(...)` and a context that did not declare
    // the service sees it as absent, which silently loses the route.
    ctx.inject(["connection", "webServer"], (scoped) => {
      this.#installRpc(scoped);
    });
  }

  /**
   * Register the maintenance channel and record the outcome.
   *
   * The outcome is written next to the index because a failed registration is
   * invisible from the browser: the request falls through to the static server
   * and surfaces as `HTTP 405`, which says nothing about the cause.
   */
  #installRpc(scoped) {
    const record = {
      at: nowIso(),
      channel: RPC_CHANNEL,
      hasConnection: scoped.connection !== undefined && scoped.connection !== null,
      hasRpcHandle: typeof scoped.connection?.rpc?.handle === "function",
      hasWebServer: scoped.get?.("webServer") !== undefined,
      ok: false,
      error: undefined,
      via: undefined,
    };
    const handler = async (endpoint) => {
      try {
        if (endpoint === "status") return { ok: true, value: await this.status() };
        if (endpoint === "rebuild") return { ok: true, value: await this.rebuild() };
        if (endpoint === "drop") return { ok: true, value: this.drop() };
        if (endpoint === "last-search") {
          const base = this.lastSearch;
          return {
            ok: true,
            value:
              base === undefined
                ? null
                : {
                    ...base,
                    ui: {
                      highlight: this.config.uiHighlight,
                      reveal: this.config.uiReveal,
                      maxAttempts: this.config.revealAttempts,
                    },
                  },
          };
        }
        return {
          ok: false,
          error: { code: "gateway/bad-request", message: `unknown endpoint "${String(endpoint)}"`, details: {} },
        };
      } catch (error) {
        return { ok: false, error: { code: "gateway/internal", message: String(error?.message ?? error), details: {} } };
      }
    };

    // First choice: the channel registry. On some compositions its internal
    // `owner.webServer` lookup fails because the service context never declared
    // the web server, so a failure here is expected and not fatal.
    try {
      const service = scoped.connection;
      if (typeof service?.rpc?.handle !== "function") throw new Error("connection exposes no rpc.handle");
      const dispose = service.rpc.handle(RPC_CHANNEL, handler);
      record.ok = true;
      record.via = "connection.rpc.handle";
      scoped.effect(
        () => () => {
          try {
            dispose?.();
          } catch {
            /* channel already gone */
          }
        },
        "sessionKeywordSearch.rpc",
      );
    } catch (error) {
      record.error = String(error?.message ?? error);
    }

    // Fallback: own the prefix route. Same wire contract, no dependence on how
    // the connection service resolves its web server.
    if (record.ok !== true) {
      try {
        const webServer = scoped.webServer;
        if (typeof webServer?.register !== "function") throw new Error("webServer exposes no register()");
        const dispose = webServer.register({
          kind: "prefix",
          path: RPC_CHANNEL,
          handler: (req, res) => this.#bridge(scoped, handler, req, res),
        });
        record.ok = true;
        record.via = "webServer.register";
        record.error = undefined;
        scoped.effect(
          () => () => {
            try {
              dispose?.();
            } catch {
              /* route already gone */
            }
          },
          "sessionKeywordSearch.route",
        );
      } catch (error) {
        record.error = `${String(record.error ?? "")} | ${String(error?.message ?? error)}`.replace(/^ \| /, "");
      }
    }
    this.rpcRegistration = record;
    try {
      const target = join(dirname(this.#indexPath()), "rpc-registration.json");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(record, null, 2), "utf8");
    } catch {
      /* diagnostics are best effort */
    }
  }

  /**
   * Serve one RPC call on our own prefix route.
   *
   * Mirrors the connection bridge's wire contract: admission first, then one
   * JSON `client-request` in and one JSON `server-response` out.
   */
  async #bridge(scoped, handler, req, res) {
    try {
      const admission = scoped.connection.admit(req);
      if (admission?.rejection !== undefined) {
        res.writeHead(admission.rejection);
        res.end();
        return;
      }
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      const endpoint = pathname.slice(RPC_CHANNEL.length + 1);
      const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
      if (req.method !== "POST" || endpoint.length === 0 || contentType !== "application/json") {
        res.writeHead(404);
        res.end();
        return;
      }
      let raw = "";
      req.setEncoding?.("utf8");
      for await (const chunk of req) raw += chunk;
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      if (message?.method !== endpoint) {
        res.writeHead(400);
        res.end();
        return;
      }
      const result = await handler(endpoint, message.payload);
      const body = JSON.stringify({ type: "server-response", rpcId: message.rpcId, result });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    } catch (error) {
      this.#log("warn", `rpc bridge failed: ${String(error?.message ?? error)}`);
      try {
        res.writeHead(500);
        res.end();
      } catch {
        /* response already started */
      }
    }
  }

  #log(level, message) {
    try {
      const logger = this.ctx.logger;
      if (logger !== undefined) logger[level]?.(`[session-keyword-search] ${message}`);
    } catch {
      /* logging must never break a search */
    }
  }

  #indexPath() {
    if (typeof this.config.path === "string" && this.config.path.trim().length > 0) {
      return this.config.path.trim();
    }
    const home = resolveDataHome(this.config.dataHome);
    return join(home, "storages", "session-keyword-search", "index.db");
  }

  #ensureIndex() {
    if (this.index !== undefined) return this.index;
    this.index = new KeywordIndex({
      path: this.#indexPath(),
      injectedPrefixes: this.config.injectedPrefixes,
      injectedPatterns: this.config.injectedPatterns,
      includeToolEvents: this.config.includeToolEvents === true,
      snippetChars: this.config.snippetChars,
      maxTokens: this.config.maxTokens,
      excludeSessionIds: this.config.excludeSessionIds,
      userSourceKinds: this.config.userSourceKinds,
    });
    return this.index;
  }

  #adapter() {
    const ctx = this.ctx;
    return {
      listSessions: (signal) => ctx.sessionQuery.listSessions(signal),
      stat: async (sessionId, signal) => {
        const persistence = this.persistence;
        if (persistence === undefined) return undefined;
        signal?.throwIfAborted?.();
        const stat = await persistence.stat(sessionId);
        if (stat === undefined || stat === null) return undefined;
        return { revision: String(stat.revision ?? ""), eventCount: stat.eventCount, sizeBytes: stat.sizeBytes };
      },
      readSession: (sessionId) => ctx.sessionQuery.readSession(sessionId),
    };
  }

  /** Reconcile the index at most once per debounce window. */
  async #sync(force = false, signal) {
    const index = this.#ensureIndex();
    const age = Date.now() - this.lastSyncAt;
    if (!force && age < this.config.refreshDebounceMs) return this.syncStats;
    if (this.ready !== undefined) await this.ready.catch(() => {});
    this.ready = (async () => {
      const stats = await index.sync(this.#adapter(), { signal });
      this.lastSyncAt = Date.now();
      this.records = undefined;
      this.syncStats = { ...stats, at: nowIso() };
      return this.syncStats;
    })();
    try {
      return await this.ready;
    } finally {
      this.ready = undefined;
    }
  }

  /**
   * Session headers for the hits in one page.
   *
   * `listSessions()` walks the whole corpus, so it is cached briefly instead of
   * being paid on every keystroke; a completed sync drops the cache.
   */
  async #records() {
    const now = Date.now();
    if (this.records !== undefined && now - this.records.at < 15000) return this.records.value;
    const value = await this.ctx.sessionQuery.listSessions();
    this.records = { at: now, value };
    return value;
  }

  /** Best-effort current workspace directory, used only as a ranking bonus. */
  #currentDirectory() {
    try {
      const service = this.ctx.get("workingDirectory");
      const value = service?.defaultDirectory;
      return typeof value === "string" && value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async #searchSessions(request, exec) {
    this.stats.searches += 1;
    const signal = exec?.signal;
    if (acceptsSurface(request?.eventFilters) === false) {
      return { items: [] };
    }
    const startedAt = performance.now();
    const index = this.#ensureIndex();
    // Reconciling the corpus costs one `stat` per session. Do it off the search
    // path once there is something to serve; only the very first search (empty
    // index) waits for it.
    let empty = false;
    try {
      empty = index.status().sessions === 0;
    } catch {
      empty = true;
    }
    if (empty) {
      await this.#sync(false, signal);
    } else {
      void this.#sync(false, signal).catch((error) => {
        this.#log("warn", `background reconcile failed: ${String(error?.message ?? error)}`);
      });
    }
    const afterSync = performance.now();
    const page = index.search({
      query: request?.query,
      cwd: this.#currentDirectory(),
      limit: request?.limit,
      cursor: request?.cursor,
    });
    if (page.items.length === 0) {
      this.lastSearch = { at: nowIso(), query: String(request?.query ?? ""), hits: [] };
      return page;
    }
    const afterQuery = performance.now();
    const records = await this.#records();
    const afterRecords = performance.now();
    const byId = new Map(records.map((record) => [record.header.id, record]));
    const items = [];
    for (const item of page.items) {
      const record = byId.get(item.sessionId);
      if (record === undefined) continue;
      const type = item.bestMatch.type;
      if (!MESSAGE_TYPES.includes(type)) continue;
      if (acceptsType(request?.eventFilters, type) === false) continue;
      items.push({
        header: record.header,
        live: record.live === true,
        persisted: record.persisted === true,
        bestMatch: item.bestMatch,
      });
    }
    this.lastTiming = {
      at: nowIso(),
      reconcile: Number((afterSync - startedAt).toFixed(1)),
      query: Number((afterQuery - afterSync).toFixed(1)),
      records: Number((afterRecords - afterQuery).toFixed(1)),
      total: Number((performance.now() - startedAt).toFixed(1)),
      hits: items.length,
      backgroundReconcile: !empty,
    };
    // Remember what this query matched: the stock result row drops everything
    // but session id and snippet, so the browser half can only re-locate the
    // message by asking us what it was.
    this.lastSearch = {
      at: nowIso(),
      query: String(request?.query ?? ""),
      hits: items.slice(0, 20).map((item) => ({
        sessionId: item.header.id,
        seq: item.bestMatch.seq,
        type: item.bestMatch.type,
        time: item.bestMatch.time,
        snippet: item.bestMatch.snippet,
        prefix: item.bestMatch.prefix,
      })),
    };
    return page.nextCursor === undefined ? { items } : { items, nextCursor: page.nextCursor };
  }
  async #searchEvents(request, exec) {
    const signal = exec?.signal;
    const sessionId = request?.sessionId;
    if (typeof sessionId !== "string") return { session: undefined, items: [] };
    const startedAt = performance.now();
    const index = this.#ensureIndex();
    // Reconciling the corpus costs one `stat` per session. Do it off the search
    // path once there is something to serve; only the very first search (empty
    // index) waits for it.
    let empty = false;
    try {
      empty = index.status().sessions === 0;
    } catch {
      empty = true;
    }
    if (empty) {
      await this.#sync(false, signal);
    } else {
      void this.#sync(false, signal).catch((error) => {
        this.#log("warn", `background reconcile failed: ${String(error?.message ?? error)}`);
      });
    }
    const afterSync = performance.now();
    const page = index.search({ query: request?.query, limit: request?.limit, cursor: request?.cursor });
    const record = (await this.#records()).find((candidate) => candidate.header.id === sessionId);
    const items = [];
    if (record !== undefined) {
      for (const item of page.items) {
        if (item.sessionId !== sessionId) continue;
        for (const match of item.matches ?? [item.bestMatch]) {
          items.push({
            sessionId,
            seq: match.seq,
            type: match.type,
            time: match.time,
            surface: "current",
            snippet: match.snippet,
          });
        }
      }
    }
    return { session: record?.header, items };
  }

  #titleFallback(request) {
    this.stats.titleFallbacks += 1;
    const index = this.#ensureIndex();
    return this.#records().then((records) => index.titleFallback(request, records));
  }

  async #guarded(kind, request, exec) {
    try {
      const result = kind === "sessions" ? await this.#searchSessions(request, exec) : await this.#searchEvents(request, exec);
      return result;
    } catch (error) {
      this.stats.degraded += 1;
      this.lastError = { at: nowIso(), kind, stage: "index", message: String(error?.message ?? error) };
      this.#log("warn", `keyword index failed (${kind}); trying the original provider: ${String(error?.message ?? error)}`);
      const original = this.original;
      if (original !== undefined) {
        try {
          const result = kind === "sessions" ? await original.searchSessions(request, exec) : await original.searchEvents(request, exec);
          return result;
        } catch (originalError) {
          this.lastError = { at: nowIso(), kind, stage: "provider", message: String(originalError?.message ?? originalError) };
          this.#log("warn", `original provider failed too; falling back to titles: ${String(originalError?.message ?? originalError)}`);
        }
      }
      if (kind === "events") return { session: undefined, items: [] };
      try {
        return await this.#titleFallback(request);
      } catch (fallbackError) {
        this.stats.failures += 1;
        this.lastError = { at: nowIso(), kind, stage: "title", message: String(fallbackError?.message ?? fallbackError) };
        this.#log("error", `title fallback failed: ${String(fallbackError?.message ?? fallbackError)}`);
        throw error;
      }
    }
  }

  #install(scoped, service) {
    const original = {
      searchSessions: service.searchSessions,
      searchEvents: service.searchEvents,
    };
    this.original = original;
    const self = this;
    const patchedSessions = async function patchedSearchSessions(request, exec) {
      return self.#guarded("sessions", request, exec);
    };
    const patchedEvents = async function patchedSearchEvents(request, exec) {
      return self.#guarded("events", request, exec);
    };
    try {
      service.searchSessions = patchedSessions;
      service.searchEvents = patchedEvents;
      this.patched = true;
      this.#log("info", "took over session search");
    } catch (error) {
      this.#log("warn", `could not take over session search: ${String(error?.message ?? error)}`);
      return;
    }
    scoped.effect(
      () => () => {
        try {
          delete service.searchSessions;
          delete service.searchEvents;
        } catch {
          service.searchSessions = original.searchSessions;
          service.searchEvents = original.searchEvents;
        }
        this.patched = false;
        this.index?.close();
        this.index = undefined;
        this.#log("info", "restored the original session search");
      },
      "sessionKeywordSearch.restore",
    );
  }

  /** Status snapshot for the settings panel and diagnostics. */
  async status() {
    let index;
    try {
      index = this.#ensureIndex().status();
    } catch (error) {
      index = { error: String(error?.message ?? error) };
    }
    return {
      patched: this.patched,
      takeover: this.config.takeover,
      indexPath: this.#indexPath(),
      rpc: this.rpcRegistration,
      index,
      lastSync: this.syncStats,
      timing: this.lastTiming,
      lastError: this.lastError,
      stats: { ...this.stats },
    };
  }

  /** Force a full reconciliation. */
  async rebuild() {
    const index = this.#ensureIndex();
    index.clear();
    return this.#sync(true);
  }

  /** Drop every indexed row (the next search rebuilds). */
  drop() {
    this.#ensureIndex().clear();
    this.lastSyncAt = 0;
    return { cleared: true, path: this.#indexPath() };
  }
}
