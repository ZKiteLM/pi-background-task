import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CompletionNotifier } from "../../src/notifier.js";
import type { TaskRegistry } from "../../src/registry.js";
import type { TaskSummary } from "../../src/types.js";

class FakeRegistry extends EventEmitter {
  notified: string[] = [];
  eligible = true;
  async shouldNotify(): Promise<boolean> { return this.eligible; }
  async markNotified(ids: string[]): Promise<void> { this.notified.push(...ids); }
}

function summary(taskId: string): TaskSummary {
  return {
    taskId,
    name: taskId,
    command: "true",
    cwd: "/tmp",
    status: "completed",
    createdAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 10,
    exitCode: 0,
    signal: null,
    ownerInstanceId: "instance",
    socketName: "pi-bg-instance",
    ownedByCurrentInstance: true,
    sessionName: taskId,
    logPath: "/tmp/output.log",
  };
}

test("completion notifications are batched and marked once", async () => {
  const registry = new FakeRegistry();
  const messages: unknown[] = [];
  const pi = { sendMessage: (...args: unknown[]) => messages.push(args) } as unknown as ExtensionAPI;
  const notifier = new CompletionNotifier(pi, registry as unknown as TaskRegistry);
  registry.emit("completion", summary("a"));
  registry.emit("completion", summary("b"));
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(messages.length, 1);
  assert.deepEqual(registry.notified, ["a", "b"]);
  notifier.dispose();
});

test("ineligible completions do not trigger an agent turn", async () => {
  const registry = new FakeRegistry();
  registry.eligible = false;
  const messages: unknown[] = [];
  const pi = { sendMessage: (...args: unknown[]) => messages.push(args) } as unknown as ExtensionAPI;
  const notifier = new CompletionNotifier(pi, registry as unknown as TaskRegistry);
  registry.emit("completion", summary("a"));
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(messages.length, 0);
  notifier.dispose();
});
