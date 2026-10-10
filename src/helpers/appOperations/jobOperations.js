"use strict";

const { OperationError } = require("./registry");

/**
 * Job control surface for long-running capabilities.
 *
 * Long operations accept `wait: false` and answer with a job id; these three
 * operations are how an agent follows up (poll `jobs.get`, list recent work,
 * or request cancellation).
 */

const JOB_STATUSES = ["running", "succeeded", "failed", "cancelled"];

function serializeJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    operation: job.operation,
    title: job.title,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress,
    result: job.result,
    error: job.error,
    cancelRequested: job.cancelRequested,
  };
}

function requireJobs(ctx) {
  if (!ctx.jobs) {
    throw OperationError.unavailable("The job registry is not available in this process");
  }
  return ctx.jobs;
}

function jobOperations() {
  return [
    {
      id: "jobs.list",
      title: "List operation jobs",
      description: "List recent long-running operation jobs (newest first).",
      policy: "read",
      params: {
        limit: { type: "number", description: "Maximum jobs to return. Default 20." },
        status: { type: "string", enum: JOB_STATUSES, description: "Filter by status." },
      },
      mcp: { name: "list_jobs" },
      cli: {
        method: "GET",
        path: "/v1/jobs",
        command: "jobs list",
        params: { limit: "query", status: "query" },
      },
      handler: ({ limit, status }, ctx) => {
        const jobs = requireJobs(ctx);
        const parsed = Number(limit);
        return {
          data: jobs
            .list({
              limit: Number.isFinite(parsed) && parsed > 0 ? parsed : 20,
              status: status ?? null,
            })
            .map(serializeJob),
        };
      },
    },
    {
      id: "jobs.get",
      title: "Get operation job",
      description: "Get one job's status, progress and result.",
      policy: "read",
      params: { id: { type: "string", required: true, description: "Job id." } },
      mcp: { name: "get_job" },
      cli: { method: "GET", path: "/v1/jobs/:id", command: "jobs get", params: { id: "path" } },
      handler: ({ id }, ctx) => {
        const job = requireJobs(ctx).get(id);
        if (!job) throw OperationError.notFound(`Job ${id} not found`);
        return { data: serializeJob(job) };
      },
    },
    {
      id: "jobs.cancel",
      title: "Cancel operation job",
      description:
        "Request cancellation of a running job. The underlying work is not abortable, so the result is discarded on completion.",
      policy: "write",
      params: { id: { type: "string", required: true, description: "Job id." } },
      mcp: { name: "cancel_job" },
      cli: {
        method: "POST",
        path: "/v1/jobs/:id/cancel",
        command: "jobs cancel",
        params: { id: "path" },
      },
      handler: ({ id }, ctx) => {
        const jobs = requireJobs(ctx);
        const job = jobs.cancel(id);
        if (!job) throw OperationError.notFound(`Job ${id} not found`);
        return { data: serializeJob(job) };
      },
    },
  ];
}

module.exports = { JOB_STATUSES, jobOperations, serializeJob };
