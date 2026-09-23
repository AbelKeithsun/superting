import reasoningService from "../services/ReasoningService";
import type { ReasoningConfig, ReasoningStreamEvent } from "../services/BaseReasoningService";
import type { ActionItem, NoteItem } from "../types/electron";
import { applyMeetingTimeFallback, buildMeetingTimeRange } from "./meetingTimeContext";
import { getSettings } from "./settingsStore";
import { resolveNoteFormattingRequest } from "./noteFormattingRequest";
import { buildNoteActionSystemPrompt } from "./noteActionPrompt";
import {
  computeNoteActionMaxTokens,
  noteActionMaxTokensCeiling,
  NOTE_ACTION_REQUEST_TIMEOUT_MS,
} from "./noteActionBudget.js";
import { isOutputBudgetExceeded } from "../utils/retry";
import { generateNoteTitle } from "../utils/generateTitle";
import { buildNoteActionInput } from "../components/notes/noteActionInput";
import {
  applyActionTitleDatePrefix,
  buildActionOutputUpdates,
  hasGeneratedActionContent,
  shouldGenerateTitleForExplicitAction,
} from "./actionProcessingCore";
import { loggableText, logNoteAction, makeNoteActionOperationId } from "./noteActionLogger";

interface RunNoteActionOnceInput {
  noteId?: number;
  note: Pick<
    NoteItem,
    | "title"
    | "content"
    | "enhanced_content"
    | "transcript"
    | "recorded_at"
    | "created_at"
    | "audio_duration_seconds"
  >;
  action: ActionItem;
  modelId: string;
  isCloudMode: boolean;
  operationId?: string;
  /** Live reasoning/content stream for the side drawer (SSE providers only). */
  onStream?: (event: ReasoningStreamEvent) => void;
  speakerLabels: {
    you: string;
    them: string;
  };
}

export interface RunNoteActionOnceResult {
  generatedContent: string;
  updates: Record<string, string | null>;
}

