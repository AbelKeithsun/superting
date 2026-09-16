/**
 * Extracts transcription corrections by diffing original text against
 * the edited field value. Returns corrected words to add to the custom dictionary.
 */

/** Levenshtein edit distance between two strings */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/** Tokenize text into words, stripping punctuation from edges */
function tokenize(text) {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, ""))
    .filter((w) => w.length > 0);
}

/**
 * Find the region in fieldValue that corresponds to the pasted originalText.
 * If the field only contains the pasted text, returns fieldValue as-is.
 */
function findEditedRegion(originalText, fieldValue) {
  if (fieldValue.length <= originalText.length * 1.5) {
    return fieldValue;
  }

  const idx = fieldValue.indexOf(originalText);
  if (idx !== -1) {
    return originalText;
  }

  // Sliding window: find the region with highest word overlap
  const origWords = tokenize(originalText);
  const fieldWords = tokenize(fieldValue);
  const windowSize = origWords.length;

  if (fieldWords.length <= windowSize) {
    return fieldValue;
  }

  let bestStart = 0;
  let bestScore = -1;

  for (let i = 0; i <= fieldWords.length - windowSize; i++) {
    let matches = 0;
    for (let j = 0; j < windowSize; j++) {
      if (fieldWords[i + j].toLowerCase() === origWords[j].toLowerCase()) {
        matches++;
      }
    }
    if (matches > bestScore) {
      bestScore = matches;
      bestStart = i;
    }
  }

  // Require at least 30% word overlap to consider it a match
  if (bestScore < windowSize * 0.3) {
    return fieldValue;
  }

  return fieldWords.slice(bestStart, bestStart + windowSize).join(" ");
}

/** Word-level LCS to find [originalWord, editedWord] substitution pairs. */
function findSubstitutions(origWords, editedWords) {
  const m = origWords.length;
  const n = editedWords.length;

  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (origWords[i - 1].toLowerCase() === editedWords[j - 1].toLowerCase()) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const aligned = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && origWords[i - 1].toLowerCase() === editedWords[j - 1].toLowerCase()) {
      aligned.unshift([origWords[i - 1], editedWords[j - 1]]);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      aligned.unshift([null, editedWords[j - 1]]);
      j--;
    } else {
      aligned.unshift([origWords[i - 1], null]);
      i--;
    }
  }

  // Consecutive [origWord, null] + [null, editedWord] = substitution
  const subs = [];
  for (let k = 0; k < aligned.length - 1; k++) {
    const [origW, editW] = aligned[k];
    const [nextOrigW, nextEditW] = aligned[k + 1];

    if (origW !== null && editW === null && nextOrigW === null && nextEditW !== null) {
      subs.push([origW, nextEditW]);
    }
  }

  return subs;
}

/**
 * Extract corrected words from a user's edits to pasted transcription text.
 *
 * @param {string} originalText - The text that was originally pasted (from transcription)
 * @param {string} fieldValue - The current value of the text field (after user edits)
 * @param {string[]} existingDictionary - Words already in the custom dictionary
 * @returns {string[]} Array of corrected words to add to the dictionary
 */
function extractCorrections(originalText, fieldValue, existingDictionary) {
  if (!originalText || !fieldValue) return [];
  if (originalText === fieldValue) return [];

  const editedRegion = findEditedRegion(originalText, fieldValue);
  if (editedRegion === originalText) return [];

  const origWords = tokenize(originalText);
  const editedWords = tokenize(editedRegion);

  if (origWords.length === 0 || editedWords.length === 0) return [];

  // If more than 50% of words changed, this is a rewrite, not corrections
  const subs = findSubstitutions(origWords, editedWords);
  if (subs.length > origWords.length * 0.5) return [];

  const seenCorrections = new Set();
  const results = [];

  for (const [origWord, correctedWord] of subs) {
    const normalizedCorrected = correctedWord.toLowerCase();

    if (seenCorrections.has(normalizedCorrected)) continue;
    if (!shouldLearnCorrection(origWord, correctedWord, existingDictionary)) continue;

    results.push(correctedWord);
    seenCorrections.add(normalizedCorrected);
  }

  return results;
}

function normalizeCandidateText(text) {
  return String(text || "")
    .trim()
    .replace(/\s+/g, " ");
}

function shouldLearnCorrectionReason(originalText, correctedText, existingDictionary) {
  const original = normalizeCandidateText(originalText);
  const corrected = normalizeCandidateText(correctedText);

  if (!original || !corrected) return "empty";
  if (original.toLowerCase() === corrected.toLowerCase()) return "no-change";
  if (corrected.length < 3) return "too-short";

  const safeDict = Array.isArray(existingDictionary) ? existingDictionary : [];
  const dictSet = new Set(safeDict.map((w) => normalizeCandidateText(w).toLowerCase()));
  if (dictSet.has(corrected.toLowerCase())) return "already-in-dictionary";

  const dist = editDistance(original.toLowerCase(), corrected.toLowerCase());
  const maxLen = Math.max(original.length, corrected.length);
  if (dist / maxLen > 0.65) return "too-different";
  return null;
}

