import assert from "node:assert/strict";
import test from "node:test";
import { assertTaskId, formatDuration, newInstanceId, newTaskId, sessionName, shellQuote, socketName } from "../../src/utils.js";

test("task IDs and derived tmux names are constrained", () => {
  const id = newTaskId();
  assert.match(id, /^bg_[0-9a-f]{32}$/);
  assert.doesNotThrow(() => assertTaskId(id));
  assert.equal(sessionName(id), `pi-${id}`);
  assert.match(newInstanceId(), /^run_\d{8}T\d{9}_p\d+_[0-9a-f]{6}$/);
  assert.equal(socketName("run_20260908T123456789_p123_ab12cd"), "pi-bg-run_20260908T123456789_p123_ab12cd");
  assert.throws(() => assertTaskId("../../unsafe"), /Invalid taskId/);
});

test("shellQuote safely represents single quotes", () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("formatDuration keeps task rows compact", () => {
  assert.equal(formatDuration(500), "500ms");
  assert.equal(formatDuration(65_000), "1m 5s");
  assert.equal(formatDuration(3_661_000), "1h 1m");
});
