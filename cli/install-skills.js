#!/usr/bin/env node
// SuperTing skills installer — zero-dependency companion to the agent CLI.
//
// Installs the bundled agent skills (agent-skills/superting-cli, agent-skills/superting-api)
// into an agent skills directory, stamping them with this package's version so skills
// and the `superting` CLI always update in lockstep.
//
// Targets:
//   (default)            <cwd>/.claude/skills          (current project)
//   --project <dir>      <dir>/.claude/skills
//   --global             ~/.agents/skills              (override: SUPERTING_SKILLS_GLOBAL_DIR)
//   --target <dir>       <dir> verbatim
//
// Operations:
//   install (default) | --list | --check | --remove
//   --force   overwrite local edits (detected via sha256 manifest)
//   --only cli|api          install a single skill
//   --format json|text      output format (default text)
//
// Progressive disclosure: each skill is a small SKILL.md plus a references/ folder
// that agents read only when they need the detail. Both are copied verbatim.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

const KNOWN_SKILLS = ["superting-cli", "superting-api"];
const MANIFEST_NAME = ".superting-skills-meta.json";

// Two layouts share this script:
//   repo checkout:  <root>/cli/install-skills.js  + <root>/agent-skills/  + <root>/package.json
//   npm/npx tarball: <pkg>/install-skills.js      + <pkg>/agent-skills/  + <pkg>/package.json
function findPackageRoot() {
  for (const candidate of [path.resolve(__dirname, ".."), path.resolve(__dirname)]) {
    if (
      fs.existsSync(path.join(candidate, "agent-skills", KNOWN_SKILLS[0], "SKILL.md")) &&
      fs.existsSync(path.join(candidate, "package.json"))
    ) {
      return candidate;
    }
  }
  throw new Error("Cannot locate agent-skills/ and package.json next to install-skills.js");
}

const PACKAGE_ROOT = findPackageRoot();
const SKILLS_SOURCE_DIR = path.join(PACKAGE_ROOT, "agent-skills");

class UsageError extends Error {}

function readPackageVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  if (!pkg.version) throw new Error("package.json has no version");
  return pkg.version;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function listSkillFiles(skillDir) {
  const files = [];
  const walk = (dir, rel) => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === MANIFEST_NAME) continue;
      const abs = path.join(dir, entry.name);
      const relPath = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(abs, relPath);
      else if (entry.isFile()) files.push({ abs, rel: relPath });
    }
  };
  walk(skillDir, "");
  return files;
}