function shouldLearnCorrection(originalText, correctedText, existingDictionary) {
  return shouldLearnCorrectionReason(originalText, correctedText, existingDictionary) === null;
}

function extractReplacementCorrection({
  findText,
  replacementText,
  replacementCount,
  existingDictionary,
} = {}) {
  if (!Number.isFinite(replacementCount) || replacementCount <= 0) return [];

  const corrected = normalizeCandidateText(replacementText);
  if (!shouldLearnCorrection(findText, corrected, existingDictionary)) return [];

  return [corrected];
}

const CJK_REGEX = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

function containsCjk(text) {
  return CJK_REGEX.test(text);
}

function isPunctuationOnly(text) {
  return !/[\p{L}\p{N}]/u.test(text);
}

/** Character-level alignment (LCS) that reports contiguous diff runs. */
function findCharDiffRuns(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const ops = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push(["keep", a[i - 1]]);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push(["insert", b[j - 1]]);
      j--;
    } else {
      ops.push(["delete", a[i - 1]]);
      i--;
    }
  }
  ops.reverse();

  // Collapse consecutive delete+insert runs into {from, to} pairs.
  const runs = [];
  let current = null;
  for (const [kind, ch] of ops) {
    if (kind === "keep") {
      if (current) {
        runs.push(current);
        current = null;
      }
      continue;
    }
    if (!current) current = { from: "", to: "" };
    if (kind === "delete") current.from += ch;
    else current.to += ch;
  }
  if (current) runs.push(current);
  return { runs, lcsLength: dp[m][n] };
}

/**
 * Pick the most informative reason out of the per-run rejections, so the UI can
 * tell the user *why* an edit produced no dictionary entry.
 */
function classifyRejections(rejections) {
  if (rejections.alreadyInDictionary) return "already-in-dictionary";
  if (rejections.tooShort) return "too-short";
  if (rejections.punctuation) return "punctuation-only";
  const hasInsert = rejections.insert;
  const hasDelete = rejections.delete;
  if (hasInsert && !hasDelete) return "insertion-only";
  if (hasDelete && !hasInsert) return "deletion-only";
  if (hasInsert || hasDelete) return "mixed-insert-delete";
  return "not-learnable";
}

/**
 * CJK-aware (错→对) pair extraction. A pair is only produced when the edit is
 * a localized substitution: overall similarity ≥ 0.6, the differing region is
 * one contiguous run of 2–8 characters on each side (name/term scale), and
 * the corrected side is a plausible dictionary term. Whole-sentence rewrites
 * are rejected.
 *
 * @returns {{ pairs: Array<{from: string, to: string}>, reason: string }}
 */
function analyzeCjkCorrection(originalText, editedText, existingDictionary) {
  const original = normalizeCandidateText(originalText);
  const edited = normalizeCandidateText(editedText);
  if (!original || !edited) return { pairs: [], reason: "empty" };
  // Mixed scripts (one side pure Latin) are not handled by the character diff.
  if (!containsCjk(original) || !containsCjk(edited)) {
    return { pairs: [], reason: "not-learnable" };
  }
  if (original === edited) return { pairs: [], reason: "no-change" };

  const maxLen = Math.max(original.length, edited.length);
  const { runs, lcsLength } = findCharDiffRuns(original, edited);
  const similarity = lcsLength / maxLen;
  const changedChars = runs.reduce(
    (sum, run) => sum + Math.max(run.from.length, run.to.length),
    0
  );
  if (similarity < 0.6 || changedChars > maxLen * 0.5) {
    // Pure insertion/deletion is worth reporting precisely: "you only added a
    // word" is actionable, "this looks like a rewrite" is not.
    const substitutionRuns = runs.filter((run) => run.from.trim() && run.to.trim());
    if (substitutionRuns.length === 0) {
      return {
        pairs: [],
        reason: classifyRejections({
          insert: runs.some((run) => !run.from.trim() && !!run.to.trim()),
          delete: runs.some((run) => !!run.from.trim() && !run.to.trim()),
          alreadyInDictionary: false,
          tooShort: false,
          punctuation: false,
        }),
      };
    }
    return { pairs: [], reason: "rewrite" };
  }

  const dictSet = new Set(
    (Array.isArray(existingDictionary) ? existingDictionary : []).map((w) =>
      normalizeCandidateText(w).toLowerCase()
    )
  );

  const rejections = {
    insert: false,
    delete: false,
    alreadyInDictionary: false,
    tooShort: false,
    punctuation: false,
  };
  const pairs = [];
  for (const run of runs) {
    const from = run.from.trim();
    const to = run.to.trim();
    // Pure insertion/deletion is not a substitution.
    if (!from && to) {
      rejections.insert = true;
      continue;
    }
    if (from && !to) {
      rejections.delete = true;
      continue;
    }
    if (!from || !to) continue;
    if (from.length < 2 || from.length > 8 || to.length < 2 || to.length > 8) {
      rejections.tooShort = true;
      continue;
    }
    if (isPunctuationOnly(from) || isPunctuationOnly(to)) {
      rejections.punctuation = true;
      continue;
    }
    if (from === to) continue;
    if (dictSet.has(to.toLowerCase())) {
      rejections.alreadyInDictionary = true;
      continue;
    }
    if (!pairs.some((pair) => pair.from === from && pair.to === to)) {
      pairs.push({ from, to });
    }
  }
  if (pairs.length > 0) return { pairs, reason: "learned-candidate" };
  return { pairs: [], reason: classifyRejections(rejections) };
}

