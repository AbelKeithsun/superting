import assert from "node:assert/strict";
import test from "node:test";

import {
  createResponsesSseParser,
  normalizeResponsesEvent,
} from "../../src/utils/responsesSse.ts";

function parseAll(chunks: string[]) {
  const parser = createResponsesSseParser();
  const events = chunks.flatMap((chunk) => parser.feed(chunk));
  events.push(...parser.flush());
  return events;
}

test("parses a single complete event", () => {
  const events = parseAll([
    'event: response.output_text.delta\ndata: {"delta":"你"}\n\n',
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "response.output_text.delta");
  assert.deepEqual(events[0].data, { delta: "你" });
});

test("parses multiple events in one chunk and keeps order", () => {
  const events = parseAll([
    'event: response.reasoning_text.delta\ndata: {"delta":"嗯"}\n\n' +
      'event: response.reasoning_text.delta\ndata: {"delta":"，"}\n\n' +
      'event: response.output_text.delta\ndata: {"delta":"好"}\n\n',
  ]);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "response.reasoning_text.delta",
      "response.reasoning_text.delta",
      "response.output_text.delta",
    ]
  );
});

test("an event split across chunks is only emitted when complete", () => {
  const parser = createResponsesSseParser();
  assert.deepEqual(parser.feed('event: response.output_text.delta\nda'), []);
  assert.deepEqual(parser.feed('ta: {"delta":"中"}\n'), [], "no blank-line boundary yet");
  const done = parser.feed("\n");
  assert.equal(done.length, 1);
  assert.deepEqual(done[0].data, { delta: "中" });
});

test("crlf line endings and multi-line data are handled", () => {
  const events = parseAll([
    "event: response.completed\r\n" +
      'data: {"response":{"status":"completed",' +
      '"usage":{"input_tokens":10,"output_tokens":5}}}\r\n\r\n',
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "response.completed");
});

test("flush parses a truncated tail event without a closing blank line", () => {
  const events = parseAll(['event: response.failed\ndata: {"response":{"error":{"message":"boom"}}}']);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "response.failed");
});

test("comment lines and empty blocks are ignored", () => {
  const events = parseAll([": keep-alive\n\nevent: response.created\ndata: {}\n\n"]);
  assert.deepEqual(
    events.map((event) => event.type),
    ["response.created"]
  );
});

test("normalize maps deltas, usage details and terminal states", () => {
  assert.deepEqual(
    normalizeResponsesEvent({ type: "response.reasoning_text.delta", data: { delta: "想" } }),
    { kind: "reasoning-delta", text: "想" }
  );
  assert.deepEqual(
    normalizeResponsesEvent({ type: "response.output_text.delta", data: { delta: "答" } }),
    { kind: "content-delta", text: "答" }
  );

  const completed = normalizeResponsesEvent({
    type: "response.completed",
    data: {
      response: {
        usage: {
          input_tokens: 1200,
          output_tokens: 800,
          output_tokens_details: { reasoning_tokens: 500 },
          input_tokens_details: { cached_tokens: 300 },
        },
      },
    },
  });
  assert.equal(completed.kind, "completed");
  assert.deepEqual(completed.usage, {
    inputTokens: 1200,
    outputTokens: 800,
    reasoningTokens: 500,
    cachedTokens: 300,
  });

  const incomplete = normalizeResponsesEvent({
    type: "response.incomplete",
    data: { response: { incomplete_details: { reason: "max_output_tokens" } } },
  });
  assert.equal(incomplete.kind, "incomplete");
  assert.equal(incomplete.kind === "incomplete" ? incomplete.reason : null, "max_output_tokens");

  const failed = normalizeResponsesEvent({
    type: "response.failed",
    data: { response: { error: { message: "provider down" } } },
  });
  assert.deepEqual(failed, { kind: "failed", message: "provider down" });

  assert.equal(normalizeResponsesEvent({ type: "response.created", data: {} }).kind, "other");
});
