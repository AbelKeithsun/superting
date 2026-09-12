#!/usr/bin/env node
// Packs the skills installer into a zero-dependency npm tarball for release assets:
//   dist/superting-skills-<version>.tgz
//
// The tarball contains ONLY the installer + skill files (no app dependencies), so
// agents can install the skills version-matched to a release in seconds:
//   npx -p https://github.com/AbelKeithsun/superting/releases/download/v<version>/superting-skills-<version>.tgz superting-skills --global
//
// Layout inside the tarball mirrors the repo so cli/install-skills.js works unchanged:
//   package/package.json        tiny manifest (name superting-skills, bin)
//   package/install-skills.js   copy of cli/install-skills.js
//   package/agent-skills/**     skill sources

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "superting-skills-pack-"));
const packageDir = path.join(staging, "package");
fs.mkdirSync(path.join(packageDir, "agent-skills"), { recursive: true });

fs.writeFileSync(
  path.join(packageDir, "package.json"),
  JSON.stringify(
    {
      name: "superting-skills",
      version,
      description: `SuperTing agent skills (v${version}) — install with: npx -p superting-skills-<version>.tgz superting-skills`,
      bin: { "superting-skills": "install-skills.js" },
      files: ["install-skills.js", "agent-skills"],
      license: "MIT",
    },
    null,
    2
  ) + "\n"
);

fs.copyFileSync(
  path.join(repoRoot, "cli", "install-skills.js"),
  path.join(packageDir, "install-skills.js")
);
fs.chmodSync(path.join(packageDir, "install-skills.js"), 0o755);

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
copyDir(path.join(repoRoot, "agent-skills"), path.join(packageDir, "agent-skills"));

const distDir = path.join(repoRoot, "dist");
fs.mkdirSync(distDir, { recursive: true });
const pack = spawnSync("npm", ["pack", packageDir, "--pack-destination", distDir], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (pack.status !== 0) {
  console.error(pack.stderr || pack.stdout);
  process.exit(1);
}

const tgzName = `superting-skills-${version}.tgz`;
const tgzPath = path.join(distDir, tgzName);
const sizeKb = Math.round(fs.statSync(tgzPath).size / 1024);
console.log(`Packed: ${tgzPath} (${sizeKb} KB)`);
console.log(
  `Install: npx -p https://github.com/AbelKeithsun/superting/releases/download/v${version}/${tgzName} superting-skills --global`
);
fs.rmSync(staging, { recursive: true, force: true });
