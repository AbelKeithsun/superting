"use strict";

/**
 * Two-pass global re-clustering for windowed diarization.
 *
 * Why this exists: the windowed pipeline clusters each 5-minute window
 * independently and then maps window-local labels to global speakers by
 * *temporal overlap* with previously assigned segments. Anyone silent in the
 * 30s overlap zone is minted as a new global speaker — measured on a real
 * 41-minute 6-person meeting: 132 global speakers before the hard cap
 * trimmed them to 16.
 *
 * This module replaces the label assignment with voiceprints: every window
 * cluster carries a duration-weighted centroid embedding (computed by the
 * caller), micro-fragments (< fragmentSeconds of audio, whose embeddings are
 * unreliable) are absorbed into their closest anchor first, and the rest are
 * grouped by average-linkage agglomerative merging — down to `targetCount`
 * when the expected speaker count is known, otherwise until the best
 * candidate pair falls below `threshold`.
 *
 * Measured on the same meeting (CAM++ embeddings, 154 window clusters):
 *   overlap assignment            -> 132 speakers (capped to 16)
 *   absorb<3s + average-linkage   ->   6 speakers at threshold 0.75
 * Complete linkage is NOT used: room/mic channel effects collapse 95% of
 * speech into one giant cluster.
 */

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

/**
 * Inventory the clusters of a windowed diarization run.
 * windowResults: [{ index|startSeconds, segments: [{start, end, speaker}] }]
 * centroids: { "<windowIndex>|<localSpeaker>": number[]|Float32Array }
 * Returns [{ key, windowIndex, localSpeaker, durationSec, v: Float64Array }].
 */
function collectWindowClusters(windowResults = [], centroids = {}) {
  const clusters = [];
  windowResults.forEach((result, position) => {
    const windowIndex = Number.isFinite(Number(result?.index)) ? Number(result.index) : position;
    const bySpeaker = new Map();
    for (const segment of result?.segments || []) {
      const duration = Math.max(0, Number(segment.end) - Number(segment.start));
      if (!Number.isFinite(duration) || duration <= 0) continue;
      const speaker = String(segment.speaker || "");
      bySpeaker.set(speaker, (bySpeaker.get(speaker) || 0) + duration);
    }
    for (const [localSpeaker, durationSec] of bySpeaker) {
      const key = `${windowIndex}|${localSpeaker}`;
      const vector = centroids[key];
      if (!vector?.length) continue;
      clusters.push({ key, windowIndex, localSpeaker, durationSec, v: Float64Array.from(vector) });
    }
  });
  return clusters;
}

/**
 * Absorb clusters with less than `fragmentSeconds` of audio into the closest
 * (duration-weighted) anchor cluster. Their short embeddings are noise; the
 * anchor they join keeps its identity.
 */
function absorbFragments(clusters, fragmentSeconds = 3) {
  const anchors = clusters
    .filter((c) => c.durationSec >= fragmentSeconds)
    .map((c) => ({ ...c, v: Float64Array.from(c.v), members: [c.key] }));
  const fragments = clusters.filter((c) => c.durationSec < fragmentSeconds);
  for (const fragment of fragments) {
    let best = null;
    let bestSimilarity = -Infinity;
    for (const anchor of anchors) {
      const similarity = cosineSimilarity(fragment.v, anchor.v);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        best = anchor;
      }
    }
    if (!best) {
      anchors.push({ ...fragment, v: Float64Array.from(fragment.v), members: [fragment.key] });
      continue;
    }
    const total = best.durationSec + fragment.durationSec;
    for (let i = 0; i < best.v.length; i++) {
      best.v[i] = (best.v[i] * best.durationSec + fragment.v[i] * fragment.durationSec) / total;
    }
    best.durationSec = total;
    best.members.push(fragment.key);
  }
  return anchors;
}

/**
 * Average-linkage agglomerative merge. Stops when the group count reaches
 * `targetCount` (known expected speaker count wins over the threshold) or
 * when the best average similarity between any two groups drops below
 * `threshold`.
 */
function agglomerativeMerge(clusters, { threshold = 0.75, targetCount = null } = {}) {
  const groups = clusters.map((c) => ({
    members: [...(c.members || [c.key])],
    v: Float64Array.from(c.v),
    durationSec: c.durationSec,
  }));
  const averageSimilarity = (A, B) => {
    let sum = 0;
    let n = 0;
    for (const keyA of A.members) {
      const va = A._vectors?.get(keyA) || A.v;
      for (const keyB of B.members) {
        const vb = B._vectors?.get(keyB) || B.v;
        sum += cosineSimilarity(va, vb);
        n++;
      }
    }
    return n ? sum / n : 0;
  };
  // keep the per-member vectors for true average linkage
  const vectorByKey = new Map(clusters.map((c) => [c.key, c.v]));
  for (const g of groups) g._vectors = vectorByKey;

  for (;;) {
    if (targetCount && groups.length <= targetCount) break;
    let bi = -1;
    let bj = -1;
    let best = -Infinity;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const similarity = averageSimilarity(groups[i], groups[j]);
        if (similarity > best) {
          best = similarity;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi < 0) break;
    // With a known target we keep merging toward it regardless of the
    // threshold; without one, the threshold is the only stop.
    if (!targetCount && best < threshold) break;
    const A = groups[bi];
    const B = groups[bj];
    const total = A.durationSec + B.durationSec;
    const v = new Float64Array(A.v.length);
    for (let k = 0; k < v.length; k++) {
      v[k] = (A.v[k] * A.durationSec + B.v[k] * B.durationSec) / total;
    }
    groups.splice(bj, 1);
    groups[bi] = {
      members: [...A.members, ...B.members],
      v,
      durationSec: total,
      _vectors: vectorByKey,
    };
  }
  return groups.map(({ members, v, durationSec }) => ({ members, v, durationSec }));
}

/**
 * Full pipeline: collect → absorb fragments → agglomerative merge →
 * assignment map `${windowIndex}|${localSpeaker}` -> `speaker_N`
 * (N ordered by total group duration, most talkative first).
 */
function reclusterWindowSpeakers(windowResults, centroids, options = {}) {
  const { fragmentSeconds = 3, threshold = 0.75, targetCount = null } = options;
  const clusters = collectWindowClusters(windowResults, centroids);
  if (clusters.length === 0) return null;
  const merged = absorbFragments(clusters, fragmentSeconds);
  const groups = agglomerativeMerge(merged, { threshold, targetCount }).sort(
    (a, b) => b.durationSec - a.durationSec
  );
  const assignment = new Map();
  groups.forEach((group, index) => {
    for (const key of group.members) assignment.set(key, `speaker_${index}`);
  });
  return { assignment, groupCount: groups.length, clusterCount: clusters.length };
}

module.exports = {
  absorbFragments,
  agglomerativeMerge,
  collectWindowClusters,
  reclusterWindowSpeakers,
};
