import { RETRY_CONFIG } from "../config/constants";

export interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: any) => boolean;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxRetries = RETRY_CONFIG.MAX_RETRIES,
    initialDelay = RETRY_CONFIG.INITIAL_DELAY,
    maxDelay = RETRY_CONFIG.MAX_DELAY,
    backoffMultiplier = RETRY_CONFIG.BACKOFF_MULTIPLIER,
    shouldRetry = () => true,
  } = options;

  let lastError: any;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // Wait before retrying with exponential backoff
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * backoffMultiplier, maxDelay);
    }
  }

  throw lastError;
}

/**
 * Build the error thrown when a request hits its wall-clock cap.
 *
 * Unlike a network failure this is not transient — the request was accepted and
 * was still being generated — so it is marked `noRetry` and
 * `createApiRetryStrategy` refuses it. Retrying would only multiply the wait
 * (note actions allow up to 10 minutes per attempt).
 */
export function requestTimeoutError(timeoutMs: number): Error {
  const error = new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`) as Error & {
    noRetry?: boolean;
  };
  error.noRetry = true;
  return error;
}

/**
 * Build the error thrown when the model exhausts its output token budget
 * (`incomplete_details.reason === "max_output_tokens"`, or a reasoning-only
 * response with no visible content).
 *
 * Marked `noRetry` because blind provider-level retries would burn the same
 * budget again; callers that can raise the budget (note actions, transcript
 * polish) catch the `outputBudgetExceeded` flag and retry once deliberately
 * with a doubled cap.
 */
export function outputBudgetExceededError(message?: string): Error {
  const error = new Error(
    message ??
      "The model spent its entire output budget on reasoning and returned no content. " +
        "Raise the output token budget or lower the reasoning effort, then run the action again."
  ) as Error & { noRetry?: boolean; outputBudgetExceeded?: boolean };
  error.noRetry = true;
  error.outputBudgetExceeded = true;
  return error;
}

/** Type guard for the deliberate-retry path in note actions / polish. */
export function isOutputBudgetExceeded(error: unknown): boolean {
  return (error as { outputBudgetExceeded?: boolean } | null)?.outputBudgetExceeded === true;
}

// Specific retry strategy for API calls
export function createApiRetryStrategy() {
  return {
    shouldRetry: (error: any) => {
      // A wall-clock timeout means the request was in flight and simply took
      // longer than the cap — not that the network failed. Retrying multiplies
      // the wait (note actions allow up to 10 minutes per attempt).
      if (error?.noRetry === true) return false;

      // Retry on network errors or 5xx status codes
      if (!error.response) return true; // Network error

      const status = error.response?.status || error.status;
      return status >= 500 && status < 600;
    },
  };
}

// Specific retry strategy for file operations
export function createFileRetryStrategy() {
  return {
    shouldRetry: (error: any) => {
      // Retry on temporary file system errors
      const retriableErrors = ["EBUSY", "ENOENT", "EPERM", "EAGAIN"];
      return retriableErrors.includes(error.code);
    },
    maxRetries: 2,
    initialDelay: 500,
  };
}
