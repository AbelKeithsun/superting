/**
 * Renderer-side ESM mirror of openaiCompatibleErrors.js (CommonJS, required
 * by tests). Vite 8 (rolldown) serves CJS source files without interop, so
 * importing the .js directly white-screens dev — keep the two in sync.
 * Same pattern as thinkingSuppressionPolicyCompat.ts.
 */

export function formatOpenAiCompatibleError({
  status,
  fallbackMessage,
  isCustomProvider,
}: {
  status: number;
  fallbackMessage: string;
  isCustomProvider?: boolean;
}): string {
  if (isCustomProvider && status === 401) {
    return "Custom provider authentication failed (401). Check the custom endpoint API key and make sure it belongs to that provider.";
  }

  return fallbackMessage;
}