/**
 * Latin word-level analysis: substitutions come from the word LCS, and each
 * substitution has to look like a plausible spelling/term fix.
 *
 * @returns {{ pairs: Array<{from: string, to: string}>, reason: string }}
 */
function analyzeLatinCorrection(originalText, editedText, existingDictionary) {
  const original = normalizeCandidateText(originalText);
  const edited = normalizeCandidateText(editedText);
  if (!original || !edited) return { pairs: [], reason: "empty" };
  if (original === edited) return { pairs: [], reason: "no-change" };

  const origWords = tokenize(original);
  const editedWords = tokenize(edited);
  if (origWords.length === 0 || editedWords.length === 0) {
    return { pairs: [], reason: "not-learnable" };
  }

  const subs = findSubstitutions(origWords, editedWords);
  if (subs.length === 0) {
    if (editedWords.length > origWords.length) return { pairs: [], reason: "insertion-only" };
    if (editedWords.length < origWords.length) return { pairs: [], reason: "deletion-only" };
    return { pairs: [], reason: "not-learnable" };
  }
  if (subs.length > origWords.length * 0.5) {
    // A one-word segment replaced by another word is a term fix, not a
    // rewrite — report the precise verdict so the UI can explain it.
    if (subs.length === 1) {
      const onlyWordReason = shouldLearnCorrectionReason(
        subs[0][0],
        subs[0][1],
        existingDictionary
      );
      if (onlyWordReason) return { pairs: [], reason: onlyWordReason };
    }
    return { pairs: [], reason: "rewrite" };
  }

  let rejection = null;
  const pairs = [];
  for (const [origWord, correctedWord] of subs) {
    const reason = shouldLearnCorrectionReason(origWord, correctedWord, existingDictionary);
    if (reason) {
      rejection = rejection ?? reason;
      continue;
    }
    if (!pairs.some((pair) => pair.from === origWord && pair.to === correctedWord)) {
      pairs.push({ from: origWord, to: correctedWord });
    }
  }
  if (pairs.length > 0) return { pairs, reason: "learned-candidate" };
  return { pairs: [], reason: rejection || "not-learnable" };
}

/**
 * Extract (wrong→right) substitution pairs from an edited transcript segment,
 * together with a machine-readable reason when nothing was learnable:
 * `empty` | `no-change` | `insertion-only` | `deletion-only` |
 * `mixed-insert-delete` | `punctuation-only` | `rewrite` | `too-short` |
 * `too-different` | `already-in-dictionary` | `not-learnable`.
 *
 * Latin text goes through the word-level LCS; CJK text uses the character diff
 * above; mixed content falls back to the Latin path only when neither side has
 * CJK characters.
 *
 * @returns {{ pairs: Array<{from: string, to: string}>, reason: string }}
 */
function analyzeCorrection({ originalText, editedText, existingDictionary = [] } = {}) {
  if (!originalText || !editedText) return { pairs: [], reason: "empty" };
  if (normalizeCandidateText(originalText) === normalizeCandidateText(editedText)) {
    return { pairs: [], reason: "no-change" };
  }
  if (containsCjk(originalText) || containsCjk(editedText)) {
    return analyzeCjkCorrection(originalText, editedText, existingDictionary);
  }
  return analyzeLatinCorrection(originalText, editedText, existingDictionary);
}

function extractCorrectionPairs(args) {
  return analyzeCorrection(args).pairs;
}

module.exports = {
  analyzeCorrection,
  extractCorrections,
  extractCorrectionPairs,
  extractReplacementCorrection,
};
