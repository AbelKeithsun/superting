#!/usr/bin/env node
"use strict";

/**
 * Overlay the current working tree onto an already-installed SuperTing bundle's
 * app.asar, without running electron-builder or re-downloading native binaries.
 *
 * Why: a full `npm run build:mac` re-fetches ~250 MB of sidecar binaries and
 * needs packaging tooling, while a code-only change only has to update the JS
 * inside the archive. This script keeps the original data section byte-for-byte
 * (untouched entries keep their offsets, so their integrity hashes stay valid),
 * appends new/changed files at the end, rewrites the header with correct
 * per-file integrity, and updates ElectronAsarIntegrity in Info.plist — which
 * must be sha256 of the header JSON bytes alone (padding excluded).
 *
 * Usage:
 *   node scripts/overlay-local-asar.js --app /Applications/SuperTing.app [--dry-run]
 *                                     [--backup-dir ~/.cache/superting-asar-backup]
 *                                     [--bundle-version 2.0.12]
 *
 * Overlay set: main.js, preload.js, package.json and the `src/` subtrees that
 * ship inside the archive (src/dist is synced exactly — stale chunks are
 * dropped from the index; everything else is add/replace).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const REPO_ROOT = path.join(__dirname, "..");
const BLOCK_SIZE = 4 * 1024 * 1024;
// Subtrees that are shipped inside the asar and match the repo layout 1:1.
const OVERLAY_TREES = [
  "src/dist",
  "src/helpers",
  "src/config",
  "src/constants",
  "src/locales",
  "src/models",
  "src/types",
  "src/utils",
  "src/services",
  "src/hooks",
];
// Only src/dist is synced exactly (its chunk set changes between builds).
const EXACT_TREES = new Set(["src/dist"]);
const OVERLAY_FILES = ["main.js", "preload.js", "package.json"];

function parseArgs(argv) {
  const args = { app: null, dryRun: false, backupDir: null, bundleVersion: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--app") args.app = argv[++i];
    else if (arg === "--backup-dir") args.backupDir = argv[++i];
    else if (arg === "--bundle-version") args.bundleVersion = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.app) throw new Error("--app <path to .app bundle> is required");
  if (!args.backupDir) {
    args.backupDir = path.join(os.homedir(), ".cache", "superting-asar-backup");
  }
  return args;
}

function readAsar(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const pickleSize = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
    const dataStart = 8 + pickleSize;
    const stat = fs.fstatSync(fd);
    const data = Buffer.alloc(stat.size - dataStart);
    fs.readSync(fd, data, 0, data.length, dataStart);
    return { header: JSON.parse(jsonBuf.toString("utf8")), jsonBuf, pickleSize, dataStart, data };
  } finally {
    fs.closeSync(fd);
  }
}

function writeAsar(asarPath, header, data) {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const pad = (4 - ((4 + json.length) % 4)) % 4;
  const headerStringSize = 4 + json.length + pad; // length field + json + padding
  const pickleSize = 4 + headerStringSize;
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(pickleSize, 4);
  const pickleHead = Buffer.alloc(8);
  pickleHead.writeUInt32LE(headerStringSize, 0);
  pickleHead.writeUInt32LE(json.length, 4);
  const body = Buffer.concat([prefix, pickleHead, json, Buffer.alloc(pad), data]);
  fs.writeFileSync(asarPath, body);
  return { jsonHash: crypto.createHash("sha256").update(json).digest("hex"), size: body.length };
}

function integrityFor(buffer) {
  const blocks = [];
  for (let offset = 0; offset < buffer.length; offset += BLOCK_SIZE) {
    blocks.push(
      crypto
        .createHash("sha256")
        .update(buffer.subarray(offset, Math.min(offset + BLOCK_SIZE, buffer.length)))
        .digest("hex")
    );
  }
  return {
    algorithm: "SHA256",
    hash: crypto.createHash("sha256").update(buffer).digest("hex"),
    blockSize: BLOCK_SIZE,
    blocks,
  };
}

function listFiles(root, base = root, out = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else if (entry.isFile()) out.push(full);
    // symlinks inside dist are not expected; ignore anything else
  }
  return out;
}

function ensureDirNode(header, relPath) {
  const parts = relPath.split("/");
  let node = header;
  for (const part of parts.slice(0, -1)) {
    node.files = node.files || {};
    node.files[part] = node.files[part] || { files: {} };
    node = node.files[part];
  }
  return { node, name: parts[parts.length - 1] };
}

function getEntry(header, relPath) {
  const parts = relPath.split("/");
  let node = header;
  for (const part of parts) {
    if (!node?.files?.[part]) return null;
    node = node.files[part];
  }
  return node;
}

function removeEntry(header, relPath) {
  const parts = relPath.split("/");
  let node = header;
  for (const part of parts.slice(0, -1)) {
    node = node?.files?.[part];
    if (!node) return;
  }
  if (node.files) delete node.files[parts[parts.length - 1]];
}

/** Collect the repo files that must be overlaid, keyed by asar-relative path. */
function collectOverlay(dryRunLog) {
  const overlay = new Map();
  for (const rel of OVERLAY_FILES) {
    const full = path.join(REPO_ROOT, rel);
    if (fs.existsSync(full)) overlay.set(rel, full);
  }
  for (const tree of OVERLAY_TREES) {
    const dir = path.join(REPO_ROOT, tree);
    if (!fs.existsSync(dir)) {
      dryRunLog.push(`skip missing tree ${tree}`);
      continue;
    }
    for (const file of listFiles(dir)) {
      overlay.set(path.relative(REPO_ROOT, file).split(path.sep).join("/"), file);
    }
  }
  return overlay;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const resourcesDir = path.join(args.app, "Contents", "Resources");
  const asarPath = path.join(resourcesDir, "app.asar");
  const infoPlistPath = path.join(args.app, "Contents", "Info.plist");
  if (!fs.existsSync(asarPath)) throw new Error(`app.asar not found at ${asarPath}`);

  const notes = [];
  const overlay = collectOverlay(notes);

  const { header, data } = readAsar(asarPath);
  const oldDataLength = data.length;

  // 1) exact sync for src/dist (drop entries the build no longer produces)
  const dropped = [];
  for (const tree of EXACT_TREES) {
    const keep = new Set([...overlay.keys()].filter((key) => key.startsWith(`${tree}/`)));
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries({ ...(node.files || {}) })) {
        const rel = prefix ? `${prefix}/${name}` : name;
        if (child.files) {
          walk(child, rel);
          if (child.files && Object.keys(child.files).length === 0) delete node.files[name];
          continue;
        }
        if (!keep.has(rel)) {
          delete node.files[name];
          dropped.push(rel);
        }
      }
    };
    const target = getEntry(header, tree);
    if (target) walk(target, tree);
  }

  // 2) append overlay content at the end of the data section
  const appended = [];
  let cursor = oldDataLength;
  let changed = 0;
  let added = 0;
  for (const [rel, full] of overlay) {
    const content = fs.readFileSync(full);
    const existing = getEntry(header, rel);
    const same =
      existing &&
      typeof existing.size === "number" &&
      existing.size === content.length &&
      typeof existing.offset === "string" &&
      crypto
        .createHash("sha256")
        .update(data.subarray(Number(existing.offset), Number(existing.offset) + existing.size))
        .digest("hex") === crypto.createHash("sha256").update(content).digest("hex");
    if (same) continue;

    const { node, name } = ensureDirNode(header, rel);
    node.files = node.files || {};
    node.files[name] = {
      size: content.length,
      offset: String(cursor),
      integrity: integrityFor(content),
    };
    appended.push(content);
    cursor += content.length;
    if (existing) changed += 1;
    else added += 1;
  }

  const newData = appended.length > 0 ? Buffer.concat([data, ...appended]) : data;
  const summary = {
    app: args.app,
    overlayCandidates: overlay.size,
    added,
    changed,
    dropped: dropped.length,
    oldDataLength,
    newDataLength: newData.length,
    growth: newData.length - oldDataLength,
  };

  if (args.dryRun) {
    console.log(JSON.stringify({ ...summary, dryRun: true, notes }, null, 2));
    console.log("dropped sample:", dropped.slice(0, 10));
    return;
  }

  // 3) backup + write
  fs.mkdirSync(args.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupAsar = path.join(args.backupDir, `app.asar.${stamp}`);
  fs.copyFileSync(asarPath, backupAsar);
  fs.copyFileSync(infoPlistPath, path.join(args.backupDir, `Info.plist.${stamp}`));

  const tmpAsar = `${asarPath}.new`;
  const { jsonHash } = writeAsar(tmpAsar, header, newData);
  fs.renameSync(tmpAsar, asarPath);

  // 4) ElectronAsarIntegrity → sha256 of the header JSON bytes (no padding)
  let plist = fs.readFileSync(infoPlistPath, "utf8");
  const integrityKey = "Resources/app.asar";
  const escapedKey = integrityKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hashPattern = new RegExp(
    `(<key>${escapedKey}<\\/key>[\\s\\S]*?<key>hash<\\/key>\\s*<string>)([a-f0-9]{64})(</string>)`
  );
  if (!hashPattern.test(plist)) {
    throw new Error("ElectronAsarIntegrity hash for app.asar not found in Info.plist");
  }
  plist = plist.replace(hashPattern, `$1${jsonHash}$3`);
  if (args.bundleVersion) {
    plist = plist
      .replace(
        /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/,
        `$1${args.bundleVersion}$2`
      )
      .replace(
        /(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/,
        `$1${args.bundleVersion}$2`
      );
  }
  fs.writeFileSync(infoPlistPath, plist);

  console.log(
    JSON.stringify(
      {
        ...summary,
        backup: backupAsar,
        asarIntegrityHash: jsonHash,
        bundleVersion: args.bundleVersion ?? "unchanged",
      },
      null,
      2
    )
  );
  if (notes.length > 0) console.log("notes:", notes.join("; "));
}

if (require.main === module) main();

module.exports = { integrityFor, readAsar, writeAsar };
