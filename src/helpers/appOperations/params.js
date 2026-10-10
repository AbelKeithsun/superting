"use strict";

const { OperationError } = require("./registry");

/**
 * Shared parameter parsing for operations. These used to live inside
 * cliBridge.js; they moved here because the operations — not the HTTP layer —
 * are now the single definition of what a valid payload is.
 */

function parseIdParam(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function requireId(value, label) {
  const id = parseIdParam(value);
  if (id == null) throw OperationError.notFound(`Invalid ${label} id`);
  return id;
}

function unwrapMutationResult(result, label) {
  if (!result?.success || !result[label]) {
    const error = new OperationError(result?.error || `Failed to write ${label}`, "NOT_FOUND");
    throw error;
  }
  return result[label];
}

/**
 * Success-only guard, for mutations whose DB call returns `{ success }` without
 * a payload (dictionary hotwords, replacement rules, …).
 */
function requireMutationSuccess(result, message) {
  if (!result?.success) {
    throw new OperationError(result?.error || message, "NOT_FOUND");
  }
  return result;
}

function parseWordList(value) {
  const words = Array.isArray(value?.words) ? value.words : Array.isArray(value) ? value : null;
  if (!words) {
    throw OperationError.validation('Expected a JSON array of words (or {"words": [...]})');
  }
  const cleaned = [];
  for (const word of words) {
    if (typeof word !== "string" || !word.trim()) {
      throw OperationError.validation("Dictionary words must be non-empty strings");
    }
    cleaned.push(word.trim());
  }
  return cleaned;
}

function parseAliasList(value) {
  const aliases = Array.isArray(value?.aliases)
    ? value.aliases
    : Array.isArray(value)
      ? value
      : null;
  if (!aliases) {
    throw OperationError.validation('Expected a JSON array of aliases (or {"aliases": [...]})');
  }
  const cleaned = [];
  for (const alias of aliases) {
    const from = typeof alias?.from === "string" ? alias.from.trim() : "";
    const to = typeof alias?.to === "string" ? alias.to.trim() : "";
    if (!from || !to) {
      throw OperationError.validation(
        'Aliases must be objects with non-empty "from" and "to" strings'
      );
    }
    cleaned.push({ from, to });
  }
  return cleaned;
}

function parseSingleAlias(body) {
  const from = typeof body?.from === "string" ? body.from.trim() : "";
  const to = typeof body?.to === "string" ? body.to.trim() : "";
  if (!from || !to) {
    throw OperationError.validation('Expected {"from": "...", "to": "..."} with non-empty strings');
  }
  return { from, to };
}

module.exports = {
  parseAliasList,
  requireMutationSuccess,
  parseIdParam,
  parseSingleAlias,
  parseWordList,
  requireId,
  unwrapMutationResult,
};