function copyTree(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Inserts or replaces a `version: "X.Y.Z"` line in the SKILL.md frontmatter. */
function stampVersion(skillDir, version) {
  const skillFile = path.join(skillDir, "SKILL.md");
  let text = fs.readFileSync(skillFile, "utf8");
  const line = `version: "${version}"`;
  if (/^version: .*$/m.test(text)) {
    text = text.replace(/^version: .*$/m, line);
  } else if (/^(---\n[\s\S]*?\n---)/.test(text)) {
    text = text.replace(/^(---\n[\s\S]*?)\n---/, `$1\n${line}\n---`);
  } else {
    throw new Error(`${skillFile} has no frontmatter block`);
  }
  fs.writeFileSync(skillFile, text);
}

function readInstalledManifest(skillDest) {
  try {
    return JSON.parse(fs.readFileSync(path.join(skillDest, MANIFEST_NAME), "utf8"));
  } catch {
    return null;
  }
}

/** Files changed locally since the last install (per the previous manifest). */
function localEdits(skillDest) {
  const manifest = readInstalledManifest(skillDest);
  if (!manifest || !manifest.files) return null; // not installed by us / unknown
  const edits = [];
  for (const { abs, rel } of listSkillFiles(skillDest)) {
    const relKey = rel.split(path.sep).join("/");
    const expected = manifest.files[relKey];
    if (expected === undefined) {
      edits.push(relKey);
      continue;
    }
    let actual;
    try {
      actual = sha256File(abs);
    } catch {
      edits.push(relKey);
      continue;
    }
    if (actual !== expected) edits.push(relKey);
  }
  return edits;
}

function installSkill(skillName, version, targetDir, { force }) {
  const sourceDir = path.join(SKILLS_SOURCE_DIR, skillName);
  const skillDest = path.join(targetDir, skillName);
  const result = { skill: skillName, dest: skillDest, action: "installed", updated: false };

  if (fs.existsSync(skillDest)) {
    const edits = localEdits(skillDest);
    if (edits && edits.length > 0 && !force) {
      const err = new Error(
        `${skillName} has local modifications at ${skillDest} (${edits.join(", ")}). ` +
          "Re-run with --force to discard them."
      );
      err.code = "LOCAL_EDITS";
      err.edits = edits;
      throw err;
    }
    result.action = edits && edits.length > 0 && force ? "force-overwritten" : "updated";
    result.updated = true;
    fs.rmSync(skillDest, { recursive: true, force: true });
  }

  copyTree(sourceDir, skillDest);
  stampVersion(skillDest, version);

  const files = {};
  for (const { abs, rel } of listSkillFiles(skillDest)) {
    files[rel.split(path.sep).join("/")] = sha256File(abs);
  }
  fs.writeFileSync(
    path.join(skillDest, MANIFEST_NAME),
    JSON.stringify({ version, installedAt: new Date().toISOString(), files }, null, 2)
  );
  return result;
}

function removeSkill(skillName, targetDir) {
  const skillDest = path.join(targetDir, skillName);
  if (!fs.existsSync(skillDest)) {
    return { skill: skillName, dest: skillDest, removed: false };
  }
  fs.rmSync(skillDest, { recursive: true, force: true });
  return { skill: skillName, dest: skillDest, removed: true };
}

function resolveTargetDir(options) {
  if (options.target) return path.resolve(options.target);
  if (options.global) {
    const override = process.env.SUPERTING_SKILLS_GLOBAL_DIR;
    return override ? path.resolve(override) : path.join(os.homedir(), ".agents", "skills");
  }
  if (options.project) return path.join(path.resolve(options.project), ".claude", "skills");
  return path.join(process.cwd(), ".claude", "skills");
}

function availableSkills(only) {
  const shortNames = { cli: "superting-cli", api: "superting-api" };
  const names = only ? [shortNames[only] || only] : KNOWN_SKILLS;
  for (const name of names) {
    if (!KNOWN_SKILLS.includes(name)) {
      throw new UsageError(`Unknown skill "${name}" (available: ${KNOWN_SKILLS.join(", ")})`);
    }
    if (!fs.existsSync(path.join(SKILLS_SOURCE_DIR, name, "SKILL.md"))) {
      throw new Error(`Bundled skill missing: ${name}`);
    }
  }
  return names;
}

/** Compares installed skill versions against this installer's version. */
function checkStatus(targetDir, version, names) {
  return names.map((name) => {
    const manifest = readInstalledManifest(path.join(targetDir, name));
    const installed = manifest?.version || null;
    return {
      skill: name,
      installed_version: installed,
      available_version: version,
      up_to_date: installed === version,
    };
  });
}

/** Progressive-disclosure lint: SKILL.md stays lean and points only at real files. */
function lintSkill(name) {
  const skillDir = path.join(SKILLS_SOURCE_DIR, name);
  const text = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  const issues = [];
  const lines = text.split("\n").length;
  if (lines > 500) issues.push(`SKILL.md too long (${lines} lines, limit 500)`);
  if (!/^---\nname: /.test(text)) issues.push("missing name in frontmatter");
  if (!/^description: /m.test(text)) issues.push("missing description in frontmatter");
  const refsDir = path.join(skillDir, "references");
  const refFiles = fs.existsSync(refsDir) ? fs.readdirSync(refsDir) : [];
  for (const match of text.matchAll(/\]\(references\/([^)]+)\)/g)) {
    if (!refFiles.includes(match[1]))
      issues.push(`SKILL.md links to missing references/${match[1]}`);
  }
  return { skill: name, lines, references: refFiles, issues };
}

function parseArgs(argv) {
  const options = { format: "text" };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new UsageError(`Flag ${token} expects a value`);
      return argv[++i];
    };
    switch (token) {
      case "--global":
        options.global = true;
        break;
      case "--project":
        options.project = value();
        break;
      case "--target":
        options.target = value();
        break;
      case "--only":
        options.only = value();
        break;
      case "--force":
        options.force = true;
        break;
      case "--list":
        options.list = true;
        break;
      case "--check":
        options.check = true;
        break;
      case "--remove":
        options.remove = true;
        break;
      case "--format":
        options.format = value();
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new UsageError(`Unknown argument "${token}"`);
    }
  }
  const modes = [options.list, options.check, options.remove].filter(Boolean).length;
  if (modes > 1) throw new UsageError("--list, --check and --remove are mutually exclusive");
  if (options.format !== "text" && options.format !== "json") {
    throw new UsageError(`--format must be "text" or "json", got "${options.format}"`);
  }
  const targets = [options.global, options.project, options.target].filter(Boolean).length;
  if (targets > 1) throw new UsageError("--global, --project and --target are mutually exclusive");
  return options;
}

