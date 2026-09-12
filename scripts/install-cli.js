#!/usr/bin/env node
// Installs the SuperTing agent CLI (`superting`) onto the user's PATH.
//
// Default target: ~/.local/bin (created if missing). Override with:
//   SUPERTING_CLI_BIN_DIR=/some/dir npm run install:cli
//
// The install is a symlink to cli/superting.js in this checkout so CLI fixes
// apply after `git pull` without reinstalling. Pass --copy to install a copy
// instead (for read-only checkouts).

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const cliSource = path.join(repoRoot, "cli", "superting.js");

function resolveTargetDir() {
  const explicit = process.env.SUPERTING_CLI_BIN_DIR;
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), ".local", "bin");
}

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const copy = args.includes("--copy");

  if (!fs.existsSync(cliSource)) {
    console.error(`CLI source not found: ${cliSource}`);
    process.exit(1);
  }

  const targetDir = resolveTargetDir();
  if (!isWritable(targetDir)) {
    console.error(`Target directory is not writable: ${targetDir}`);
    console.error("Set SUPERTING_CLI_BIN_DIR to a writable directory on your PATH.");
    process.exit(1);
  }
  const target = path.join(targetDir, "superting");

  let existing = null;
  try {
    existing = fs.lstatSync(target);
  } catch {
    existing = null;
  }
  if (existing) {
    const isOurs =
      (existing.isSymbolicLink() && fs.realpathSync(target) === fs.realpathSync(cliSource)) ||
      (existing.isFile() && !copy);
    if (!isOurs && !force) {
      console.error(`Refusing to overwrite existing ${target} (use --force)`);
      process.exit(1);
    }
    fs.rmSync(target, { force: true });
  }

  if (copy) {
    fs.copyFileSync(cliSource, target);
  } else {
    fs.symlinkSync(cliSource, target, "file");
  }
  fs.chmodSync(target, 0o755);

  const pathEnv = (process.env.PATH || "").split(path.delimiter);
  if (!pathEnv.includes(targetDir)) {
    console.warn(`WARNING: ${targetDir} is not on your PATH. Add it to use \`superting\`.`);
  }
  console.log(`Installed: ${target} -> ${copy ? "copy of" : cliSource}`);
}

main();
