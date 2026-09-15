"use strict";

/**
 * Absorb diarization fragments into the speaker they most plausibly belong to.
 *
 * With an unknown cluster count (`num-clusters = -1`) the engine can over-split
 * a meeting: short clusters appear that are really a piece of a longer speaker.
 * Measured on a real 29-minute in-person recording, CAM++ similarities between
 * clusters are high across the board (median 0.58, p90 0.83), so merging by
 * similarity alone collapses everybody into one speaker — verified: a plain
 * similarity union merges all 16 clusters at any threshold up to 0.7.
 *
 * This module therefore only does the bounded, safe half of the job: clusters
 * shorter than `maxFragmentSeconds` may be absorbed into the *longest* cluster
 * whose voiceprint is close enough (≥ `threshold`). Substantial clusters never
 * merge with each other, so a meeting can never collapse into a single speaker;
 * splitting the remaining speakers is left to the explicit expected-count path
 * (固定人数) and to manual merging in the transcript.
 */

function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (!normA || !normB) return 0;
  return dot / Math.sqrt(normA * normB);
}

function mergeSimilarSpeakerClusters(segments, embeddingsBySpeaker = {}, options = {}) {
  const threshold = Number(options.threshold);
  const maxFragmentSeconds = Number(options.maxFragmentSeconds ?? 20);
  const input = Array.isArray(segments) ? segments : [];
  const embeddings = embeddingsBySpeaker || {};
  const ids = Object.keys(embeddings);
  const unchanged = {
    segments: input,
    embeddings,
    mergeCount: 0,
    groups: ids.map((id) => [id]),
  };
  if (!Number.isFinite(threshold) || threshold <= 0 || ids.length < 2) return unchanged;

  const durationBySpeaker = new Map();
  for (const segment of input) {
    const duration = Math.max(0, (segment.end ?? 0) - (segment.start ?? 0));
    durationBySpeaker.set(
      segment.speaker,
      (durationBySpeaker.get(segment.speaker) || 0) + duration
    );
  }
  const durationOf = (id) => durationBySpeaker.get(id) || 0;

  // A cluster is a fragment when it is both short in absolute terms and clearly
  // shorter than the meeting's main speakers.
  const longest = [...ids].sort((a, b) => durationOf(b) - durationOf(a));
  const fragments = longest.filter(
    (id) => durationOf(id) < maxFragmentSeconds && durationOf(id) < durationOf(longest[0]) * 0.5
  );
  const anchors = longest.filter((id) => !fragments.includes(id));
  if (fragments.length === 0 || anchors.length === 0) return unchanged;

  const representativeBySpeaker = new Map();
  const absorbedByAnchor = new Map(anchors.map((anchor) => [anchor, [anchor]]));
  let mergeCount = 0;

  for (const fragment of fragments) {
    let bestAnchor = null;
    let bestSimilarity = 0;
    for (const anchor of anchors) {
      const similarity = cosineSimilarity(embeddings[fragment], embeddings[anchor]);
      if (similarity >= threshold && similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestAnchor = anchor;
      }
    }
    if (!bestAnchor) continue;
    representativeBySpeaker.set(fragment, bestAnchor);
    absorbedByAnchor.get(bestAnchor).push(fragment);
    mergeCount += 1;
  }
  if (mergeCount === 0) return unchanged;

  const mergedEmbeddings = {};
  for (const anchor of anchors) {
    const members = absorbedByAnchor.get(anchor);
    if (members.length === 1) {
      mergedEmbeddings[anchor] = embeddings[anchor];
      continue;
    }
    const dimensions = embeddings[anchor].length;
    const weighted = new Array(dimensions).fill(0);
    let totalWeight = 0;
    for (const member of members) {
      const weight = durationOf(member) || 1;
      totalWeight += weight;
      for (let index = 0; index < dimensions; index += 1) {
        weighted[index] += embeddings[member][index] * weight;
      }
    }
    mergedEmbeddings[anchor] = weighted.map((value) => (totalWeight ? value / totalWeight : 0));
  }

  const remapped = input.map((segment) => {
    const representative = representativeBySpeaker.get(segment.speaker);
    return representative ? { ...segment, speaker: representative } : segment;
  });

  return {
    segments: remapped,
    embeddings: mergedEmbeddings,
    mergeCount,
    groups: [...absorbedByAnchor.values()].sort((a, b) => b.length - a.length),
  };
}

module.exports = { cosineSimilarity, mergeSimilarSpeakerClusters };