export async function runNoteActionOnce({
  noteId,
  note,
  action,
  modelId,
  isCloudMode,
  operationId,
  onStream,
  speakerLabels,
}: RunNoteActionOnceInput): Promise<RunNoteActionOnceResult> {
  const effectiveNoteId = noteId ?? -1;
  const effectiveOperationId = operationId ?? makeNoteActionOperationId(effectiveNoteId, action.id);
  const actionInput = buildNoteActionInput({
    noteContent: note.content,
    rawTranscript: note.transcript,
    speakerLabels,
  });
  if (!actionInput) {
    logNoteAction(
      "NOTE_ACTION_INPUT_EMPTY",
      {
        operationId: effectiveOperationId,
        noteId: effectiveNoteId,
        actionId: action.id,
        actionName: action.name,
        noteContentLength: String(note.content ?? "").length,
        transcriptLength: String(note.transcript ?? "").length,
      },
      "warn"
    );
    throw new Error("No note content or transcript available");
  }

  const settings = getSettings();
  const meetingTimeRange = buildMeetingTimeRange(note);
  const systemPrompt = buildNoteActionSystemPrompt(action.prompt, {
    isMeetingNote: actionInput.isMeetingNote,
    customDictionary: settings.customDictionary,
    uiLanguage: settings.uiLanguage,
    meetingTimeContext: meetingTimeRange ?? undefined,
  });

  // The output cap is shared with hidden reasoning on thinking models, and a
  // rewrite-style action (优化转录文本) re-emits the whole transcript, so the
  // budget scales with the TOTAL input size (system prompt included — the
  // model thinks over everything it reads) — with a per-provider ceiling,
  // because a cap above the model's own limit is rejected outright. A bigger
  // budget also makes the request run longer: the provider default (90s)
  // aborted long rewrites mid-generation.
  const inputChars = systemPrompt.length + actionInput.content.length;
  const { selectedModel, reasoningConfig, resolvedFormatting, isHostedMode, hasModel } =
    resolveNoteFormattingRequest({
      settings,
      modelId,
      systemPrompt,
      isCloudMode,
      maxTokensForProvider: (provider) =>
        computeNoteActionMaxTokens(inputChars, noteActionMaxTokensCeiling(provider)),
      timeoutMs: NOTE_ACTION_REQUEST_TIMEOUT_MS,
    });

  if (!hasModel) {
    logNoteAction(
      "NOTE_ACTION_NO_MODEL",
      {
        operationId: effectiveOperationId,
        noteId: effectiveNoteId,
        actionId: action.id,
        actionName: action.name,
        resolvedMode: resolvedFormatting.mode,
        provider: resolvedFormatting.provider || null,
      },
      "error"
    );
    throw new Error("No AI model selected");
  }

  logNoteAction("NOTE_ACTION_MODEL_REQUEST", {
    operationId: effectiveOperationId,
    noteId: effectiveNoteId,
    actionId: action.id,
    actionName: action.name,
    outputTarget: action.output_target,
    writeMode: action.write_mode,
    selectedModel,
    resolvedMode: resolvedFormatting.mode,
    provider: resolvedFormatting.provider || null,
    isCloudMode,
    isHostedMode,
    isMeetingNote: actionInput.isMeetingNote,
    contentHash: actionInput.contentHash,
    actionInputLength: actionInput.content.length,
    noteContentLength: String(note.content ?? "").length,
    transcriptLength: String(note.transcript ?? "").length,
    enhancedContentLength: String(note.enhanced_content ?? "").length,
    systemPromptLength: systemPrompt.length,
    actionPrompt: action.prompt,
  });

  const withStream = (config: ReasoningConfig): ReasoningConfig => ({ ...config, onStream });

  let generatedContent: string;
  try {
    generatedContent = await reasoningService.processText(
      actionInput.content,
      selectedModel,
      null,
      withStream(reasoningConfig)
    );
  } catch (error) {
    // Output-budget exhaustion self-heals once with a doubled cap (bounded by
    // the provider ceiling); anything else propagates.
    const ceiling = noteActionMaxTokensCeiling(resolvedFormatting.provider);
    const budget = reasoningConfig.maxTokens ?? computeNoteActionMaxTokens(inputChars, ceiling);
    const doubled = Math.min(ceiling, budget * 2);
    if (!isOutputBudgetExceeded(error) || doubled <= budget) throw error;
    logNoteAction(
      "NOTE_ACTION_BUDGET_RETRY",
      {
        operationId: effectiveOperationId,
        noteId: effectiveNoteId,
        actionId: action.id,
        actionName: action.name,
        budget,
        retryBudget: doubled,
      },
      "warn"
    );
    const retried = resolveNoteFormattingRequest({
      settings,
      modelId,
      systemPrompt,
      isCloudMode,
      maxTokensForProvider: () => doubled,
      timeoutMs: NOTE_ACTION_REQUEST_TIMEOUT_MS,
    });
    generatedContent = await reasoningService.processText(
      actionInput.content,
      retried.selectedModel,
      null,
      withStream(retried.reasoningConfig)
    );
  }
  logNoteAction("NOTE_ACTION_MODEL_RESPONSE", {
    operationId: effectiveOperationId,
    noteId: effectiveNoteId,
    actionId: action.id,
    actionName: action.name,
    selectedModel,
    generatedContent: loggableText(generatedContent),
  });
  if (!hasGeneratedActionContent(generatedContent)) {
    logNoteAction(
      "NOTE_ACTION_EMPTY_RESPONSE",
      {
        operationId: effectiveOperationId,
        noteId: effectiveNoteId,
        actionId: action.id,
        actionName: action.name,
        selectedModel,
        generatedContent: loggableText(generatedContent),
      },
      "error"
    );
    throw new Error("Action generated empty content");
  }

  // Last-resort guarantee: if the model still wrote an unspecified meeting
  // time even though the recording window is known, fill it in programmatically
  // so the summary never shows "未明确" when the data exists.
  const finalContent = meetingTimeRange
    ? applyMeetingTimeFallback(generatedContent, meetingTimeRange)
    : generatedContent;
  if (finalContent !== generatedContent) {
    logNoteAction("NOTE_ACTION_MEETING_TIME_FALLBACK", {
      operationId: effectiveOperationId,
      noteId: effectiveNoteId,
      actionId: action.id,
      actionName: action.name,
      meetingTimeRange,
      generatedContent: loggableText(generatedContent),
      finalContent: loggableText(finalContent),
    });
  }

  const updates = buildActionOutputUpdates({
    outputTarget: action.output_target,
    writeMode: action.write_mode,
    generatedContent: finalContent,
    existingContent: note.content,
    existingEnhancedContent: note.enhanced_content,
    actionPrompt: action.prompt,
    contentHash: actionInput.contentHash,
  });
  logNoteAction("NOTE_ACTION_UPDATE_PAYLOAD", {
    operationId: effectiveOperationId,
    noteId: effectiveNoteId,
    actionId: action.id,
    actionName: action.name,
    updates,
  });

  if (shouldGenerateTitleForExplicitAction(note.title)) {
    logNoteAction("NOTE_ACTION_TITLE_REQUEST", {
      operationId: effectiveOperationId,
      noteId: effectiveNoteId,
      actionId: action.id,
      actionName: action.name,
      selectedModel,
      generatedContentLength: finalContent.length,
    });
    const title = await generateNoteTitle(
      finalContent,
      selectedModel,
      settings.customDictionary,
      settings.uiLanguage,
      reasoningConfig
    );
    logNoteAction("NOTE_ACTION_TITLE_RESPONSE", {
      operationId: effectiveOperationId,
      noteId: effectiveNoteId,
      actionId: action.id,
      actionName: action.name,
      title,
    });
    if (title)
      updates.title = applyActionTitleDatePrefix(title, note.recorded_at || note.created_at);
  }

  logNoteAction("NOTE_ACTION_RESULT", {
    operationId: effectiveOperationId,
    noteId: effectiveNoteId,
    actionId: action.id,
    actionName: action.name,
    generatedContent: loggableText(finalContent),
    updates,
  });

  return { generatedContent: finalContent, updates };
}
