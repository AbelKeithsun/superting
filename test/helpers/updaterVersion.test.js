const assert = require("node:assert/strict");
const test = require("node:test");

const { isNewerVersion, normalizeVersion } = require("../../src/updater.js");

test("normalizeVersion strips the release tag prefix and suffix", () => {
  assert.equal(normalizeVersion("v2.0.10"), "2.0.10");
  assert.equal(normalizeVersion("2.0.9"), "2.0.9");
  assert.equal(normalizeVersion("v2.1.0-beta.1"), "2.1.0");
  assert.equal(normalizeVersion(""), "");
});

test("isNewerVersion compares patch, minor and major releases", () => {
  assert.equal(isNewerVersion("2.0.9", "2.0.8"), true);
  assert.equal(isNewerVersion("2.0.8", "2.0.8"), false);
  assert.equal(isNewerVersion("2.0.7", "2.0.8"), false);
  assert.equal(isNewerVersion("2.1.0", "2.0.99"), true);
  assert.equal(isNewerVersion("3.0.0", "2.99.99"), true);
  assert.equal(isNewerVersion("v2.1.0", "2.0.8"), true);
});

test("isNewerVersion tolerates uneven version lengths", () => {
  assert.equal(isNewerVersion("2.1", "2.0.8"), true);
  assert.equal(isNewerVersion("2.0", "2.0.0"), false);
  assert.equal(isNewerVersion("2.0.0.1", "2.0.0"), true);
});

test("isNewerVersion does not flag a rebuild of the same version", () => {
  // The installed 2.0.10 build must not be told 2.0.10 is available.
  assert.equal(isNewerVersion("2.0.10", "2.0.10"), false);
});
