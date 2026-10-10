"use strict";

/**
 * Response shaping shared by the machine surfaces. Moved out of
 * mcpServerManager.js so CLI and MCP serialize the same records identically.
 */

function parsePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function sanitizeNote(note, { full = false } = {}) {
  if (!note) return null;
  const content = note.enhanced_content || note.content || "";
  return {
    id: note.id,
    title: note.title,
    content: full ? content : content.slice(0, 500),
    raw_content: full ? note.content || "" : undefined,
    enhanced_content: full ? note.enhanced_content || "" : undefined,
    transcript: full ? note.transcript || null : undefined,
    note_type: note.note_type,
    folder_id: note.folder_id ?? null,
    tags: Array.isArray(note.tags) ? note.tags : [],
    created_at: note.created_at,
    updated_at: note.updated_at,
    recorded_at: note.recorded_at ?? null,
    has_audio: Boolean(note.source_file || note.audio_duration_seconds),
    audio_duration_seconds: note.audio_duration_seconds ?? null,
  };
}

function sanitizeTranscription(transcription) {
  if (!transcription) return null;
  return {
    id: transcription.id,
    text: transcription.text,
    raw_text: transcription.raw_text ?? null,
    status: transcription.status ?? "completed",
    timestamp: transcription.timestamp ?? transcription.created_at ?? null,
    provider: transcription.provider ?? null,
    model: transcription.model ?? null,
    language: transcription.language ?? null,
    has_audio: Boolean(transcription.has_audio),
    audio_duration_ms: transcription.audio_duration_ms ?? null,
    warning: transcription.warning ?? null,
  };
}

module.exports = {
  parsePositiveInteger,
  sanitizeNote,
  sanitizeTranscription,
};
