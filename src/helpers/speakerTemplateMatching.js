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

module.exports = { toFloat32Embedding, similarityToProfile, findBestProfileMatch };
