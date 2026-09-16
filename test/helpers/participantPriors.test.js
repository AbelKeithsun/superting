const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DatabaseManager = require("../../src/helpers/database");
const { findPreferredProfileMatch } = require("../../src/helpers/speakerTemplateMatching");

function createDatabase(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superting-participant-priors-"));
  const db = new DatabaseManager({ dbPath: path.join(root, "transcriptions.db") });
  t.after(() => {
    db.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return db;
}

const embeddingBuffer = (...values) => Buffer.from(new Float32Array(values).buffer);
const cosine = (a, b) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

// --- database: participant → profile resolution ---------------------------

test("participants resolve to speaker profiles by email or name, case-insensitive", (t) => {
  const db = createDatabase(t);
  const alice = db.upsertSpeakerProfile("Alice", "alice@corp.com", embeddingBuffer(1, 0, 0));
  const bob = db.upsertSpeakerProfile("Bob", null, embeddingBuffer(0, 1, 0));
  db.upsertSpeakerProfile("Carol", "carol@corp.com", embeddingBuffer(0, 0, 1));

  const ids = db.findSpeakerProfileIdsByParticipants([
    { email: "ALICE@corp.com", displayName: null },
    { email: null, displayName: "bob" },
    { email: "nobody@nowhere.com", displayName: "Nobody" },
  ]);

  assert.deepEqual(new Set(ids), new Set([alice.id, bob.id]));
});

test("empty or unknown participants yield no prior", (t) => {
  const db = createDatabase(t);
  db.upsertSpeakerProfile("Alice", "alice@corp.com", embeddingBuffer(1, 0, 0));

  assert.deepEqual(db.findSpeakerProfileIdsByParticipants([]), []);
  assert.deepEqual(db.findSpeakerProfileIdsByParticipants(null), []);
  assert.deepEqual(
    db.findSpeakerProfileIdsByParticipants([{ email: null, displayName: "Stranger" }]),
    []
  );
});

// --- matching: soft participant prior -------------------------------------

// Orthogonal identities keep the arithmetic predictable.
const orthogonalProfiles = () => [
  { id: 1, display_name: "Alice", embedding: new Float32Array([1, 0, 0]) },
  { id: 2, display_name: "Bob", embedding: new Float32Array([0, 1, 0]) },
  { id: 3, display_name: "Carol", embedding: new Float32Array([0, 0, 1]) },
];

test("preferred identity wins at the relaxed threshold", () => {
  // Probe is 0.62-similar to Carol (the only preferred identity): below the
  // normal 0.65 threshold but inside the relaxed prior band. The full library
  // would tie her with Alice and refuse (margin 0) — the prior rescues her.
  const probe = new Float32Array([0.62, 0, 0.784]);
  const result = findPreferredProfileMatch(probe, orthogonalProfiles(), cosine, {
    preferredIds: new Set([3]),
    threshold: 0.65,
    margin: 0.03,
    relax: 0.05,
  });

  assert.equal(result.usedPrior, true);
  assert.equal(result.profile?.id, 3);
});

test("a preferred identity below the relaxed band falls back to the full library", () => {
  // Probe matches Alice at 0.86 (above the normal threshold); Carol is the
  // preferred identity but at 0.50 — below the relaxed band, so the prior
  // must not force her.
  const probe = new Float32Array([0.86, 0.1, 0.5]);
  const result = findPreferredProfileMatch(probe, orthogonalProfiles(), cosine, {
    preferredIds: new Set([3]),
    threshold: 0.65,
    margin: 0.03,
    relax: 0.05,
  });

  assert.equal(result.usedPrior, false);
  assert.equal(result.profile?.id, 1);
});

test("prior pass enforces the margin between two preferred identities", () => {
  // Alice and Bob are both preferred and nearly identical to the probe —
  // no clear winner, so the prior pass must refuse and fall back.
  const profiles = [
    { id: 1, display_name: "Alice", embedding: new Float32Array([1, 0, 0]) },
    { id: 2, display_name: "Bob", embedding: new Float32Array([0.995, 0.0999, 0]) },
    { id: 3, display_name: "Carol", embedding: new Float32Array([0, 0, 1]) },
  ];
  const probe = new Float32Array([1, 0, 0]);
  const result = findPreferredProfileMatch(probe, profiles, cosine, {
    preferredIds: new Set([1, 2]),
    threshold: 0.65,
    margin: 0.5, // deliberately strict
    relax: 0.05,
  });

  assert.equal(result.usedPrior, false);
});

test("without preferred ids it behaves like plain matching", () => {
  const probe = new Float32Array([0.86, 0.1, 0.5]);
  const result = findPreferredProfileMatch(probe, orthogonalProfiles(), cosine, {
    preferredIds: null,
    threshold: 0.65,
    margin: 0.03,
    relax: 0.05,
  });

  assert.equal(result.usedPrior, false);
  assert.equal(result.profile?.id, 1);
});

test("no match anywhere returns null", () => {
  const probe = new Float32Array([0.4, 0.4, 0.4]);
  const result = findPreferredProfileMatch(probe, orthogonalProfiles(), cosine, {
    preferredIds: new Set([1]),
    threshold: 0.65,
    margin: 0.03,
    relax: 0.05,
  });

  assert.equal(result.profile, null);
});
