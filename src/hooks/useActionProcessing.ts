import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ActionItem } from "../types/electron";
import {
  useActionProcessingStore,
  selectNoteActionState,
  runBackgroundAction,
  cancelAction as storeCancelAction,
  type ActionProcessingStatus,
} from "../stores/actionProcessingStore";

export type ActionProcessingState = ActionProcessingStatus;

/** React binding for the global actionProcessingStore, scoped to one note. */
export function useActionProcessing(noteId: number | null) {
  const {
    status: state,
    actionName,
    outputTarget,
  } = useActionProcessingStore(useShallow((s) => selectNoteActionState(s, noteId)));

  // The action itself resolves its content, model and speaker labels through
  // the shared executor — callers only say *which* action to run.
  const runAction = useCallback(
    (action: ActionItem) => {
      if (noteId == null) return;
      runBackgroundAction(noteId, action, "toolbar");
    },
    [noteId]
  );

  const cancel = useCallback(() => {
    if (noteId != null) storeCancelAction(noteId);
  }, [noteId]);

  return { state, actionName, outputTarget, runAction, cancel };
}