function emit(options, payload, textLines) {
  if (options.format === "json") process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${textLines.join("\n")}\n`);
}

function usage() {
  return [
    "superting-skills [operation] [target] [flags]",
    "",
    "Install SuperTing agent skills (versioned with the superting CLI).",
    "",
    "Operations:",
    "  (default)  install skills",
    "  --list     show bundled skills, versions, and target path",
    "  --check    compare installed vs available versions",
    "  --remove   uninstall skills from the target",
    "",
    "Targets (mutually exclusive):",
    "  (default)      <cwd>/.claude/skills",
    "  --global       ~/.agents/skills (SUPERTING_SKILLS_GLOBAL_DIR overrides)",
    "  --project <d>  <d>/.claude/skills",
    "  --target <d>   <d> verbatim",
    "",
    "Flags:",
    "  --only cli|api   operate on a single skill",
    "  --force          overwrite locally modified skills",
    "  --format text|json",
  ].join("\n");
}

function runCli(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${usage()}\n`);
    return EXIT_USAGE;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return EXIT_OK;
  }

  try {
    const version = readPackageVersion();
    const names = availableSkills(options.only);
    const targetDir = resolveTargetDir(options);

    if (options.list) {
      const payload = {
        version,
        target: targetDir,
        skills: names.map((name) => ({
          skill: name,
          source: path.join(SKILLS_SOURCE_DIR, name),
          lint: lintSkill(name),
        })),
      };
      emit(
        options,
        payload,
        [`skills version: ${version}`, `target: ${targetDir}`].concat(
          payload.skills.map(
            (s) =>
              `  ${s.skill}  (${s.lint.lines} lines, references: ${s.lint.references.join(", ") || "none"})`
          )
        )
      );
      return EXIT_OK;
    }

    if (options.check) {
      const statuses = checkStatus(targetDir, version, names);
      const allCurrent = statuses.every((s) => s.up_to_date);
      emit(
        options,
        { version, target: targetDir, up_to_date: allCurrent, skills: statuses },
        [
          `skills version: ${version} | target: ${targetDir} | ${allCurrent ? "up to date" : "UPDATE AVAILABLE"}`,
        ].concat(
          statuses.map(
            (s) => `  ${s.skill}: installed=${s.installed_version || "none"} available=${version}`
          )
        )
      );
      return allCurrent ? EXIT_OK : EXIT_ERROR;
    }

    if (options.remove) {
      const removed = names.map((name) => removeSkill(name, targetDir));
      emit(
        options,
        { target: targetDir, removed },
        removed.map((r) => `${r.removed ? "removed" : "not installed"}: ${r.dest}`)
      );
      return EXIT_OK;
    }

    fs.mkdirSync(targetDir, { recursive: true });
    const results = names.map((name) =>
      installSkill(name, version, targetDir, { force: !!options.force })
    );
    emit(
      options,
      { version, target: targetDir, skills: results },
      [`installed skills version ${version} -> ${targetDir}`].concat(
        results.map((r) => `  ${r.skill}: ${r.action} (${r.dest})`)
      )
    );
    return EXIT_OK;
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${usage()}\n`);
      return EXIT_USAGE;
    }
    const payload = {
      error: {
        code: err.code || "installer_error",
        message: err.message,
        ...(err.edits ? { edits: err.edits } : {}),
      },
    };
    process.stderr.write(
      options.format === "json" ? `${JSON.stringify(payload, null, 2)}\n` : `${err.message}\n`
    );
    return EXIT_ERROR;
  }
}

module.exports = {
  runCli,
  parseArgs,
  resolveTargetDir,
  stampVersion,
  localEdits,
  lintSkill,
  KNOWN_SKILLS,
  MANIFEST_NAME,
};

if (require.main === module) {
  process.exit(runCli(process.argv.slice(2)));
}
