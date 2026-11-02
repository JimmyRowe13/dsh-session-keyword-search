#!/usr/bin/env node
/**
 * Install dsh-session-keyword-search into one DSH profile.
 *
 * Writes two files, both backed up first:
 *   <profile>/package.json      dependency + `dsh.profile.bundles` entry
 * and then runs the package manager so `node_modules` matches.
 *
 * Usage:
 *   node scripts/install.mjs --tgz ./dsh-session-keyword-search-0.1.0.tgz
 *   node scripts/install.mjs --tgz ... --profile desktop --pnpm "pnpm"
 *   node scripts/install.mjs --tgz ... --dry-run
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const PACKAGE = "dsh-session-keyword-search";

function parseArgs(argv) {
  const out = { profile: "desktop", pnpm: "pnpm", dryRun: false, tgz: undefined, home: undefined };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tgz") out.tgz = argv[++i];
    else if (arg === "--profile") out.profile = argv[++i];
    else if (arg === "--pnpm") out.pnpm = argv[++i];
    else if (arg === "--home") out.home = argv[++i];
    else if (arg === "--dry-run") out.dryRun = true;
    else if (!arg.startsWith("--") && out.tgz === undefined) out.tgz = arg;
  }
  return out;
}

const options = parseArgs(process.argv);
if (options.tgz === undefined) {
  console.error("usage: node scripts/install.mjs --tgz <package.tgz> [--profile desktop] [--pnpm pnpm] [--dry-run]");
  process.exit(2);
}
const home = options.home ?? (process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"));
const profileDir = join(home, "profiles", options.profile);
const manifestPath = join(profileDir, "package.json");
if (!existsSync(manifestPath)) {
  console.error(`no profile manifest at ${manifestPath}`);
  process.exit(2);
}
const tgzPath = resolve(options.tgz);
if (!existsSync(tgzPath)) {
  console.error(`no package at ${tgzPath}`);
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = `${manifestPath}.bak-${stamp}`;
const original = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(original);
manifest.dependencies = manifest.dependencies ?? {};
manifest.dependencies[PACKAGE] = `file:${tgzPath.replace(/\\/g, "/")}`;
manifest.dsh = manifest.dsh ?? {};
manifest.dsh.profile = manifest.dsh.profile ?? {};
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
if (!bundles.includes(PACKAGE)) bundles.push(PACKAGE);
manifest.dsh.profile.bundles = bundles;
const next = `${JSON.stringify(manifest, null, 2)}\n`;

console.log(`profile     ${profileDir}`);
console.log(`package     file:${tgzPath}`);
console.log(`bundles     ${bundles.join(", ")}`);
if (options.dryRun) {
  console.log(`\n--dry-run: would back up to ${backupPath} and write the manifest above`);
  process.exit(0);
}

copyFileSync(manifestPath, backupPath);
writeFileSync(manifestPath, next, "utf8");
console.log(`backup      ${backupPath}`);

const install = spawnSync(...pnpmCommand(options.pnpm, "install"), { cwd: profileDir, stdio: "inherit", shell: process.platform === "win32" });
if (install.status !== 0) {
  console.error(`\npackage manager failed (exit ${String(install.status)}). Restoring the manifest.`);
  writeFileSync(manifestPath, original, "utf8");
  process.exit(install.status ?? 1);
}
console.log("\ninstalled. Restart DeepSeek Harness so the host loads the new bundle row.");

/** Split a possibly absolute command line into executable plus arguments. */
function pnpmCommand(command, verb) {
  const parts = String(command).trim().split(/\s+/);
  const executable = parts.shift();
  return [executable, [...parts, verb]];
}
