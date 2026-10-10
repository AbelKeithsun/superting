"use strict";

const crypto = require("crypto");
const debugLogger = require("./debugLogger");

/**
 * Job registry for long-running capabilities (speaker re-diarization, audio
 * merge, bulk compression, audio-file transcription).
 *
 * Agents used to block on a single HTTP/MCP call for minutes with no way to
 * observe or cancel progress. Long operations can now be started with
 * `wait: false`, which returns `{ job_id, status }` immediately; the job keeps
 * running in the app process, broadcasts state changes to the UI, and is
 * readable through `jobs.get` / `jobs.list`.
 *
 * Cancellation is cooperative: the underlying work is not abortable today, so
 * `cancel()` marks the job and its result is discarded on completion. That is
 * reported honestly as `cancelled` rather than pretending the work stopped.
 */

const MAX_JOBS = 100;

class OperationJobRegistry {
  constructor({ broadcast = null, maxJobs = MAX_JOBS } = {}) {
    this.jobs = new Map();
    this.order = [];
    this.broadcast = broadcast;
    this.maxJobs = maxJobs;
  }

  /**
   * @param {object} input
   * @param {string} input.operation Operation id that produced the job.
   * @param {string} [input.title] Human label.
   * @param {(report: (progress: object) => void) => Promise<any>} input.run
   * @returns {object} the job record (running).
   */
  start({ operation, title = null, run }) {
    const job = {
      id: `job-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
      operation,
      title,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      progress: null,
      result: null,
      error: null,
      cancelRequested: false,
    };
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    this._trim();
    this._emit("operation-job-started", job);

    const report = (progress) => {
      job.progress = progress && typeof progress === "object" ? progress : { value: progress };
      this._emit("operation-job-updated", job);
    };

    void Promise.resolve()
      .then(() => run(report))
      .then((result) => {
        if (job.cancelRequested) {
          job.status = "cancelled";
          job.result = null;
        } else {
          job.status = "succeeded";
          job.result = result ?? null;
        }
      })
      .catch((error) => {
        job.status = job.cancelRequested ? "cancelled" : "failed";
        job.error = error instanceof Error ? error.message : String(error);
        debugLogger.warn(
          "Operation job failed",
          { jobId: job.id, operation: job.operation, error: job.error },
          "app-operations"
        );
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        this._emit("operation-job-finished", job);
      });

    return job;
  }

  get(id) {
    return this.jobs.get(id) ?? null;
  }

  list({ limit = 20, status = null } = {}) {
    const ids = [...this.order].reverse();
    const out = [];
    for (const id of ids) {
      const job = this.jobs.get(id);
      if (!job) continue;
      if (status && job.status !== status) continue;
      out.push(job);
      if (out.length >= limit) break;
    }
    return out;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status !== "running") return job;
    job.cancelRequested = true;
    job.progress = { ...(job.progress ?? {}), message: "cancellation requested" };
    this._emit("operation-job-updated", job);
    return job;
  }

  _trim() {
    while (this.order.length > this.maxJobs) {
      const oldest = this.order.shift();
      this.jobs.delete(oldest);
    }
  }

  _emit(channel, job) {
    if (!this.broadcast) return;
    try {
      this.broadcast(channel, { ...job });
    } catch (error) {
      debugLogger.debug(
        "Operation job broadcast failed",
        { error: error.message },
        "app-operations"
      );
    }
  }
}

module.exports = { MAX_JOBS, OperationJobRegistry };
