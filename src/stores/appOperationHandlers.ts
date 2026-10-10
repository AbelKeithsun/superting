import { executeNoteAction } from "./actionProcessingStore";
import type { ActionItem } from "../types/electron";

/**
 * Renderer half of the main → renderer operation bridge (see
 * src/helpers/appOperations/rendererBridge.js).
 *
 * Operations that genuinely need the UI process — today: running a note action,
 * whose LLM provider/model come from renderer settings — dispatch here. The
 * handler calls the SAME `executeNoteAction` the toolbar and the note chat use,
 * so an action started from MCP or the CLI produces an identical result
 * (content snapshot, per-note lock, streaming drawer, validation).
 */

type AppOperationHandler = (payload: Record<string, unknown>) => Promise<unknown> | unknown;

async function findAction(actionId: number): Promise<ActionItem> {
  const actions = (await window.electronAPI?.getActions?.()) ?? [];
  const action = actions.find((item) => item.id === actionId);
  if (!action) throw new Error(`Action ${actionId} not found`);
  return action;
}

const handlers: Record<string, AppOperationHandler> = {
  run_note_action: async (payload) => {
    const actionId = Number(payload?.actionId);
    const noteId = Number(payload?.noteId);
    if (!Number.isFinite(actionId) || !Number.isFinite(noteId)) {
      throw new Error("run_note_action requires actionId and noteId");
    }
    const action = await findAction(actionId);
    return executeNoteAction({ noteId, action, trigger: "tool" });
  },
};

interface AppOperationMessage {
  id?: string;
  channel?: string;
  payload?: Record<string, unknown>;
}

/** Installs the bridge listener; returns an unsubscribe function. */
export function registerAppOperationHandlers(): () => void {
  const api = window.electronAPI;
  if (!api?.onAppOperationRequest) return () => {};

  return api.onAppOperationRequest((message: AppOperationMessage) => {
    const { id, channel } = message ?? {};
    if (!id || !channel) return;
    const respond = (result: unknown) => {
      api.respondAppOperation?.({ id, ok: true, result });
    };
    const fail = (error: unknown) => {
      api.respondAppOperation?.({
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    };

    const handler = handlers[channel];
    if (!handler) {
      fail(new Error(`No renderer handler for app operation "${channel}"`));
      return;
    }

    // Handlers may be async; never let a rejection escape as an unhandled one.
    void Promise.resolve()
      .then(() => handler(message.payload ?? {}))
      .then(respond)
      .catch(fail);
  });
}

export { handlers as appOperationHandlers };
