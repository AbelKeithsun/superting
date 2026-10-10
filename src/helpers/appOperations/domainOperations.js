"use strict";

const { OperationError } = require("./registry");

/**
 * Second wave of the operation registry: capabilities that already exist as
 * renderer IPC handlers.
 *
 * Rather than re-implementing compress/merge/re-diarize/people/voiceprint logic
 * in a second place, these operations call `ipc.invokeChannel(...)`, i.e. the
 * exact handler the UI calls (see `IPCHandlers.invokeChannel`). That is what
 * makes "give agents the app's whole capability surface" cheap and drift-free:
 * a new operation is a few declarative lines instead of a parallel code path.
 *
 * Operations that genuinely need the UI process — settings (localStorage),
 * transcription retry (renderer transcription config), the export dialog,
 * recording capture — declare `rendererRequired` and dispatch over the
 * main→renderer bridge instead.
 */

function param(description, extra = {}) {
  return { type: "string", description, ...extra };
}
const num = (description, extra = {}) => param(description, { type: "number", ...extra });
const int = (description, extra = {}) => num(description, { ...extra });
const bool = (description, extra = {}) => param(description, { type: "boolean", ...extra });
const list = (description, extra = {}) =>
  param(description, { type: "array", items: "string", ...extra });

/** Unwrap the `{ success, ...payload }` envelope IPC handlers return. */
function unwrapIpcResult(result, label) {
  if (result === undefined || result === null) return {};
  if (Array.isArray(result)) return result;
  if (typeof result !== "object") return result;
  if (result.success === false) {
    throw OperationError.validation(result.error || `${label} failed`);
  }
  const { success: _success, ...rest } = result;
  const keys = Object.keys(rest);
  if (keys.length === 1) return rest[keys[0]];
  return rest;
}

/** Operation backed by an existing renderer IPC handler. */
function ipcOperation({
  id,
  title,
  description,
  policy = "read",
  params = {},
  channel,
  args = () => [],
  mcp,
  cli,
  label,
  job = null,
}) {
  if (!mcp || !cli) {
    throw new Error(`[appOperations] ${id}: IPC operations must be exposed on both surfaces`);
  }
  return {
    id,
    title,
    description,
    policy,
    params,
    mcp: { name: mcp },
    cli,
    handler: async (values, ctx) => {
      const runOnce = () => ctx.ipc.invokeChannel(channel, ...args(values));
      if (job && values.wait === false) {
        if (!ctx.jobs) {
          throw OperationError.unavailable("The job registry is not available in this process");
        }
        const record = ctx.jobs.start({
          operation: id,
          title: job.title ?? title,
          run: async () => unwrapIpcResult(await runOnce(), label ?? title),
        });
        return { data: { job_id: record.id, status: record.status, operation: id } };
      }
      return { data: unwrapIpcResult(await runOnce(), label ?? title) };
    },
  };
}

/** Operation that must run in the renderer, dispatched over the bridge. */
function rendererOperation({
  id,
  title,
  description,
  policy = "read",
  params = {},
  channel,
  mcp,
  cli,
  payload = (values) => values,
  fallback = null,
}) {
  if (!mcp || !cli) {
    throw new Error(`[appOperations] ${id}: renderer operations must be exposed on both surfaces`);
  }
  return {
    id,
    title,
    description,
    policy,
    params,
    mcp: { name: mcp },
    cli,
    rendererRequired: true,
    handler: async (values, ctx) => {
      try {
        const result = await ctx.renderer.invoke(channel, payload(values));
        return { data: result ?? {} };
      } catch (error) {
        if (fallback && error?.code === "UNAVAILABLE") {
          return { data: fallback(values, ctx) };
        }
        throw error;
      }
    },
  };
}

const CONTACT_FIELDS = {
  display_name: param("Contact display name."),
  email: param("Email address."),
  phone: param("Phone number."),
  organization: param("Organisation."),
  notes: param("Free-form notes."),
};

function contactFromParams(values) {
  const contact = {};
  if (values.display_name !== undefined) contact.displayName = values.display_name;
  if (values.email !== undefined) contact.email = values.email;
  if (values.phone !== undefined) contact.phone = values.phone;
  if (values.organization !== undefined) contact.organization = values.organization;
  if (values.notes !== undefined) contact.notes = values.notes;
  return contact;
}

