#!/usr/bin/env node
/**
 * Remove dsh-session-keyword-search from one DSH profile.
 *
 * Drops the dependency and the `dsh.profile.bundles` entry, backs the manifest
 * up, and leaves the derived index alone unless `--drop-index` is passed.
 *
 * Usage:
 *   node scripts/uninstall.mjs
 *   node scripts/uninstall.mjs --profile desktop --drop-index
 */

import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const PACKAGE = "dsh-session-keyword-search";

function parseArgs(argv) {
  const out = { profile: "desktop", pnpm: "pnpm", home: undefined, dropIndex: false, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") out.profile = argv[++i];
    else if (arg === "--pnpm") out.pnpm = argv[++i];
    else if (arg === "--home") out.home = argv[++i];
    else if (arg === "--drop-index") out.dropIndex = true;
    else if (arg === "--dry-run") out.dryRun = true;
  }
  return out;
}

const options = parseArgs(process.argv);
const home = options.home ?? (process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"));
const profileDir = join(home, "profiles", options.profile);
const manifestPath = join(profileDir, "package.json");
if (!existsSync(manifestPath)) {
  console.error(`no profile manifest at ${manifestPath}`);
  process.exit(2);
}

const original = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(original);
let changed = false;
if (manifest.dependencies?.[PACKAGE] !== undefined) {
  delete manifest.dependencies[PACKAGE];
  changed = true;
}
const bundles = manifest.dsh?.profile?.bundles;
if (Array.isArray(bundles) && bundles.includes(PACKAGE)) {
  manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== PACKAGE);
  changed = true;
}

console.log(`profile     ${profileDir}`);
if (!changed) console.log("nothing to remove: the package is not listed in this profile");

if (!options.dryRun && changed) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${manifestPath}.bak-uninstall-${stamp}`;
  copyFileSync(manifestPath, backupPath);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`backup      ${backupPath}`);
  const command = String(options.pnpm).trim().split(/\s+/);
  const executable = command.shift();
  const removed = spawnSync(executable, [...command, "install"], { cwd: profileDir, stdio: "inherit", shell: process.platform === "win32" });
  if (removed.status !== 0) console.warn(`package manager exited ${String(removed.status)}; check the profile by hand.`);
}

if (options.dropIndex) {
  const indexDir = join(home, "storages", "session-keyword-search");
  if (options.dryRun) console.log(`--dry-run: would delete ${indexDir}`);
  else if (existsSync(indexDir)) {
    rmSync(indexDir, { recursive: true, force: true });
    console.log(`index       deleted ${indexDir}`);
  }
}

console.log("\nrestart DeepSeek Harness so the bundle row is unloaded.");
