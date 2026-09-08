import assert from "node:assert/strict";
import test from "node:test";
import { taskListText, waitResultText } from "../../src/tools.js";

test("task list context omits internal task details", () => {
  const text = taskListText([{ taskId: "bg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", status: "running", name: "build", exitCode: null }]);
  assert.equal(text, "bg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: running (build)");
  assert.doesNotMatch(text, /owner|socket|logPath|cwd|command/);
});

test("wait context reports outcomes without serializing details", () => {
  const text = waitResultText({
    completed: [{ taskId: "bg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", status: "completed", name: "build", exitCode: 0 }],
    pending: ["bg_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    timedOut: true,
  });
  assert.match(text, /bg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: completed, exit 0/);
  assert.match(text, /Pending: bg_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
  assert.match(text, /still running/);
  assert.doesNotMatch(text, /name|durationMs|logPath|ownerInstanceId/);
});