function domainOperations() {
  return [
    // ------------------------------------------------------------ note audio
    ipcOperation({
      id: "notes.audio.list",
      title: "List note audio",
      description: "List the retained audio files of a note with size metadata.",
      params: { id: int("Note ID.", { required: true }) },
      channel: "get-note-audio-files",
      args: ({ id }) => [id],
      mcp: "list_note_audio",
      cli: {
        method: "GET",
        path: "/v1/notes/:id/audio",
        command: "notes audio list",
        params: { id: "path" },
      },
    }),
    ipcOperation({
      id: "notes.audio.compress",
      title: "Compress note audio",
      description: "Compress a note's retained audio to Opus-in-WebM.",
      policy: "write",
      params: {
        id: int("Note ID.", { required: true }),
        audio_file_id: int("Specific audio file ID. Defaults to the note's audio."),
      },
      channel: "compress-note-audio",
      args: ({ id, audio_file_id }) => [id, audio_file_id ?? null],
      mcp: "compress_note_audio",
      cli: {
        method: "POST",
        path: "/v1/notes/:id/audio/compress",
        command: "notes audio compress",
        params: { id: "path", audio_file_id: "body" },
      },
    }),
    ipcOperation({
      id: "notes.audio.merge",
      title: "Merge note audio",
      description: "Merge a note's audio segments into one file (removes the segments).",
      policy: "destructive",
      params: {
        id: int("Note ID.", { required: true }),
        wait: bool("Wait for the merge to finish (default true). Set false for a job id."),
      },
      channel: "merge-note-audio-files",
      job: { title: "Merge note audio" },
      args: ({ id }) => [id],
      mcp: "merge_note_audio",
      cli: {
        method: "POST",
        path: "/v1/notes/:id/audio/merge",
        command: "notes audio merge",
        params: { id: "path" },
      },
    }),
    ipcOperation({
      id: "notes.audio.rediarize",
      title: "Re-run speaker diarization",
      description: "Re-identify speakers for a note's audio (runs in the background).",
      policy: "write",
      params: {
        id: int("Note ID.", { required: true }),
        audio_file_id: int("Specific audio file ID."),
        expected_count: int("Expected speaker count (advanced)."),
        wait: bool("Wait for diarization to finish (default true). Set false for a job id."),
      },
      channel: "rediarize-note-audio",
      job: { title: "Re-run speaker diarization" },
      args: ({ id, audio_file_id, expected_count }) => [
        id,
        audio_file_id ?? null,
        expected_count ? { expectedCount: expected_count } : {},
      ],
      mcp: "rediarize_note_audio",
      cli: {
        method: "POST",
        path: "/v1/notes/:id/audio/rediarize",
        command: "notes audio rediarize",
        params: { id: "path", audio_file_id: "body", expected_count: "body" },
      },
    }),
    ipcOperation({
      id: "audio.usage",
      title: "Audio storage usage",
      description: "Report how much disk the retained audio uses.",
      channel: "get-audio-storage-usage",
      mcp: "get_audio_storage_usage",
      cli: { method: "GET", path: "/v1/audio/usage", command: "audio usage" },
    }),
    ipcOperation({
      id: "audio.retention.set",
      title: "Set audio retention",
      description: "Set how many days retained audio is kept, then run cleanup.",
      policy: "write",
      params: { days: int("Retention in days.", { required: true }) },
      channel: "set-audio-retention-days",
      args: ({ days }) => [days],
      mcp: "set_audio_retention_days",
      cli: {
        method: "PUT",
        path: "/v1/audio/retention",
        command: "audio retention",
        params: { days: "body" },
      },
    }),
    ipcOperation({
      id: "audio.compress_all",
      title: "Compress all audio",
      description: "Compress every retained audio file to Opus-in-WebM.",
      policy: "write",
      params: {
        wait: bool("Wait for compression to finish (default true). Set false for a job id."),
      },
      channel: "compress-all-audio",
      job: { title: "Compress all audio" },
      mcp: "compress_all_audio",
      cli: { method: "POST", path: "/v1/audio/compress", command: "audio compress-all" },
    }),
    ipcOperation({
      id: "audio.delete_all",
      title: "Delete all audio",
      description: "Delete every retained audio file (transcripts are kept).",
      policy: "destructive",
      channel: "delete-all-audio",
      mcp: "delete_all_audio",
      cli: { method: "DELETE", path: "/v1/audio", command: "audio delete-all" },
    }),

    // ---------------------------------------------------------- transcriptions
    ipcOperation({
      id: "transcriptions.clear",
      title: "Clear transcription history",
      description: "Delete every transcription record and its audio.",
      policy: "destructive",
      channel: "db-clear-transcriptions",
      mcp: "clear_transcriptions",
      cli: { method: "DELETE", path: "/v1/transcriptions", command: "transcriptions clear" },
    }),
    ipcOperation({
      id: "transcriptions.transcribe_file",
      title: "Transcribe an audio file",
      description:
        "Transcribe a local audio file with an on-device engine (whisper / Parakeet / FunASR).",
      policy: "write",
      params: {
        file_path: param("Absolute path of the audio file.", { required: true }),
        provider: param("Local engine.", { enum: ["whisper", "nvidia", "funasr"] }),
        model: param("Model name for that engine."),
        language: param("Language code, or `auto`."),
        wait: bool("Wait for the transcription to finish (default true). Set false for a job id."),
      },
      channel: "transcribe-audio-file",
      job: { title: "Transcribe audio file" },
      args: ({ file_path, provider, model, language }) => [
        file_path,
        { provider, model, language },
      ],
      mcp: "transcribe_audio_file",
      cli: {
        method: "POST",
        path: "/v1/transcriptions/transcribe",
        command: "transcriptions transcribe",
        params: {
          file_path: "body",
          provider: "body",
          model: "body",
          language: "body",
        },
      },
    }),
    rendererOperation({
      id: "transcriptions.retry",
      title: "Retry transcription",
      description:
        "Re-transcribe a stored audio file using the app's current transcription settings.",
      policy: "write",
      params: { id: int("Transcription ID.", { required: true }) },
      channel: "transcriptions.retry",
      mcp: "retry_transcription",
      cli: {
        method: "POST",
        path: "/v1/transcriptions/:id/retry",
        command: "transcriptions retry",
        params: { id: "path" },
      },
    }),

    // ------------------------------------------------------- import / export
    ipcOperation({
      id: "notes.import",
      title: "Import a file into a note",
      description: "Import a .txt/.md/.docx file into a note's content or transcript.",
      policy: "write",
      params: {
        id: int("Note ID.", { required: true }),
        file_path: param("Absolute path of the file to import.", { required: true }),
        target: param("`note` or `transcript`.", { enum: ["note", "transcript"] }),
      },
      channel: "import-note-file",
      args: ({ id, file_path, target }) => [id, file_path, target ? { target } : {}],
      mcp: "import_note_file",
      cli: {
        method: "POST",
        path: "/v1/notes/:id/import",
        command: "notes import",
        params: { id: "path", file_path: "body", target: "body" },
      },
    }),
    rendererOperation({
      id: "notes.export_files",
      title: "Export notes to disk",
      description: "Export notes (markdown/txt/pdf) to a folder chosen in the app's save dialog.",
      policy: "write",
      params: {
        note_ids: {
          type: "array",
          items: "number",
          required: true,
          description: "Note IDs to export.",
        },
        format: param("Export format.", { enum: ["md", "txt", "pdf"] }),
        fields: {
          type: "array",
          items: "string",
          description: "Subset of: transcript, content, enhanced_content.",
        },
      },
      channel: "notes.export_selection",
      mcp: "export_notes",
      cli: {
        method: "POST",
        path: "/v1/notes/export",
        command: "notes export-to-disk",
        params: { note_ids: "body", format: "body", fields: "body" },
      },
    }),

    // --------------------------------------------------------------- people
    ipcOperation({
      id: "people.list",
      title: "List contacts",
      description: "List contact profiles (跨会议人名表).",
      params: { query: param("Optional name filter.") },
      channel: "people-list",
      args: ({ query }) => [query ?? ""],
      mcp: "list_people",
      cli: {
        method: "GET",
        path: "/v1/people",
        command: "people list",
        params: { query: "query" },
      },
    }),
    ipcOperation({
      id: "people.get",
      title: "Get contact",
      description: "Get one contact profile and its voiceprints.",
      params: { id: int("Person ID.", { required: true }) },
      channel: "people-get",
      args: ({ id }) => [id],
      mcp: "get_person",
      cli: { method: "GET", path: "/v1/people/:id", command: "people get", params: { id: "path" } },
    }),
    ipcOperation({
      id: "people.create",
      title: "Create contact",
      description: "Create a contact profile.",
      policy: "write",
      params: CONTACT_FIELDS,
      channel: "people-create",
      args: (values) => [contactFromParams(values)],
      mcp: "create_person",
      cli: {
        method: "POST",
        path: "/v1/people",
        command: "people create",
        status: 201,
        params: {
          display_name: "body",
          email: "body",
          phone: "body",
          organization: "body",
          notes: "body",
        },
      },
    }),
    ipcOperation({
      id: "people.update",
      title: "Update contact",
      description: "Update a contact profile's fields.",
      policy: "write",
      params: { id: int("Person ID.", { required: true }), ...CONTACT_FIELDS },
      channel: "people-update",
      args: (values) => [values.id, contactFromParams(values)],
      mcp: "update_person",
      cli: {
        method: "PATCH",
        path: "/v1/people/:id",
        command: "people update",
        params: {
          id: "path",
          display_name: "body",
          email: "body",
          phone: "body",
          organization: "body",
          notes: "body",
        },
      },
    }),
    ipcOperation({
      id: "people.delete",
      title: "Delete contact",
      description: "Delete a contact profile.",
      policy: "destructive",
      params: { id: int("Person ID.", { required: true }) },
      channel: "people-delete",
      args: ({ id }) => [id],
      mcp: "delete_person",
      cli: {
        method: "DELETE",
        path: "/v1/people/:id",
        command: "people delete",
        params: { id: "path" },
        noContent: true,
      },
    }),
    ipcOperation({
      id: "people.merge",
      title: "Merge contacts",
      description: "Merge one contact into another.",
      policy: "destructive",
      params: {
        keep_id: int("Contact to keep.", { required: true }),
        remove_id: int("Contact to merge into it and delete.", { required: true }),
      },
      channel: "people-merge",
      args: ({ keep_id, remove_id }) => [keep_id, remove_id],
      mcp: "merge_people",
      cli: {
        method: "POST",
        path: "/v1/people/merge",
        command: "people merge",
        params: { keep_id: "body", remove_id: "body" },
      },
    }),
    ipcOperation({
      id: "contacts.search",
      title: "Search contacts",
      description: "Search contact records by name or email.",
      params: { query: param("Search text.", { required: true }) },
      channel: "search-contacts",
      args: ({ query }) => [query],
      mcp: "search_contacts",
      cli: {
        method: "GET",
        path: "/v1/contacts/search",
        command: "contacts search",
        params: { query: "query" },
      },
    }),
    ipcOperation({
      id: "contacts.upsert",
      title: "Upsert contact record",
      description: "Create or update a contact record by email or name.",
      policy: "write",
      params: { contact: { type: "object", required: true, description: "Contact fields." } },
      channel: "upsert-contact",
      args: ({ contact }) => [contact],
      mcp: "upsert_contact",
      cli: {
        method: "POST",
        path: "/v1/contacts",
        command: "contacts upsert",
        params: { contact: "body" },
      },
    }),

    // ------------------------------------------------------ speaker labelling
    ipcOperation({
      id: "speakers.mappings",
      title: "Get speaker mappings",
      description: "Get the speaker→contact mappings recorded for a note.",
      params: { id: int("Note ID.", { required: true }) },
      channel: "get-speaker-mappings",
      args: ({ id }) => [id],
      mcp: "get_speaker_mappings",
      cli: {
        method: "GET",
        path: "/v1/notes/:id/speakers",
        command: "speakers mappings",
        params: { id: "path" },
      },
    }),
    ipcOperation({
      id: "speakers.profiles",
      title: "List speaker profiles",
      description: "List speaker profiles (marked names) across notes.",
      channel: "get-speaker-profiles",
      mcp: "list_speaker_profiles",
      cli: { method: "GET", path: "/v1/speakers", command: "speakers profiles" },
    }),
    ipcOperation({
      id: "speakers.names",
      title: "List speaker names",
      description: "List the speaker names known to the app.",
      channel: "get-speaker-names",
      mcp: "list_speaker_names",
      cli: { method: "GET", path: "/v1/speakers/names", command: "speakers names" },
    }),
    ipcOperation({
      id: "speakers.mapping.set",
      title: "Assign a speaker name",
      description: "Assign a name/contact to a speaker id in a note.",
      policy: "write",
      params: {
        id: int("Note ID.", { required: true }),
        speaker_id: param("Speaker id from the transcript.", { required: true }),
        display_name: param("Name to assign.", { required: true }),
        email: param("Optional email to link."),
        profile_id: int("Existing speaker profile ID."),
      },
      channel: "set-speaker-mapping",
      args: ({ id, speaker_id, display_name, email, profile_id }) => [
        id,
        speaker_id,
        display_name,
        email ?? null,
        profile_id ?? null,
        {},
      ],
      mcp: "set_speaker_mapping",
      cli: {
        method: "POST",
        path: "/v1/notes/:id/speakers",
        command: "speakers assign",
        params: {
          id: "path",
          speaker_id: "body",
          display_name: "body",
          email: "body",
          profile_id: "body",
        },
      },
    }),
    ipcOperation({
      id: "speakers.name.upsert",
      title: "Upsert speaker name",
      description: "Create or update a speaker name (optionally with an email).",
      policy: "write",
      params: {
        display_name: param("Speaker name.", { required: true }),
        email: param("Optional email."),
      },
      channel: "upsert-speaker-name",
      args: ({ display_name, email }) => [display_name, email ?? null],
      mcp: "upsert_speaker_name",
      cli: {
        method: "POST",
        path: "/v1/speakers/names",
        command: "speakers name-add",
        params: { display_name: "body", email: "body" },
      },
    }),
    ipcOperation({
      id: "speakers.name.delete",
      title: "Delete speaker name",
      description: "Delete a speaker name by id.",
      policy: "destructive",
      params: { id: int("Speaker name ID.", { required: true }) },
      channel: "delete-speaker-name",
      args: ({ id }) => [id],
      mcp: "delete_speaker_name",
      cli: {
        method: "DELETE",
        path: "/v1/speakers/names/:id",
        command: "speakers name-delete",
        params: { id: "path" },
      },
    }),
    ipcOperation({
      id: "speakers.email.attach",
      title: "Attach email to speaker",
      description: "Attach an email address to a speaker profile.",
      policy: "write",
      params: {
        profile_id: int("Speaker profile ID.", { required: true }),
        email: param("Email to attach.", { required: true }),
      },
      channel: "attach-speaker-email",
      args: ({ profile_id, email }) => [profile_id, email],
      mcp: "attach_speaker_email",
      cli: {
        method: "POST",
        path: "/v1/speakers/email",
        command: "speakers email-attach",
        params: { profile_id: "body", email: "body" },
      },
    }),

    // ------------------------------------------------------------ voiceprints
    ipcOperation({
      id: "voiceprints.segments",
      title: "List voiceprint segments",
      description: "List the auditionable voiceprint segments of a person.",
      params: { person_id: int("Person ID. Omit for all people.") },
      channel: "voiceprint-segment-list",
      args: ({ person_id }) => [person_id ?? null],
      mcp: "list_voiceprint_segments",
      cli: {
        method: "GET",
        path: "/v1/voiceprints/segments",
        command: "voiceprints segments",
        params: { person_id: "query" },
      },
    }),
    ipcOperation({
      id: "voiceprints.delete_all",
      title: "Delete voiceprints",
      description: "Delete one person's voiceprints, or every voiceprint.",
      policy: "destructive",
      params: { person_id: int("Person ID. Omit to delete every voiceprint.") },
      channel: "voiceprint-delete-all",
      args: ({ person_id }) => [person_id ?? null],
      mcp: "delete_all_voiceprints",
      cli: {
        method: "DELETE",
        path: "/v1/voiceprints",
        command: "voiceprints delete-all",
        params: { person_id: "query" },
      },
    }),

    // ------------------------------------------------------------------ chats
    ipcOperation({
      id: "chats.list",
      title: "List chats",
      description: "List agent conversations.",
      params: { limit: int("Maximum conversations.") },
      channel: "db-get-agent-conversations",
      args: ({ limit }) => [limit ?? null],
      mcp: "list_chats",
      cli: { method: "GET", path: "/v1/chats", command: "chats list", params: { limit: "query" } },
    }),
    ipcOperation({
      id: "chats.messages",
      title: "Get chat messages",
      description: "Get the messages of one conversation.",
      params: { id: int("Conversation ID.", { required: true }) },
      channel: "db-get-agent-messages",
      args: ({ id }) => [id],
      mcp: "get_chat_messages",
      cli: {
        method: "GET",
        path: "/v1/chats/:id/messages",
        command: "chats messages",
        params: { id: "path" },
      },
    }),
    ipcOperation({
      id: "chats.for_note",
      title: "List a note's chats",
      description: "List the conversations attached to a note.",
      params: {
        id: int("Note ID.", { required: true }),
        limit: int("Maximum conversations."),
      },
      channel: "db-get-conversations-for-note",
      args: ({ id, limit }) => [id, limit ?? null],
      mcp: "list_note_chats",
      cli: {
        method: "GET",
        path: "/v1/notes/:id/chats",
        command: "chats for-note",
        params: { id: "path", limit: "query" },
      },
    }),
    ipcOperation({
      id: "chats.create",
      title: "Create chat",
      description: "Create an agent conversation, optionally attached to a note.",
      policy: "write",
      params: {
        title: param("Conversation title."),
        note_id: int("Optional note ID."),
      },
      channel: "db-create-agent-conversation",
      args: ({ title, note_id }) => [title ?? "Untitled", note_id ?? null],
      mcp: "create_chat",
      cli: {
        method: "POST",
        path: "/v1/chats",
        command: "chats create",
        status: 201,
        params: { title: "body", note_id: "body" },
      },
    }),
    ipcOperation({
      id: "chats.archive",
      title: "Archive chat",
      description: "Archive a conversation.",
      policy: "write",
      params: { id: int("Conversation ID.", { required: true }) },
      channel: "db-archive-agent-conversation",
      args: ({ id }) => [id],
      mcp: "archive_chat",
      cli: {
        method: "POST",
        path: "/v1/chats/:id/archive",
        command: "chats archive",
        params: { id: "path" },
      },
    }),
    ipcOperation({
      id: "chats.delete",
      title: "Delete chat",
      description: "Permanently delete a conversation.",
      policy: "destructive",
      params: { id: int("Conversation ID.", { required: true }) },
      channel: "db-hard-delete-conversation",
      args: ({ id }) => [id],
      mcp: "delete_chat",
      cli: {
        method: "DELETE",
        path: "/v1/chats/:id",
        command: "chats delete",
        params: { id: "path" },
        noContent: true,
      },
    }),

    // ---------------------------------------------------- transcript segments
    rendererOperation({
      id: "notes.transcript.segments",
      title: "List transcript segments",
      description:
        "List a note's transcript as structured segments (index, speaker, timestamp, text).",
      params: { id: int("Note ID.", { required: true }) },
      channel: "notes.transcript.segments",
      mcp: "list_transcript_segments",
      cli: {
        method: "GET",
        path: "/v1/notes/:id/transcript/segments",
        command: "transcript segments",
        params: { id: "path" },
      },
    }),
    rendererOperation({
      id: "notes.transcript.segment.update",
      title: "Update a transcript segment",
      description: "Edit one transcript segment's text and/or speaker (marking it as user-edited).",
      policy: "write",
      params: {
        id: int("Note ID.", { required: true }),
        segment_id: param("Segment id (preferred)."),
        index: int("Segment index when the id is unknown (0-based)."),
        text: param("Replacement text."),
        speaker: param("Raw speaker id (e.g. you / system / manual_1)."),
        speaker_name: param("Display name to assign to the segment."),
        lock: bool("Lock the speaker so later diarization runs cannot overwrite it."),
      },
      channel: "notes.transcript.segment.update",
      mcp: "update_transcript_segment",
      cli: {
        method: "PATCH",
        path: "/v1/notes/:id/transcript/segments",
        command: "transcript segment-update",
        params: {
          id: "path",
          segment_id: "body",
          index: "body",
          text: "body",
          speaker: "body",
          speaker_name: "body",
          lock: "body",
        },
      },
    }),
    rendererOperation({
      id: "notes.transcript.segment.delete",
      title: "Delete transcript segments",
      description: "Delete transcript segments by id or index.",
      policy: "destructive",
      params: {
        id: int("Note ID.", { required: true }),
        segment_ids: {
          type: "array",
          items: "string",
          description: "Segment ids to delete.",
        },
        index: int("Single segment index to delete (0-based)."),
        count: int("With index: delete this many consecutive segments."),
      },
      channel: "notes.transcript.segment.delete",
      mcp: "delete_transcript_segments",
      cli: {
        method: "DELETE",
        path: "/v1/notes/:id/transcript/segments",
        command: "transcript segment-delete",
        params: { id: "path", segment_ids: "query", index: "query", count: "query" },
      },
    }),

    // --------------------------------------------------------------- settings
    rendererOperation({
      id: "settings.get",
      title: "Get settings",
      description: "Read the app's settings (or one setting by key).",
      params: { key: param("Optional setting key.") },
      channel: "settings.get",
      mcp: "get_settings",
      cli: {
        method: "GET",
        path: "/v1/settings",
        command: "settings get",
        params: { key: "query" },
      },
      // Reading configuration should not require the window: the renderer
      // mirrors a redacted snapshot on every change.
      fallback: (values, ctx) => {
        const snapshot = ctx.ipc?.getSettingsMirror?.()?.read() ?? null;
        if (!snapshot) {
          throw OperationError.unavailable(
            "No SuperTing window is open and no settings snapshot has been mirrored yet"
          );
        }
        const source = "settings-mirror";
        if (!values.key) {
          return { settings: snapshot, count: Object.keys(snapshot).length, source };
        }
        if (!(values.key in snapshot)) {
          throw OperationError.validation(`Unknown setting "${values.key}"`);
        }
        return { key: values.key, value: snapshot[values.key], source };
      },
    }),
    rendererOperation({
      id: "settings.set",
      title: "Update a setting",
      description: "Update one setting through the app's own setter (side effects included).",
      policy: "write",
      params: {
        key: param("Setting key, e.g. uiLanguage.", { required: true }),
        value: param("New value (string, number or boolean as text)."),
        json: param("New value as JSON, for arrays/objects."),
      },
      channel: "settings.set",
      mcp: "set_setting",
      cli: {
        method: "PUT",
        path: "/v1/settings",
        command: "settings set",
        params: { key: "body", value: "body", json: "body" },
      },
    }),

    // ------------------------------------------------------------- recording
    rendererOperation({
      id: "recording.status",
      title: "Recording status",
      description: "Report whether a note or meeting recording is in progress.",
      channel: "recording.status",
      mcp: "get_recording_status",
      cli: { method: "GET", path: "/v1/recording", command: "recording status" },
    }),
    rendererOperation({
      id: "recording.start",
      title: "Start recording",
      description: "Start recording into a note (same entry point as the editor's 开始录音).",
      policy: "write",
      params: {
        note_id: int("Note to record into (a meeting or personal note).", { required: true }),
      },
      channel: "recording.start",
      mcp: "start_recording",
      cli: {
        method: "POST",
        path: "/v1/recording/start",
        command: "recording start",
        params: { note_id: "body" },
      },
    }),
    rendererOperation({
      id: "recording.stop",
      title: "Stop recording",
      description: "Stop the running recording and finalize the note.",
      policy: "write",
      channel: "recording.stop",
      mcp: "stop_recording",
      cli: { method: "POST", path: "/v1/recording/stop", command: "recording stop" },
    }),
  ];
}

module.exports = { domainOperations, rendererOperation, unwrapIpcResult };
