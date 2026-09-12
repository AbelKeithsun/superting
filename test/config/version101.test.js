const test = require("node:test");
const assert = require("node:assert/strict");

const packageJson = require("../../package.json");
const packageLock = require("../../package-lock.json");

test("application and lockfile versions agree", () => {
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
});
