"use strict";

const { OperationError } = require("./registry");
const { requireId } = require("./params");

/**
 * Note actions: the action definitions (the "生成会议纪要 / 优化转录文本" library)
 * and running one.
 *
 * Running an action is the headline capability agents were missing: the LLM call
 * resolves its provider/model from renderer settings, so the operation dispatches
 * to the renderer, which in turn calls the SAME `executeNoteAction` the toolbar
 * and the note chat use (identical content snapshot, per-note lock, streaming
 * drawer and result validation).
 */
function actionOperations() {
  return [
    {
      id: "actions.list",
      title: "List note actions",
      description: "List the user's note actions (built-in and custom).",
      policy: "read",
      mcp: { name: "list_note_actions" },
      cli: { method: "GET", path: "/v1/actions", command: "actions list" },
      handler: (_params, { db }) => ({ data: db.getActions() }),
    },
    {
      id: "actions.get",
      title: "Get note action",
      description: "Get one note action definition.",
      policy: "read",
      params: { id: { type: "number", required: true, description: "Action ID." } },
      mcp: { name: "get_note_action" },
      cli: {
        method: "GET",
        path: "/v1/actions/:id",
        command: "actions get",
        params: { id: "path" },
      },
      handler: ({ id }, { db }) => {
        const action = db.getAction(requireId(id, "action"));
        if (!action) throw OperationError.notFound(`Action ${id} not found`);
        return { data: action };
      },
    },
    {
      id: "actions.create",
      title: "Create note action",
      description: "Create a custom note action.",
      policy: "write",
      params: {
        name: { type: "string", required: true, description: "Action name." },
        description: { type: "string", description: "Short description." },
        prompt: { type: "string", required: true, description: "Instruction sent to the model." },
        icon: { type: "string", description: "Icon name. Default sparkles." },
        output_target: {
          type: "string",
          enum: ["content", "enhanced_content"],
          description: "Where the result is written. Default content.",
        },
        write_mode: {
          type: "string",
          enum: ["overwrite", "append"],
          description: "How the result is written. Default overwrite.",
        },
      },
      mcp: { name: "create_note_action" },
      cli: {
        method: "POST",
        path: "/v1/actions",
        command: "actions create",
        status: 201,
        params: {
          name: "body",
          description: "body",
          prompt: "body",
          icon: "body",
          output_target: "body",
          write_mode: "body",
        },
      },
      handler: (params, { db, broadcast }) => {
        const result = db.createAction(
          params.name,
          params.description,
          params.prompt,
          params.icon,
          {
            output_target: params.output_target,
            write_mode: params.write_mode,
          }
        );
        if (!result?.success || !result.action) {
          throw OperationError.validation(result?.error || "Failed to create action");
        }
        setImmediate(() => broadcast("action-created", result.action));
        return { data: result.action };
      },
    },
    {
      id: "actions.update",
      title: "Update note action",
      description: "Update a note action definition.",
      policy: "write",
      params: {
        id: { type: "number", required: true, description: "Action ID." },
        name: { type: "string" },
        description: { type: "string" },
        prompt: { type: "string" },
        icon: { type: "string" },
        output_target: { type: "string", enum: ["content", "enhanced_content"] },
        write_mode: { type: "string", enum: ["overwrite", "append"] },
        sort_order: { type: "number" },
      },
      mcp: { name: "update_note_action" },
      cli: {
        method: "PATCH",
        path: "/v1/actions/:id",
        command: "actions update",
        params: {
          id: "path",
          name: "body",
          description: "body",
          prompt: "body",
          icon: "body",
          output_target: "body",
          write_mode: "body",
          sort_order: "body",
        },
      },
      handler: (params, { db, broadcast }) => {
        const id = requireId(params.id, "action");
        const updates = {};
        for (const key of [
          "name",
          "description",
          "prompt",
          "icon",
          "output_target",
          "write_mode",
          "sort_order",
        ]) {
          if (params[key] !== undefined) updates[key] = params[key];
        }
        if (Object.keys(updates).length === 0) {
          throw OperationError.validation("No action updates provided");
        }
        const result = db.updateAction(id, updates);
        if (!result?.success || !result.action) {
          throw OperationError.notFound(result?.error || `Action ${id} not found`);
        }
        setImmediate(() => broadcast("action-updated", result.action));
        return { data: result.action };
      },
    },
    {
      id: "actions.delete",
      title: "Delete note action",
      description: "Delete a note action definition.",
      policy: "destructive",
      params: { id: { type: "number", required: true, description: "Action ID." } },
      mcp: { name: "delete_note_action" },
      cli: {
        method: "DELETE",
        path: "/v1/actions/:id",
        command: "actions delete",
        params: { id: "path" },
        noContent: true,
      },
      handler: ({ id }, { db, broadcast }) => {
        const actionId = requireId(id, "action");
        const result = db.deleteAction(actionId);
        if (!result?.success)
          throw OperationError.notFound(result?.error || `Action ${id} not found`);
        setImmediate(() => broadcast("action-deleted", { id: actionId }));
        return { data: { id: actionId, deleted: true } };
      },
    },
    {
      id: "actions.run",
      title: "Run a note action",
      description:
        "Run a note action (for example 生成会议纪要) on a note. Requires the SuperTing window.",
      policy: "write",
      rendererRequired: true,
      params: {
        id: { type: "number", required: true, description: "Action ID." },
        note_id: { type: "number", required: true, description: "Note to run the action on." },
      },
      mcp: { name: "run_note_action" },
      cli: {
        method: "POST",
        path: "/v1/actions/:id/run",
        command: "actions run",
        params: { id: "path", note_id: "body" },
      },
      handler: async ({ id, note_id }, { db, renderer }) => {
        const actionId = requireId(id, "action");
        const noteId = requireId(note_id, "note");
        const action = db.getAction(actionId);
        if (!action) throw OperationError.notFound(`Action ${actionId} not found`);
        const result = await renderer.invoke("run_note_action", { actionId, noteId });
        if (result?.status === "error") throw OperationError.validation(result.message);
        if (result?.status === "busy") {
          throw OperationError.validation("An AI action is already running on this note");
        }
        if (result?.status === "cancelled") {
          throw OperationError.validation("The action was cancelled");
        }
        return { data: { actionId, noteId, status: "success", updates: result?.updates ?? {} } };
      },
    },
  ];
}

module.exports = { actionOperations };
