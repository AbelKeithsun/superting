import type { DiarizationTaskStatus } from "../../types/electron";

export type NoteListBackgroundStatus =
  | {
      kind: "action";
      label: string;
      isLoading: true;
    }
  | {
      kind: "diarization-running" | "diarization-complete";
      translationKey: string;
      isLoading: boolean;
    };

interface NoteListBackgroundStatusInput {
  noteId: number;
  actionLabel?: string | null;
  isActionProcessing?: boolean;
  diarizationTaskStatus?: DiarizationTaskStatus | null;
  completedDiarizationNoteId?: number | null;
}

export function getNoteListBackgroundStatus({
  noteId,
  actionLabel,
  isActionProcessing = false,
  diarizationTaskStatus = null,
  completedDiarizationNoteId = null,
}: NoteListBackgroundStatusInput): NoteListBackgroundStatus | null {
  if (isActionProcessing) {
    return {
      kind: "action",
      label: actionLabel || "",
      isLoading: true,
    };
  }

  if (diarizationTaskStatus?.task?.noteId === noteId) {
    return {
      kind: "diarization-running",
      translationKey: "notes.list.identifyingSpeakers",
      isLoading: true,
    };
  }

  if (completedDiarizationNoteId === noteId) {
    return {
      kind: "diarization-complete",
      translationKey: "notes.list.speakersIdentified",
      isLoading: false,
    };
  }

  return null;
}

export function getFinishedDiarizationNoteId(
  previousStatus: DiarizationTaskStatus | null | undefined,
  nextStatus: DiarizationTaskStatus | null | undefined
): number | null {
  const previousTask = previousStatus?.task;
  if (!previousTask) return null;

  if (nextStatus?.activeTaskCount === 0 && !nextStatus.task) {
    return previousTask.noteId;
  }

  return null;
}
