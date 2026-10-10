"use strict";

const { OperationError } = require("./registry");
const { parsePositiveInteger, sanitizeNote, sanitizeTranscription } = require("./serialize");
const {
  parseAliasList,
  parseSingleAlias,
  parseWordList,
  requireId,
  requireMutationSuccess,
  unwrapMutationResult,
} = require("./params");

const LIST_ENVELOPE = { has_more: false, next_cursor: null };

/**
 * Operations backed directly by the SQLite layer. These cover everything the
 * MCP tools and the CLI bridge used to implement by hand (notes, folders, tags,
 * dictionary hotwords + aliases + groups, transcriptions) plus the gaps that
 * drift had left behind: real note append, dictionary writes for MCP, semantic
 * search, headless export, folder rename/delete/reorder, transcription deletes.
 *
 * Handlers return `{ data, ...envelope }`; `mcp.serialize` / `cli.serialize`
 * shape the surface-specific response where the historical shapes differ.
 */
function coreOperations() {
  const noteNotFound = (id) => OperationError.notFound(`Note ${id} not found`);

  return [
    // ------------------------------------------------------------------ system
    {
      id: "system.health",
      title: "Health check",
      description: "Check whether the local SuperTing agent surfaces are available.",
      policy: "read",
      mcp: { name: "health" },
      cli: { method: "GET", path: "/v1/health", command: "health" },
      handler: () => ({ data: { ok: true, version: 1 } }),
    },
    {
      id: "system.operations",
      title: "List machine capabilities",
      description:
        "List every capability exposed to agents, with its MCP tool name, CLI route and parameters.",
      policy: "read",
      notes: ["Call this first when unsure which capability or parameter to use."],
      mcp: { name: "list_operations" },
      cli: { method: "GET", path: "/v1/operations", command: "ops list" },
      handler: (_params, ctx) => ({
        data: (ctx.registry?.list() ?? []).map((operation) => ({
          id: operation.id,
          title: operation.title,
          description: operation.description,
          policy: operation.policy,
          rendererRequired: operation.rendererRequired,
          params: operation.params,
          mcp: operation.mcp ? { name: operation.mcp.name } : null,
          cli: operation.cli
            ? {
                method: operation.cli.method,
                path: operation.cli.path,
                command: operation.cli.command ?? null,
                params: operation.cli.params ?? {},
              }
            : null,
        })),
      }),
    },

    // ------------------------------------------------------------------- notes
    {
      id: "notes.list",
      title: "List notes",
      description: "List local notes with previews and audio metadata.",
      policy: "read",
      params: {
        limit: { type: "number", description: "Maximum number of notes. Default 100." },
        folder_id: { type: "number", description: "Restrict to one folder." },
        note_type: { type: "string", description: "Restrict to one note type." },
        tags: { type: "array", items: "string", description: "Require all of these tags." },
      },
      mcp: {
        name: "list_notes",
        serialize: (payload) => ({
          success: true,
          data: payload.data.map((note) => sanitizeNote(note)),
          ...LIST_ENVELOPE,
        }),
      },
      cli: {
        method: "GET",
        path: "/v1/notes/list",
        command: "notes list",
        params: { limit: "query", folder_id: "query", note_type: "query", tags: "query" },
      },
      handler: ({ limit, folder_id, note_type, tags }, { db }) => ({
        data: db.getNotes(
          note_type || null,
          parsePositiveInteger(limit, 100),
          folder_id ?? null,
          "updatedAt",
          tags || []
        ),
        ...LIST_ENVELOPE,
      }),
    },
    {
      id: "notes.search",
      title: "Search notes",
      description: "Search notes by keyword, or by meaning when semantic is true.",
      policy: "read",
      params: {
        query: { type: "string", required: true, description: "Search query." },
        limit: { type: "number", description: "Maximum number of results. Default 20." },
        tags: { type: "array", items: "string", description: "Require all of these tags." },
        semantic: {
          type: "boolean",
          description: "Use the hybrid keyword + vector index instead of keyword-only search.",
        },
      },
      mcp: {
        name: "search_notes",
        serialize: (payload) => ({
          success: true,
          data: payload.data.map((note) => sanitizeNote(note)),
          ...LIST_ENVELOPE,
        }),
      },
      cli: {
        method: "GET",
        path: "/v1/notes/search",
        command: "notes search",
        params: { query: "query", limit: "query", tags: "query", semantic: "query" },
        // The CLI has always used `q`; keep accepting it.
        aliases: { q: "query" },
      },
      handler: async ({ query, limit, tags, semantic }, { db, ipc }) => {
        if (!query || !String(query).trim()) {
          throw OperationError.validation("Search query is required");
        }
        const max = parsePositiveInteger(limit, 20);
        const notes = semantic
          ? await ipc.semanticSearchNotes(query, max)
          : db.searchNotes(query, max, tags || []);
        return { data: notes, ...LIST_ENVELOPE };
      },
    },
    {
      id: "notes.get",
      title: "Get note",
      description: "Get the full text fields for one note.",
      policy: "read",
      params: { id: { type: "number", required: true, description: "Note ID." } },
      mcp: {
        name: "get_note",
        serialize: (payload) => ({
          success: true,
          data: sanitizeNote(payload.data, { full: true }),
        }),
      },
      cli: {
        method: "GET",
        path: "/v1/notes/:id",
        command: "notes get",
        params: { id: "path" },
      },
      handler: ({ id }, { db }) => {
        const note = db.getNote(requireId(id, "note"));
        if (!note || note.deleted_at) throw noteNotFound(id);
        return { data: note };
      },
    },
    {
      id: "notes.create",
      title: "Create note",
      description: "Create a local note and update the search index.",
      policy: "write",
      params: {
        title: { type: "string", description: "Note title. Default Untitled Note." },
        content: { type: "string", description: "Note content." },
        note_type: { type: "string", description: "Note type. Default personal." },
        folder_id: { type: "number", description: "Optional folder ID." },
        tags: { type: "array", items: "string", description: "Optional note tags." },
      },
      mcp: {
        name: "create_note",
        serialize: (payload) => ({
          success: true,
          data: sanitizeNote(payload.data, { full: true }),
        }),
      },
      cli: {
        method: "POST",
        path: "/v1/notes/create",
        command: "notes create",
        status: 201,
        params: {
          title: "body",
          content: "body",
          note_type: "body",
          folder_id: "body",
          tags: "body",
        },
      },
      handler: ({ title, content, note_type, folder_id, tags }, { db, ipc, broadcast }) => {
        const result = db.saveNote(
          title ?? "Untitled Note",
          content ?? "",
          note_type ?? "personal",
          null,
          null,
          folder_id ?? null,
          null,
          Array.isArray(tags) ? tags : []
        );
        const note = unwrapMutationResult(result, "note");
        setImmediate(() => {
          broadcast("note-added", note);
          ipc._asyncVectorUpsert(note);
          ipc._asyncMirrorWrite(note);
        });
        return { data: note };
      },
    },
    {
      id: "notes.update",
      title: "Update note",
      description: "Update a note's title, content, enhanced content, transcript, folder or tags.",
      policy: "write",
      params: {
        id: { type: "number", required: true, description: "Note ID." },
        title: { type: "string" },
        content: { type: "string" },
        enhanced_content: { type: "string" },
        transcript: { type: "string" },
        folder_id: { type: "number" },
        tags: { type: "array", items: "string" },
      },
      mcp: {
        name: "update_note",
        serialize: (payload) => ({
          success: true,
          data: sanitizeNote(payload.data, { full: true }),
        }),
      },
      cli: {
        method: "PATCH",
        path: "/v1/notes/:id",
        command: "notes update",
        params: {
          id: "path",
          title: "body",
          content: "body",
          enhanced_content: "body",
          transcript: "body",
          folder_id: "body",
          tags: "body",
        },
      },
      handler: (params, { db, ipc, broadcast }) => {
        const id = requireId(params.id, "note");
        const updates = {};
        for (const key of [
          "title",
          "content",
          "enhanced_content",
          "transcript",
          "folder_id",
          "tags",
        ]) {
          if (params[key] !== undefined) updates[key] = params[key];
        }
        if (Object.keys(updates).length === 0) {
          throw OperationError.validation("No note updates provided");
        }
        const result = db.updateNote(id, updates);
        if (!result?.success || !result.note) {
          throw OperationError.notFound(result?.error || `Note ${id} not found`);
        }
        const note = result.note;
        setImmediate(() => {
          broadcast("note-updated", note);
          ipc._asyncVectorUpsert(note);
          ipc._asyncMirrorWrite(note);
        });
        return { data: note };
      },
    },
    {
      id: "notes.append",
      title: "Append to note",
      description: "Append text to the end of a note's content.",
      policy: "write",
      params: {
        id: { type: "number", required: true, description: "Note ID." },
        text: { type: "string", required: true, description: "Text to append." },
      },
      mcp: {
        name: "append_note",
        serialize: (payload) => ({
          success: true,
          data: sanitizeNote(payload.data, { full: true }),
        }),
      },
      cli: {
        method: "POST",
        path: "/v1/notes/:id/append",
        command: "notes append",
        params: { id: "path", text: "body" },
      },
      handler: ({ id, text }, { db, ipc, broadcast }) => {
        const noteId = requireId(id, "note");
        const note = db.getNote(noteId);
        if (!note || note.deleted_at) throw noteNotFound(noteId);
        const existing = note.content ?? "";
        const next = existing ? `${existing}\n${text}` : text;
        const result = db.updateNote(noteId, { content: next });
        if (!result?.success || !result.note) {
          throw OperationError.notFound(result?.error || `Note ${noteId} not found`);
        }
        setImmediate(() => {
          broadcast("note-updated", result.note);
          ipc._asyncVectorUpsert(result.note);
          ipc._asyncMirrorWrite(result.note);
        });
        return { data: result.note };
      },
    },
    {
      id: "notes.delete",
      title: "Delete note",
      description: "Delete a note and its retained audio references.",
      policy: "destructive",
      params: { id: { type: "number", required: true, description: "Note ID." } },
      notes: [
        "Soft delete — the note moves to the trash and can be restored in the app.",
        "Use purge_note to remove it permanently.",
      ],
      mcp: { name: "delete_note" },
      cli: {
        method: "DELETE",
        path: "/v1/notes/:id",
        command: "notes delete",
        params: { id: "path" },
        noContent: true,
      },
      handler: ({ id }, { ipc }) => {
        const noteId = requireId(id, "note");
        const result = ipc.deleteNoteInternal(noteId);
        if (!result?.success) throw noteNotFound(noteId);
        return { data: { id: noteId, deleted: true } };
      },
    },
    {
      id: "notes.purge",
      title: "Permanently delete a note",
      description: "Purge a note that is already in the trash (hard delete, not recoverable).",
      policy: "destructive",
      params: { id: { type: "number", required: true, description: "Note ID." } },
      notes: ["Irreversible hard delete of an already-trashed note; confirm with the user first."],
      mcp: { name: "purge_note" },
      cli: {
        method: "DELETE",
        path: "/v1/notes/:id/purge",
        command: "notes purge",
        params: { id: "path" },
      },
      handler: async ({ id }, { ipc }) => {
        const noteId = requireId(id, "note");
        const result = await ipc.invokeChannel("db-hard-delete-note", noteId);
        if (result?.success === false) {
          throw OperationError.notFound(result?.error || `Note ${noteId} not found`);
        }
        return { data: { id: noteId, purged: true } };
      },
    },
    {
      id: "notes.export",
      title: "Export note as text",
      description: "Render a note to text without opening a save dialog (markdown, txt, json).",
      policy: "read",
      params: {
        id: { type: "number", required: true, description: "Note ID." },
        format: {
          type: "string",
          enum: ["md", "txt", "json"],
          description: "Export format. Default md.",
        },
        fields: {
          type: "array",
          items: "string",
          description: "Subset of: transcript, notes, enhanced. Default all present fields.",
        },
      },
      notes: [
        "Returns the rendered text in the response — no file is written and no dialog opens.",
        "Use export_notes when the user wants files on disk.",
      ],
      mcp: { name: "export_note" },
      cli: {
        method: "GET",
        path: "/v1/notes/:id/export",
        command: "notes export",
        params: { id: "path", format: "query", fields: "query" },
      },
      handler: ({ id, format, fields }, { db }) => {
        const noteId = requireId(id, "note");
        const note = db.getNote(noteId);
        if (!note || note.deleted_at) throw noteNotFound(noteId);
        const { buildNoteExport } = require("../noteExportFormatter");
        if (format === "json") return { data: { format: "json", content: JSON.stringify(note) } };
        const selected = Array.isArray(fields) && fields.length > 0 ? fields : undefined;
        const content = buildNoteExport(note, {
          format: format === "txt" ? "txt" : "md",
          fields: selected,
        });
        return { data: { format: format ?? "md", content } };
      },
    },

    // ----------------------------------------------------------------- folders
    {
      id: "folders.list",
      title: "List folders",
      description: "List local folders.",
      policy: "read",
      notes: ["Folder ids come from here; pass them to list_notes or update_note."],
      mcp: { name: "list_folders" },
      cli: { method: "GET", path: "/v1/folders/list", command: "folders list" },
      handler: (_params, { db }) => ({ data: db.getFolders(), ...LIST_ENVELOPE }),
    },
    {
      id: "folders.create",
      title: "Create folder",
      description: "Create a local folder.",
      policy: "write",
      params: { name: { type: "string", required: true, description: "Folder name." } },
      mcp: { name: "create_folder" },
      cli: {
        method: "POST",
        path: "/v1/folders/create",
        command: "folders create",
        status: 201,
        params: { name: "body" },
      },
      handler: ({ name }, { db, broadcast }) => {
        const folder = unwrapMutationResult(db.createFolder(name), "folder");
        setImmediate(() => broadcast("folder-created", folder));
        return { data: folder };
      },
    },
    {
      id: "folders.rename",
      title: "Rename folder",
      description: "Rename a folder.",
      policy: "write",
      params: {
        id: { type: "number", required: true, description: "Folder ID." },
        name: { type: "string", required: true, description: "New folder name." },
      },
      mcp: { name: "rename_folder" },
      cli: {
        method: "PATCH",
        path: "/v1/folders/:id",
        command: "folders rename",
        params: { id: "path", name: "body" },
      },
      handler: ({ id, name }, { db, broadcast }) => {
        const folderId = requireId(id, "folder");
        const result = db.renameFolder(folderId, name);
        if (!result?.success)
          throw OperationError.notFound(result?.error || "Failed to rename folder");
        setImmediate(() => broadcast("folder-updated", result.folder ?? { id: folderId, name }));
        return { data: result.folder ?? { id: folderId, name } };
      },
    },
    {
      id: "folders.delete",
      title: "Delete folder",
      description: "Delete a folder. Containers are re-parented by the app's own rules.",
      policy: "destructive",
      params: { id: { type: "number", required: true, description: "Folder ID." } },
      mcp: { name: "delete_folder" },
      cli: {
        method: "DELETE",
        path: "/v1/folders/:id",
        command: "folders delete",
        params: { id: "path" },
        noContent: true,
      },
      handler: ({ id }, { db, broadcast }) => {
        const folderId = requireId(id, "folder");
        const result = db.deleteFolder(folderId);
        if (!result?.success)
          throw OperationError.notFound(result?.error || "Failed to delete folder");
        setImmediate(() => broadcast("folder-deleted", { id: folderId }));
        return { data: { id: folderId, deleted: true } };
      },
    },
    {
      id: "folders.reorder",
      title: "Reorder folders",
      description: "Persist a new folder order.",
      policy: "write",
      params: {
        folder_ids: {
          type: "array",
          items: "number",
          required: true,
          description: "Folder IDs in the desired order.",
        },
      },
      notes: ["Provide every visible folder id exactly once."],
      mcp: { name: "reorder_folders" },
      cli: {
        method: "PUT",
        path: "/v1/folders/order",
        command: "folders reorder",
        params: { folder_ids: "body" },
      },
      handler: ({ folder_ids }, { db, broadcast }) => {
        const result = db.reorderFolders(folder_ids);
        if (!result?.success)
          throw OperationError.validation(result?.error || "Failed to reorder folders");
        const folders = db.getFolders();
        setImmediate(() => broadcast("folders-reordered", folders));
        return { data: folders };
      },
    },

    // -------------------------------------------------------------------- tags
    {
      id: "tags.list",
      title: "List tags",
      description: "List tags used by local notes.",
      policy: "read",
      notes: ["Tags are attached to notes; filter list_notes by tags."],
      mcp: { name: "list_tags" },
      cli: { method: "GET", path: "/v1/tags", command: "tags list" },
      handler: (_params, { db }) => ({ data: db.getTags(), ...LIST_ENVELOPE }),
    },

    // -------------------------------------------------------------- dictionary
    {
      id: "dictionary.list",
      title: "Get dictionary",
      description: "Get custom dictionary hotwords.",
      policy: "read",
      mcp: { name: "get_dictionary" },
      cli: { method: "GET", path: "/v1/dictionary", command: "dict list" },
      handler: (_params, { db }) => ({ data: db.getDictionary() }),
    },
    {
      id: "dictionary.set",
      title: "Replace dictionary",
      description: "Replace the whole hotword list.",
      policy: "destructive",
      params: {
        words: { type: "array", items: "string", required: true, description: "Full word list." },
      },
      notes: ["Replaces the entire hotword list — read it first if you only mean to add."],
      mcp: { name: "set_dictionary" },
      cli: {
        method: "PUT",
        path: "/v1/dictionary",
        command: "dict replace",
        params: { words: "body" },
      },
      handler: ({ words }, { db, broadcast }) => {
        const parsed = parseWordList({ words });
        requireMutationSuccess(db.setDictionary(parsed), "Failed to save dictionary");
        const dictionary = db.getDictionary();
        setImmediate(() => broadcast("dictionary-updated", dictionary));
        return { data: dictionary };
      },
    },
    {
      id: "dictionary.add_words",
      title: "Add dictionary words",
      description: "Add hotwords, skipping ones already present (case-insensitive).",
      policy: "write",
      params: {
        words: { type: "array", items: "string", required: true, description: "Words to add." },
      },
      mcp: { name: "add_dictionary_words" },
      cli: {
        method: "POST",
        path: "/v1/dictionary/words",
        command: "dict add",
        params: { words: "body" },
      },
      handler: ({ words }, { db, broadcast }) => {
        const additions = parseWordList({ words });
        const current = db.getDictionary();
        const known = new Set(current.map((word) => word.toLowerCase()));
        const added = [];
        for (const word of additions) {
          const key = word.toLowerCase();
          if (known.has(key)) continue;
          known.add(key);
          current.push(word);
          added.push(word);
        }
        if (added.length > 0) {
          requireMutationSuccess(db.setDictionary(current), "Failed to save dictionary");
          setImmediate(() => broadcast("dictionary-updated", db.getDictionary()));
        }
        return { data: { added, dictionary: db.getDictionary() } };
      },
    },
    {
      id: "dictionary.remove_words",
      title: "Remove dictionary words",
      description: "Remove hotwords (case-insensitive).",
      policy: "destructive",
      params: {
        words: { type: "array", items: "string", required: true, description: "Words to remove." },
      },
      notes: ["Case-insensitive; missing words are simply ignored."],
      mcp: { name: "remove_dictionary_words" },
      cli: {
        method: "DELETE",
        path: "/v1/dictionary/words",
        command: "dict remove",
        params: { words: "query" },
        queryKeys: { words: "word" },
      },
      handler: ({ words }, { db, broadcast }) => {
        const requested = parseWordList({ words });
        const removeSet = new Set(requested.map((word) => word.toLowerCase()));
        const current = db.getDictionary();
        const kept = current.filter((word) => !removeSet.has(word.toLowerCase()));
        const removed = current.filter((word) => removeSet.has(word.toLowerCase()));
        if (removed.length > 0) {
          requireMutationSuccess(db.setDictionary(kept), "Failed to save dictionary");
          setImmediate(() => broadcast("dictionary-updated", db.getDictionary()));
        }
        return { data: { removed, dictionary: db.getDictionary() } };
      },
    },
    {
      id: "dictionary.aliases.list",
      title: "Get dictionary aliases",
      description: "Get replacement rules used by transcription correction.",
      policy: "read",
      notes: ["Replacement rules applied after ASR (e.g. Antibus → EntVerse)."],
      mcp: { name: "get_dictionary_aliases" },
      cli: { method: "GET", path: "/v1/dictionary/aliases", command: "alias list" },
      handler: (_params, { db }) => ({ data: db.getDictionaryAliases() }),
    },
    {
      id: "dictionary.aliases.set",
      title: "Replace dictionary aliases",
      description: "Replace the whole replacement-rule list.",
      policy: "destructive",
      params: {
        aliases: {
          type: "array",
          items: "object",
          required: true,
          description: 'Rules as [{"from": "...", "to": "..."}].',
        },
      },
      notes: ["Replaces the entire replacement-rule list — read it first if you only mean to add."],
      mcp: { name: "set_dictionary_aliases" },
      cli: {
        method: "PUT",
        path: "/v1/dictionary/aliases",
        command: "alias replace",
        params: { aliases: "body" },
      },
      handler: ({ aliases }, { db, broadcast }) => {
        const parsed = parseAliasList({ aliases });
        requireMutationSuccess(db.setDictionaryAliases(parsed), "Failed to save aliases");
        const saved = db.getDictionaryAliases();
        setImmediate(() => broadcast("dictionary-aliases-updated", saved));
        return { data: saved };
      },
    },
    {
      id: "dictionary.aliases.add",
      title: "Add dictionary alias",
      description: "Add or replace one replacement rule.",
      policy: "write",
      params: {
        from: { type: "string", required: true, description: "Misrecognised text." },
        to: { type: "string", required: true, description: "Correct text." },
      },
      mcp: { name: "add_dictionary_alias" },
      cli: {
        method: "POST",
        path: "/v1/dictionary/aliases",
        command: "alias add",
        params: { from: "body", to: "body" },
      },
      handler: (params, { db, broadcast }) => {
        const { from, to } = parseSingleAlias(params);
        const current = db
          .getDictionaryAliases()
          .filter((alias) => alias.from.toLowerCase() !== from.toLowerCase());
        current.push({ from, to });
        requireMutationSuccess(db.setDictionaryAliases(current), "Failed to save aliases");
        const saved = db.getDictionaryAliases();
        setImmediate(() => broadcast("dictionary-aliases-updated", saved));
        return { data: saved };
      },
    },
    {
      id: "dictionary.aliases.remove",
      title: "Remove dictionary aliases",
      description: "Remove replacement rules by their `from` value.",
      policy: "destructive",
      params: {
        from: { type: "array", items: "string", required: true, description: "`from` values." },
      },
      mcp: { name: "remove_dictionary_aliases" },
      cli: {
        method: "DELETE",
        path: "/v1/dictionary/aliases",
        command: "alias remove",
        params: { from: "query" },
      },
      handler: ({ from }, { db, broadcast }) => {
        const requested = (Array.isArray(from) ? from : [from])
          .map((value) => String(value).trim())
          .filter(Boolean);
        if (requested.length === 0) {
          throw OperationError.validation("Provide at least one `from` value");
        }
        const removeSet = new Set(requested.map((value) => value.toLowerCase()));
        const current = db.getDictionaryAliases();
        const kept = current.filter((alias) => !removeSet.has(alias.from.toLowerCase()));
        const removed = current.filter((alias) => removeSet.has(alias.from.toLowerCase()));
        if (removed.length > 0) {
          requireMutationSuccess(db.setDictionaryAliases(kept), "Failed to save aliases");
          setImmediate(() => broadcast("dictionary-aliases-updated", db.getDictionaryAliases()));
        }
        return { data: { removed, aliases: db.getDictionaryAliases() } };
      },
    },
    {
      id: "dictionary.groups.list",
      title: "List dictionary groups",
      description: "List the dictionary group tree and item memberships.",
      policy: "read",
      notes: ["Nestable organisation layer over hotwords and replacement rules."],
      mcp: { name: "list_dictionary_groups" },
      cli: { method: "GET", path: "/v1/dictionary/groups", command: "dict groups list" },
      handler: (_params, { db }) => ({
        data: {
          groups: db.listDictionaryGroups(),
          assignments: db.listDictionaryGroupAssignments(),
        },
      }),
    },
    {
      id: "dictionary.groups.create",
      title: "Create dictionary group",
      description: "Create a dictionary group (optionally nested).",
      policy: "write",
      params: {
        name: { type: "string", required: true, description: "Group name." },
        parent_id: { type: "number", description: "Parent group ID." },
      },
      mcp: { name: "create_dictionary_group" },
      cli: {
        method: "POST",
        path: "/v1/dictionary/groups",
        command: "dict groups create",
        status: 201,
        params: { name: "body", parent_id: "body" },
      },
      handler: ({ name, parent_id }, { db, broadcast }) => {
        const result = db.createDictionaryGroup(name, parent_id ?? null);
        const snapshot = {
          groups: db.listDictionaryGroups(),
          assignments: db.listDictionaryGroupAssignments(),
        };
        setImmediate(() => broadcast("dictionary-groups-updated", snapshot));
        return { data: { group: result.group, ...snapshot } };
      },
    },
    {
      id: "dictionary.groups.rename",
      title: "Rename dictionary group",
      description: "Rename a dictionary group.",
      policy: "write",
      params: {
        id: { type: "number", required: true, description: "Group ID." },
        name: { type: "string", required: true, description: "New name." },
      },
      mcp: { name: "rename_dictionary_group" },
      cli: {
        method: "PATCH",
        path: "/v1/dictionary/groups/:id",
        command: "dict groups rename",
        params: { id: "path", name: "body" },
      },
      handler: ({ id, name }, { db, broadcast }) => {
        const groupId = requireId(id, "group");
        const result = db.renameDictionaryGroup(groupId, name);
        const snapshot = {
          groups: db.listDictionaryGroups(),
          assignments: db.listDictionaryGroupAssignments(),
        };
        setImmediate(() => broadcast("dictionary-groups-updated", snapshot));
        return { data: { group: result.group, ...snapshot } };
      },
    },
    {
      id: "dictionary.groups.move",
      title: "Move dictionary group or item",
      description: "Re-parent a group, or move a dictionary item into a group.",
      policy: "write",
      params: {
        group_id: { type: "number", description: "Group to move." },
        parent_id: { type: "number", description: "New parent group ID (null for root)." },
        item_type: {
          type: "string",
          enum: ["word", "alias"],
          description: "Move an item instead.",
        },
        key: { type: "string", description: "Item key when moving an item." },
        item_group_id: { type: "number", description: "Target group for the item." },
      },
      mcp: { name: "move_dictionary_group" },
      cli: {
        method: "POST",
        path: "/v1/dictionary/groups/move",
        command: "dict groups move",
        params: {
          group_id: "body",
          parent_id: "body",
          item_type: "body",
          key: "body",
          item_group_id: "body",
        },
      },
      handler: (params, { db, broadcast }) => {
        if (params.item_type) {
          db.setDictionaryGroup({
            itemType: params.item_type,
            key: params.key ?? null,
            groupId: params.item_group_id ?? null,
          });
        } else {
          const groupId = requireId(params.group_id, "group");
          db.moveDictionaryGroup(groupId, params.parent_id ?? null);
        }
        const snapshot = {
          groups: db.listDictionaryGroups(),
          assignments: db.listDictionaryGroupAssignments(),
        };
        setImmediate(() => broadcast("dictionary-groups-updated", snapshot));
        return { data: snapshot };
      },
    },
    {
      id: "dictionary.groups.delete",
      title: "Delete dictionary group",
      description: "Delete a dictionary group; children and items are re-parented.",
      policy: "destructive",
      params: { id: { type: "number", required: true, description: "Group ID." } },
      mcp: { name: "delete_dictionary_group" },
      cli: {
        method: "DELETE",
        path: "/v1/dictionary/groups/:id",
        command: "dict groups delete",
        params: { id: "path" },
      },
      handler: ({ id }, { db, broadcast }) => {
        const groupId = requireId(id, "group");
        const result = db.deleteDictionaryGroup(groupId);
        if (!result?.success) {
          throw OperationError.notFound(result?.error || "Failed to delete group");
        }
        const snapshot = {
          groups: db.listDictionaryGroups(),
          assignments: db.listDictionaryGroupAssignments(),
        };
        setImmediate(() => broadcast("dictionary-groups-updated", snapshot));
        return {
          data: {
            deletedId: result.deletedId,
            deletedName: result.deletedName,
            reparentedCount: result.reparentedCount,
            ungroupedCount: result.ungroupedCount,
            ...snapshot,
          },
        };
      },
    },

    // ---------------------------------------------------------- transcriptions
    {
      id: "transcriptions.list",
      title: "List transcriptions",
      description: "List transcription text records with audio metadata only.",
      policy: "read",
      params: { limit: { type: "number", description: "Maximum records. Default 50." } },
      mcp: {
        name: "list_transcriptions",
        serialize: (payload) => ({
          success: true,
          data: payload.data.filter((item) => !item.deleted_at).map(sanitizeTranscription),
        }),
      },
      cli: {
        method: "GET",
        path: "/v1/transcriptions/list",
        command: "transcriptions list",
        params: { limit: "query" },
      },
      handler: ({ limit }, { db }) => ({
        data: db.getTranscriptions(parsePositiveInteger(limit, 50)),
        ...LIST_ENVELOPE,
      }),
    },
    {
      id: "transcriptions.get",
      title: "Get transcription",
      description: "Get one transcription record with audio metadata only.",
      policy: "read",
      params: { id: { type: "number", required: true, description: "Transcription ID." } },
      mcp: {
        name: "get_transcription",
        serialize: (payload) => ({ success: true, data: sanitizeTranscription(payload.data) }),
      },
      cli: {
        method: "GET",
        path: "/v1/transcriptions/:id",
        command: "transcriptions get",
        params: { id: "path" },
      },
      handler: ({ id }, { db }) => {
        const transcriptionId = requireId(id, "transcription");
        const transcription = db.getTranscriptionById(transcriptionId);
        if (!transcription || transcription.deleted_at) {
          throw OperationError.notFound(`Transcription ${transcriptionId} not found`);
        }
        return { data: transcription };
      },
    },
    {
      id: "transcriptions.delete",
      title: "Delete transcription",
      description: "Delete a transcription record and its audio.",
      policy: "destructive",
      params: { id: { type: "number", required: true, description: "Transcription ID." } },
      notes: ["Deletes the history record and its stored audio."],
      mcp: { name: "delete_transcription" },
      cli: {
        method: "DELETE",
        path: "/v1/transcriptions/:id",
        command: "transcriptions delete",
        params: { id: "path" },
        noContent: true,
      },
      handler: ({ id }, { ipc }) => {
        const transcriptionId = requireId(id, "transcription");
        const result = ipc.deleteTranscriptionInternal(transcriptionId);
        if (!result?.success) {
          throw OperationError.notFound(`Transcription ${transcriptionId} not found`);
        }
        return { data: { id: transcriptionId, deleted: true } };
      },
    },
    {
      id: "transcriptions.delete_audio",
      title: "Delete transcription audio",
      description: "Delete only the stored audio for a transcription, keeping the text.",
      policy: "destructive",
      params: { id: { type: "number", required: true, description: "Transcription ID." } },
      notes: ["Keeps the transcription text, drops only the audio file."],
      mcp: { name: "delete_transcription_audio" },
      cli: {
        method: "DELETE",
        path: "/v1/transcriptions/:id/audio",
        command: "transcriptions delete-audio",
        params: { id: "path" },
        noContent: true,
      },
      handler: ({ id }, { db, ipc }) => {
        const transcriptionId = requireId(id, "transcription");
        const result = ipc.audioStorageManager.deleteAudio(transcriptionId);
        if (!result?.success) {
          throw OperationError.notFound(
            `Failed to delete audio for transcription ${transcriptionId}`
          );
        }
        db.updateTranscriptionAudio(transcriptionId, {
          hasAudio: 0,
          audioDurationMs: null,
          provider: null,
          model: null,
        });
        return { data: { id: transcriptionId, audioDeleted: true } };
      },
    },
  ];
}

module.exports = { coreOperations };
