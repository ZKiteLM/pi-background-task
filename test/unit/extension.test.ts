import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { branchTaskIds } from "../../src/index.js";

test("extension factory registers the complete public surface without starting resources", () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const pi = {
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand: (name: string) => commands.push(name),
    registerMessageRenderer: () => undefined,
    registerEntryRenderer: () => undefined,
    on: (event: string) => events.push(event),
  } as unknown as ExtensionAPI;

  extension(pi);

  assert.deepEqual(tools, ["task_start", "task_status", "task_logs", "task_send", "task_wait", "task_kill"]);
  assert.deepEqual(commands, ["bg-tasks", "bg-attach", "bg-clear"]);
  assert.deepEqual(events, ["session_start", "session_tree", "session_shutdown"]);
});

test("task visibility follows task_start results on the active session branch", () => {
  const ids = branchTaskIds({
    getBranch: () => [
      { type: "message", message: { role: "toolResult", toolName: "task_start", details: { taskId: "bg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", socketName: "internal" } } },
      { type: "message", message: { role: "toolResult", toolName: "task_wait", details: { completed: [{ taskId: "bg_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }] } } },
      { type: "custom", message: undefined },
    ],
  });
  assert.deepEqual([...ids], ["bg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
});
