const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DatabaseManager = require("../../src/helpers/database");
const {
  toFloat32Embedding,
  similarityToProfile,
  findBestProfileMatch,
} = require("../../src/helpers/speakerTemplateMatching");

function createDatabase(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superting-multi-voiceprint-"));
  const db = new DatabaseManager({ dbPath: path.join(root, "transcriptions.db") });
  t.after(() => {
    db.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return db;
}

const embeddingBuffer = (...values) => Buffer.from(new Float32Array(values).buffer);

test("a person accumulates several voiceprint templates instead of overwriting one", (t) => {
  const db = createDatabase(t);
  const person = db.createPerson({ displayName: "Alice" });

  const first = db.addVoiceprint(person.id, embeddingBuffer(1, 0, 0), { sourceProfileId: 7 });
  const second = db.addVoiceprint(person.id, embeddingBuffer(0, 1, 0), { sourceProfileId: 7 });

  assert.notEqual(first.id, second.id, "same profile must not collapse into one row");
  assert.equal(db.countVoiceprints(person.id), 2);
  assert.equal(db.listVoiceprints(person.id).length, 2);
});

test("replacing a template rewrites it in place and drops its audition clips", (t) => {
  const db = createDatabase(t);
  const person = db.createPerson({ displayName: "Bob" });
  const noteA = db.saveNote("Meeting A", "", "personal").note;
  const noteB = db.saveNote("Meeting B", "", "personal").note;
  const voiceprint = db.addVoiceprint(person.id, embeddingBuffer(1, 0, 0), {
    sourceNoteId: noteA.id,
  });
  db.addVoiceprintSegments(voiceprint.id, [
    { noteId: noteA.id, speakerId: "speaker_0", startSeconds: 1, endSeconds: 3 },
  ]);
  assert.equal(db.listVoiceprintSegments(voiceprint.id).length, 1);

  const replaced = db.replaceVoiceprint(voiceprint.id, embeddingBuffer(0, 1, 0), {
    sampleCount: 2,
    sourceNoteId: noteB.id,
  });

  assert.equal(replaced.id, voiceprint.id);
  assert.equal(replaced.source_note_id, noteB.id);
  assert.equal(replaced.sample_count, 2);
  assert.equal(db.countVoiceprints(person.id), 1);
  assert.equal(db.listVoiceprintSegments(voiceprint.id).length, 0, "stale clips must go");
});

test("upsertVoiceprintByProfile stays idempotent for the legacy migration path", (t) => {
  const db = createDatabase(t);
  const person = db.createPerson({ displayName: "Carol" });

  db.upsertVoiceprintByProfile(person.id, embeddingBuffer(1, 0, 0), { sourceProfileId: 11 });
  db.upsertVoiceprintByProfile(person.id, embeddingBuffer(0, 1, 0), { sourceProfileId: 11 });
  db.upsertVoiceprintByProfile(person.id, embeddingBuffer(0, 0, 1), { sourceProfileId: 12 });

  assert.equal(db.countVoiceprints(person.id), 2);
});

test("getSpeakerProfiles carries every template of the identity", (t) => {
  const db = createDatabase(t);
  const person = db.createPerson({ displayName: "Dana", email: "dana@example.com" });
  const profile = db.upsertSpeakerProfile("Dana", "dana@example.com", embeddingBuffer(1, 0, 0));
  db.addVoiceprint(person.id, embeddingBuffer(0, 1, 0), { sourceProfileId: profile.id });
  db.addVoiceprint(person.id, embeddingBuffer(0, 0, 1), { sourceProfileId: profile.id });

  const [enriched] = db.getSpeakerProfiles(true).filter((entry) => entry.id === profile.id);

  assert.equal(enriched.embeddings.length, 3, "own centroid + two templates");
});

test("matching scores an identity by its best template and keeps the margin", () => {
  const cosineSimilarity = (a, b) => {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  };

  const probe = new Float32Array([1, 0, 0]);
  const alice = {
    id: 1,
    embedding: embeddingBuffer(0.2, 0.98, 0),
    embeddings: [embeddingBuffer(0.2, 0.98, 0), embeddingBuffer(1, 0, 0)],
  };
  const bob = { id: 2, embedding: embeddingBuffer(0, 1, 0) };

  const match = findBestProfileMatch(probe, [alice, bob], cosineSimilarity);

  assert.equal(match.profile.id, 1, "the second Alice template must win");
  assert.ok(match.similarity > 0.99);
  assert.ok(match.margin > 0.99, "templates of one identity must not compete");
  assert.equal(
    similarityToProfile(probe, { embedding: alice.embedding }, cosineSimilarity).toFixed(2),
    "0.20"
  );
});

test("float32 BLOBs are compared as values, not as raw bytes", () => {
  const buffer = embeddingBuffer(1, 0, 0);
  const view = toFloat32Embedding(buffer);

  assert.ok(view instanceof Float32Array);
  assert.deepEqual(Array.from(view), [1, 0, 0]);
});
