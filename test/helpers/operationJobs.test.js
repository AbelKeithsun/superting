"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { OperationJobRegistry } = require("../../src/helpers/operationJobs");

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a job records success and its result", async () => {
  const registry = new OperationJobRegistry();
  const job = registry.start({
    operation: "audio.compress_all",
    title: "Compress all audio",
    run: async (report) => {
      report({ done: 1, total: 2 });
      report({ done: 2, total: 2 });
      return { compressed: 2 };
    },
  });

  assert.equal(job.status, "running");
  assert.equal(registry.list().length, 1);

  await tick();
  await tick();
  const settled = registry.get(job.id);
  assert.equal(settled.status, "succeeded");
  assert.deepEqual(settled.result, { compressed: 2 });
  assert.deepEqual(settled.progress, { done: 2, total: 2 });
  assert.ok(settled.finishedAt);
});

test("a failing job records the error instead of throwing", async () => {
  const registry = new OperationJobRegistry();
  const job = registry.start({
    operation: "transcriptions.transcribe_file",
    run: async () => {
      throw new Error("no model");
    },
  });

  await tick();
  await tick();
  const settled = registry.get(job.id);
  assert.equal(settled.status, "failed");
  assert.equal(settled.error, "no model");
  assert.equal(settled.result, null);
});

test("cancellation is cooperative and discards the late result", async () => {
  const registry = new OperationJobRegistry();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const job = registry.start({
    operation: "notes.audio.rediarize",
    run: async () => {
      await gate;
      return { speakers: 3 };
    },
  });

  const cancelled = registry.cancel(job.id);
  assert.equal(cancelled.cancelRequested, true);
  assert.equal(cancelled.status, "running", "the work itself cannot be aborted");

  release();
  await tick();
  await tick();
  const settled = registry.get(job.id);
  assert.equal(settled.status, "cancelled");
  assert.equal(settled.result, null, "a cancelled job never reports a result");

  assert.equal(registry.cancel("job-missing"), null);
});

test("list filters by status, honours the limit, and trims old jobs", async () => {
  const registry = new OperationJobRegistry({ maxJobs: 3 });
  for (let i = 0; i < 5; i += 1) {
    registry.start({ operation: `op.${i}`, run: async () => i });
  }
  await tick();
  await tick();

  assert.equal(registry.list().length, 3, "oldest jobs are trimmed");
  assert.equal(registry.list({ limit: 2 }).length, 2);
  assert.equal(registry.list({ status: "succeeded" }).length, 3);
  assert.equal(registry.list({ status: "failed" }).length, 0);
});

test("state changes are broadcast for the UI", async () => {
  const events = [];
  const registry = new OperationJobRegistry({
    broadcast: (channel, payload) => events.push([channel, payload.id]),
  });
  const job = registry.start({ operation: "audio.compress_all", run: async () => 1 });
  await tick();
  await tick();

  assert.equal(events[0][0], "operation-job-started");
  assert.ok(events.some(([channel]) => channel === "operation-job-finished"));
  assert.ok(events.every(([, id]) => id === job.id));
});
