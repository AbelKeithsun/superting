const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const installer = require("../../cli/install-skills");

function tempProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superting-skills-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(argv) {
  const stdout = [];
  const stderr = [];
  const original = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => {
    stdout.push(chunk);
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr.push(chunk);
    return true;
  };
  try {
    return { code: installer.runCli(argv), stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
  }
}

test("install copies both skills into the project target with stamped version", (t) => {
  const project = tempProject(t);
  const result = run(["--project", project, "--format", "json"]);
  assert.equal(result.code, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.skills.length, 2);

  const cliSkill = path.join(project, ".claude", "skills", "superting-cli");
  const skillMd = fs.readFileSync(path.join(cliSkill, "SKILL.md"), "utf8");
  assert.match(skillMd, /^version: "\d+\.\d+\.\d+"/m);
  assert.ok(fs.existsSync(path.join(cliSkill, "references", "notes.md")));
  assert.ok(
    fs.existsSync(
      path.join(project, ".claude", "skills", "superting-api", "references", "routes.md")
    )
  );

  const manifest = JSON.parse(
    fs.readFileSync(path.join(cliSkill, installer.MANIFEST_NAME), "utf8")
  );
  assert.equal(manifest.version, payload.version);
  assert.ok(manifest.files["SKILL.md"]);
  assert.ok(manifest.files["references/notes.md"]);
});

test("reinstall is idempotent when nothing changed locally", (t) => {
  const project = tempProject(t);
  assert.equal(run(["--project", project]).code, 0);
  const again = run(["--project", project, "--format", "json"]);
  assert.equal(again.code, 0, again.stderr);
  const payload = JSON.parse(again.stdout);
  assert.equal(payload.skills[0].action, "updated");
});

test("reinstall refuses to clobber local edits unless --force", (t) => {
  const project = tempProject(t);
  assert.equal(run(["--project", project]).code, 0);
  const skillMd = path.join(project, ".claude", "skills", "superting-cli", "SKILL.md");
  fs.appendFileSync(skillMd, "\nlocal tweak\n");

  const refused = run(["--project", project, "--format", "json"]);
  assert.equal(refused.code, 1);
  const payload = JSON.parse(refused.stderr);
  assert.equal(payload.error.code, "LOCAL_EDITS");
  assert.ok(payload.error.edits.includes("SKILL.md"));
  assert.ok(
    fs.readFileSync(skillMd, "utf8").includes("local tweak"),
    "refusal must not touch files"
  );

  const forced = run(["--project", project, "--force", "--format", "json"]);
  assert.equal(forced.code, 0, forced.stderr);
  const forcedPayload = JSON.parse(forced.stdout);
  assert.equal(forcedPayload.skills[0].action, "force-overwritten");
  assert.equal(fs.readFileSync(skillMd, "utf8").includes("local tweak"), false);
});

test("--check reports up_to_date after install and stale before", (t) => {
  const project = tempProject(t);
  const stale = run(["--check", "--project", project, "--format", "json"]);
  assert.equal(stale.code, 1);
  assert.equal(JSON.parse(stale.stdout).up_to_date, false);

  assert.equal(run(["--project", project]).code, 0);
  const current = run(["--check", "--project", project, "--format", "json"]);
  assert.equal(current.code, 0);
  assert.equal(JSON.parse(current.stdout).up_to_date, true);
});

test("--remove uninstalls and is a safe no-op when absent", (t) => {
  const project = tempProject(t);
  assert.equal(run(["--project", project]).code, 0);
  const removed = run(["--remove", "--project", project, "--format", "json"]);
  assert.equal(removed.code, 0);
  assert.deepEqual(
    JSON.parse(removed.stdout).removed.map((r) => r.removed),
    [true, true]
  );
  assert.equal(fs.existsSync(path.join(project, ".claude", "skills", "superting-cli")), false);

  const again = run(["--remove", "--project", project, "--format", "json"]);
  assert.equal(again.code, 0);
  assert.deepEqual(
    JSON.parse(again.stdout).removed.map((r) => r.removed),
    [false, false]
  );
});

test("--only installs a single skill; unknown name is a usage error", (t) => {
  const project = tempProject(t);
  const result = run(["--project", project, "--only", "cli", "--format", "json"]);
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(
    payload.skills.map((s) => s.skill),
    ["superting-cli"]
  );

  const bad = run(["--project", project, "--only", "nope"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /Unknown skill/);
});

test("conflicting target flags and formats are usage errors", (t) => {
  assert.equal(run(["--global", "--project", "/tmp"]).code, 2);
  assert.equal(run(["--list", "--check"]).code, 2);
  assert.equal(run(["--format", "yaml"]).code, 2);
  assert.equal(run(["--bogus"]).code, 2);
});

test("installer works from the installed-package layout (flat dir, as npx installs it)", (t) => {
  const repo = path.resolve(__dirname, "..", "..");
  const fakeInstall = fs.mkdtempSync(path.join(os.tmpdir(), "superting-skills-layout-"));
  t.after(() => fs.rmSync(fakeInstall, { recursive: true, force: true }));

  fs.copyFileSync(
    path.join(repo, "cli", "install-skills.js"),
    path.join(fakeInstall, "install-skills.js")
  );
  fs.copyFileSync(path.join(repo, "package.json"), path.join(fakeInstall, "package.json"));
  fs.cpSync(path.join(repo, "agent-skills"), path.join(fakeInstall, "agent-skills"), {
    recursive: true,
  });

  const project = tempProject(t);
  const { execFileSync } = require("node:child_process");
  const stdout = execFileSync(
    process.execPath,
    [path.join(fakeInstall, "install-skills.js"), "--project", project, "--format", "json"],
    { encoding: "utf8" }
  );
  const payload = JSON.parse(stdout);
  assert.equal(payload.skills.length, 2);
  assert.ok(
    fs.existsSync(
      path.join(project, ".claude", "skills", "superting-cli", "references", "notes.md")
    )
  );
});

test("progressive disclosure: skills stay lean and references resolve", () => {
  const lintResult = run(["--list", "--format", "json"]);
  assert.equal(lintResult.code, 0);
  const payload = JSON.parse(lintResult.stdout);
  for (const { lint } of payload.skills) {
    assert.ok(lint.lines <= 120, `${lint.skill} SKILL.md too long: ${lint.lines} lines`);
    assert.ok(lint.references.length > 0, `${lint.skill} has no references/ layer`);
    assert.deepEqual(lint.issues, [], `${lint.skill} lint issues: ${lint.issues.join("; ")}`);
  }
});
