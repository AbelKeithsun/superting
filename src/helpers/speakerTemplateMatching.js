/**
 * Speaker identity matching against voiceprint templates.
 *
 * One person can hold several voiceprint templates (different meetings, rooms,
 * or microphones). An identity therefore scores as its *best matching* template
 * — max over templates — which is what keeps cross-room matches alive without
 * forcing the user to keep a single averaged centroid.
 *
 * The margin between the best and the second-best *identity* is preserved
 * (templates of the same identity never compete with each other).
 */

/**
 * Normalise a stored embedding (Float32Array, number[], or a float32 BLOB as a
 * Node Buffer) into a Float32Array. Raw bytes must never be compared directly —
 * `cosineSimilarity` indexes values, not bytes.
 */
function toFloat32Embedding(value) {
  if (!value?.length) return null;
  if (value instanceof Float32Array) return value;
  if (Array.isArray(value)) return new Float32Array(value);
  if (ArrayBuffer.isView(value) && value.byteLength % 4 === 0) {
    return new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4);
  }
  return null;
}

/**
 * Best similarity between a probe embedding and one identity's templates.
 * `profile.embeddings` (when present) lists every template of that identity;
 * otherwise the profile's own embedding is used.
 */
function similarityToProfile(probeEmbedding, profile, cosineSimilarity) {
  const probe = toFloat32Embedding(probeEmbedding);
  if (!probe || !profile) return -Infinity;
  const candidates =
    Array.isArray(profile.embeddings) && profile.embeddings.length > 0
      ? profile.embeddings
      : [profile.embedding];
  let best = -Infinity;
  for (const candidate of candidates) {
    const template = toFloat32Embedding(candidate);
    if (!template) continue;
    const similarity = cosineSimilarity(probe, template);
    if (Number.isFinite(similarity) && similarity > best) best = similarity;
  }
  return best;
}

/**
 * Rank every identity by its best template.
 *
 * @returns {{ profile: object|null, similarity: number, secondBestSimilarity: number, margin: number }}
 */
function findBestProfileMatch(probeEmbedding, profiles, cosineSimilarity) {
  let bestProfile = null;
  let bestSimilarity = -Infinity;
  let secondBestSimilarity = -Infinity;

  for (const profile of profiles || []) {
    if (!profile) continue;
    const similarity = similarityToProfile(probeEmbedding, profile, cosineSimilarity);
    if (!Number.isFinite(similarity)) continue;
    if (similarity > bestSimilarity) {
      secondBestSimilarity = bestSimilarity;
      bestSimilarity = similarity;
      bestProfile = profile;
    } else if (similarity > secondBestSimilarity) {
      secondBestSimilarity = similarity;
    }
  }

  return {
    profile: bestProfile,
    similarity: bestSimilarity,
    secondBestSimilarity,
    margin: bestSimilarity - secondBestSimilarity,
  };
}

module.exports = { toFloat32Embedding, similarityToProfile, findBestProfileMatch, findPreferredProfileMatch };

/**
 * Two-stage matching with participant priors (soft weighting).
 *
 * When the user enumerated attendees on a note, identities linked to those
 * attendees get a first pass with a slightly relaxed threshold (`relax`).
 * If no preferred identity qualifies, matching falls back to the full library
 * with the normal threshold — a walk-in participant can still be recognised
 * or created. Preferred identities never *force* a match: they still must
 * clear the (relaxed) threshold and the margin.
 *
 * @param {object} opts
 * @param {Set|Array|null} opts.preferredIds - speaker_profile ids to try first
 * @param {number} opts.threshold - normal acceptance threshold
 * @param {number} opts.margin - required best/second-best margin
 * @param {number} opts.relax - threshold relaxation for preferred identities
 * @returns {{ profile: object|null, similarity: number, margin: number, usedPrior: boolean }}
 */
function findPreferredProfileMatch(probeEmbedding, profiles, cosineSimilarity, opts = {}) {
  const { threshold, margin, relax = 0 } = opts;
  const preferred = new Set(
    opts.preferredIds instanceof Set ? [...opts.preferredIds] : opts.preferredIds || []
  );

  if (preferred.size > 0) {
    const preferredProfiles = (profiles || []).filter((p) => p && preferred.has(p.id));
    if (preferredProfiles.length > 0) {
      const first = findBestProfileMatch(probeEmbedding, preferredProfiles, cosineSimilarity);
      if (
        first.profile &&
        first.similarity >= threshold - relax &&
        first.margin >= margin
      ) {
        return { profile: first.profile, similarity: first.similarity, margin: first.margin, usedPrior: true };
      }
    }
  }

  const full = findBestProfileMatch(probeEmbedding, profiles, cosineSimilarity);
  if (full.profile && full.similarity >= threshold && full.margin >= margin) {
    return { profile: full.profile, similarity: full.similarity, margin: full.margin, usedPrior: false };
  }
  return { profile: null, similarity: full.similarity, margin: full.margin, usedPrior: false };
}
