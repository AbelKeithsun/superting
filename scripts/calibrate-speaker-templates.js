#!/usr/bin/env node
/**
 * Offline calibration for voiceprint-template matching (option ②: an identity
 * scores as its best-matching template).
 *
 * It reads the local app database and uses the user's own speaker marks as
 * ground truth: every (note_id, speaker_id) that is bound to a profile is a
 * probe of that identity. For each probe it compares
 *
 *   baseline  — similarity to the profile's own (blended) centroid
 *   templates — max similarity over that identity's voiceprint templates
 *
 * and reports, per threshold, the true-positive rate, the false-positive rate
 * and the best/second-best margin, so the thresholds in
 * src/constants/speakerThresholds.json can be re-tuned on real data.
 *
 * Usage:
 *   node scripts/calibrate-speaker-templates.js \
 *     [--db "<userData>/transcriptions.db"] [--json]
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_DB_CANDIDATES = [
  path.join(os.homedir(), "Library/Application Support/superting/transcriptions.db"),
  path.join(os.homedir(), "Library/Application Support/SuperTing-development/transcriptions.db"),
];

function parseArgs(argv) {
  const args = { db: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--db") args.db = argv[++i];
  }
  return args;
}

function toFloat32(value) {
  if (!value?.length) return null;
  if (value instanceof Float32Array) return value;
  if (ArrayBuffer.isView(value) && value.byteLength % 4 === 0) {
    return new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4);
  }
  return null;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function loadDataset(db) {
  const profiles = db.prepare("SELECT id, display_name, embedding FROM speaker_profiles").all();
  const voiceprints = db
    .prepare("SELECT id, person_id, source_profile_id, embedding FROM voiceprints")
    .all();
  const people = db.prepare("SELECT id, display_name, email FROM people").all();
  const mappings = db
    .prepare("SELECT note_id, speaker_id, profile_id FROM speaker_mappings WHERE profile_id IS NOT NULL")
    .all();
  const noteEmbeddings = db.prepare("SELECT note_id, speaker_id, embedding FROM note_speaker_embeddings").all();

  const templatesByProfile = new Map();
  const profileIdByPerson = new Map();
  for (const profile of profiles) {
    if (profile.embedding) {
      templatesByProfile.set(profile.id, [toFloat32(profile.embedding)].filter(Boolean));
    }
  }
  for (const row of voiceprints) {
    const vector = toFloat32(row.embedding);
    if (!vector) continue;
    let target = row.source_profile_id ?? null;
    if (target == null && row.person_id != null) target = profileIdByPerson.get(row.person_id) ?? null;
    if (target == null) continue;
    const list = templatesByProfile.get(target) || [];
    list.push(vector);
    templatesByProfile.set(target, list);
  }
  // Person → profile fallback by display name, for rows without source_profile_id.
  for (const person of people) {
    const profile = profiles.find(
      (entry) => entry.display_name && entry.display_name === person.display_name
    );
    if (profile) profileIdByPerson.set(person.id, profile.id);
  }
  for (const row of voiceprints) {
    if (row.source_profile_id != null || row.person_id == null) continue;
    const target = profileIdByPerson.get(row.person_id);
    const vector = toFloat32(row.embedding);
    if (target == null || !vector) continue;
    const list = templatesByProfile.get(target) || [];
    if (!list.includes(vector)) list.push(vector);
    templatesByProfile.set(target, list);
  }

  const embeddingByKey = new Map();
  for (const row of noteEmbeddings) embeddingByKey.set(`${row.note_id}:${row.speaker_id}`, row.embedding);

  const probes = [];
  for (const mapping of mappings) {
    const probe = toFloat32(embeddingByKey.get(`${mapping.note_id}:${mapping.speaker_id}`));
    if (probe) probes.push({ probe, identityId: mapping.profile_id });
  }

  return { profiles, templatesByProfile, probes };
}

function evaluate(dataset, { useTemplates }) {
  const { profiles, templatesByProfile, probes } = dataset;
  const identityIds = profiles
    .map((profile) => profile.id)
    .filter((id) => (templatesByProfile.get(id) || []).length > 0);
  const ownSimilarities = [];
  const foreignSimilarities = [];
  const margins = [];
  const scores = [];

  for (const { probe, identityId } of probes) {
    let best = -Infinity;
    let bestId = null;
    let second = -Infinity;
    for (const id of identityIds) {
      const templates = templatesByProfile.get(id) || [];
      const own = templates[0];
      const candidates = useTemplates ? templates : [own];
      let value = -Infinity;
      for (const candidate of candidates) {
        const similarity = cosineSimilarity(probe, candidate);
        if (similarity > value) value = similarity;
      }
      if (id === identityId) ownSimilarities.push(value);
      else foreignSimilarities.push(value);
      if (value > best) {
        second = best;
        best = value;
        bestId = id;
      } else if (value > second) {
        second = value;
      }
    }
    if (bestId === identityId) margins.push(best - second);
    scores.push({ identityId, best, bestId, second });
  }

  const thresholds = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75];
  const rows = thresholds.map((threshold) => {
    const truePositives = scores.filter(
      (entry) => entry.identityId === entry.bestId && entry.best >= threshold
    ).length;
    const falsePositives = foreignSimilarities.filter((value) => value >= threshold).length;
    return {
      threshold,
      truePositiveRate: scores.length ? truePositives / scores.length : 0,
      falsePositiveRate: foreignSimilarities.length ? falsePositives / foreignSimilarities.length : 0,
    };
  });

  const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

  return {
    probes: probes.length,
    identities: identityIds.length,
    ownSimilarityMean: mean(ownSimilarities),
    foreignSimilarityMean: mean(foreignSimilarities),
    marginMean: mean(margins),
    thresholdRows: rows,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.db || DEFAULT_DB_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!dbPath || !fs.existsSync(dbPath)) {
    console.error("No database found. Pass --db <path>.");
    process.exit(2);
  }
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (error) {
    console.error("better-sqlite3 is required (run inside the repo with node_modules installed).");
    process.exit(2);
  }

  const db = new Database(dbPath, { readonly: true });
  const dataset = loadDataset(db);
  db.close();

  if (dataset.probes.length === 0) {
    console.error(
      "No labelled probes yet: mark speakers in a meeting note so the app stores note_speaker_embeddings + speaker_mappings, then re-run."
    );
  }

  const report = {
    database: dbPath,
    baseline: evaluate(dataset, { useTemplates: false }),
    templates: evaluate(dataset, { useTemplates: true }),
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const format = (value) => (value == null ? "n/a" : value.toFixed(3));
  console.log(`database: ${dbPath}`);
  console.log(`probes: ${report.baseline.probes}, identities: ${report.baseline.identities}`);
  for (const [label, result] of [
    ["baseline (profile centroid)", report.baseline],
    ["templates (max over voiceprints)", report.templates],
  ]) {
    console.log(`\n${label}`);
    console.log(`  own mean similarity:     ${format(result.ownSimilarityMean)}`);
    console.log(`  foreign mean similarity: ${format(result.foreignSimilarityMean)}`);
    console.log(`  margin mean:             ${format(result.marginMean)}`);
    for (const row of result.thresholdRows) {
      console.log(
        `  threshold ${row.threshold.toFixed(2)} → TPR ${(row.truePositiveRate * 100).toFixed(
          1
        )}% · foreign pairs above ${(row.falsePositiveRate * 100).toFixed(1)}%`
      );
    }
  }
}

if (require.main === module) main();

module.exports = { loadDataset, evaluate, cosineSimilarity, toFloat32 };
