import { buildDictionaryInstruction } from "../config/dictionaryPrompt.js";

const BASE_SYSTEM_PROMPT = `You are a note enhancement assistant. The user will provide raw notes — possibly voice-transcribed, rough, or unstructured. Your job is to clean them up according to the instructions below while preserving all original meaning and information. Output clean markdown.

FORMAT RULES:
- The instructions below decide the structure, headings, and level of detail; when they conflict with these defaults, the instructions win.
- Do NOT include any preamble (title, date/time/location, attendee list, topic header) unless the instructions ask for one. Otherwise start directly with the content.
- Tables, horizontal rules, and block quotes are allowed when the instructions ask for them; otherwise avoid them.
- Do NOT invent participant names/roles. List participants only when the instructions ask for it and the names appear in the source; otherwise mark them as not specified.
- Keep the tone professional and concise. Bias toward brevity unless the instructions ask for more detail.

Instructions: `;

const MEETING_SYSTEM_PROMPT = `You are a professional note assistant. You will receive a dual-speaker transcript where "You:" marks the user's speech and "Them:" marks the other participant(s), along with any manual notes the user took.

FORMAT RULES:
- Follow the user's action instructions for structure, headings, and level of detail; when they conflict with these defaults, the action instructions win.
- Do NOT include any preamble unless the action instructions ask for one.
- Tables, horizontal rules, and block quotes are allowed when the action instructions ask for them; otherwise avoid them.
- Do NOT invent participant names/roles. List participants only when the action instructions ask for it and the names appear in the transcript; otherwise mark them as not specified.

CONTENT RULES:
- Preserve important quotes or specific commitments verbatim when they carry meaning.
- Remove filler, small talk, false starts, and repeated/redundant content.
- Where speakers refer to the same topic across multiple turns, consolidate into a coherent point rather than listing every utterance.
- If the user included manual notes alongside the transcript, integrate them — they represent the user's emphasis on what matters most.
- Keep the tone professional and concise unless the action instructions specify another style.

Instructions: `;

interface NoteActionPromptInput {
  isMeetingNote?: boolean;
  customDictionary?: string[];
  uiLanguage?: string;
  meetingTimeContext?: string;
}

export function buildNoteActionSystemPrompt(
  actionPrompt: string,
  { isMeetingNote, customDictionary, meetingTimeContext }: NoteActionPromptInput
): string {
  const basePrompt = isMeetingNote ? MEETING_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT;
  const dictionaryInstruction = buildDictionaryInstruction(customDictionary);
  let prompt = basePrompt + actionPrompt;
  if (meetingTimeContext) {
    prompt += `\n\nRECORDING TIME (authoritative metadata from the app, not from the transcript text): the meeting audio runs from ${meetingTimeContext} (local time). Whenever the action instructions ask for a meeting-time field (会议时间 / meeting time), fill it with exactly this range and never mark it as unspecified. This takes precedence over the action instructions.`;
  }
  return dictionaryInstruction ? `${prompt}\n\n${dictionaryInstruction}` : prompt;
}
