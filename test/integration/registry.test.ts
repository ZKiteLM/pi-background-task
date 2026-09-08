import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";
import { TaskRegistry } from "../../src/registry.js";
import { newInstanceId } from "../../src/utils.js";

const enabled = process.env.PI_BG_INTEGRATION === "1" && hasTmux();
const integration = (name: string, fn: (t: test.TestContext) => Promise<void>) => test(name, { skip: !enabled }, fn);
const runner = resolve("dist/runner.js");

integration("start, wait, exit status, and complete log capture", async (t) => {
  const { cwd, registry } = await setup(t);
  const task = await registry.start({ cwd, command: "printf 'first\\n'; sleep 0.1; printf 'last\\n'", name: "capture" });
  assert.equal(task.status, "running");
  const result = await registry.wait([task.taskId], "all", 5);
  assert.equal(result.timedOut, false);
  assert.equal(result.completed[0]?.status, "completed");
  assert.ok((await registry.store.readMeta(registry.store.ownPaths(task.taskId)))?.notifiedAt);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  assert.match((await registry.logs(task.taskId)).text, /first\nlast\n/);
});

integration("literal input and Enter reach an interactive process", async (t) => {
  const { cwd, registry } = await setup(t);
  const task = await registry.start({ cwd, command: "IFS= read -r line; printf 'got:%s\\n' \"$line\"", name: "input" });
  await registry.send(task.taskId, { text: "hello $HOME; literal", enter: true });
  const result = await registry.wait([task.taskId], "all", 5);
  assert.equal(result.completed[0]?.status, "completed");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  assert.match((await registry.logs(task.taskId)).text, /got:hello \$HOME; literal/);
});

integration("wait timeout leaves task running and runtime timeout stops it", async (t) => {
  const { cwd, registry } = await setup(t);
  const waiting = await registry.start({ cwd, command: "sleep 10", name: "wait-only" });
  const waitResult = await registry.wait([waiting.taskId], "all", 1);
  assert.equal(waitResult.timedOut, true);
  assert.equal((await registry.get(waiting.taskId)).status, "running");
  await registry.terminate(waiting.taskId, "cancelled", true);

  const timed = await registry.start({ cwd, command: "sleep 10", timeoutSeconds: 1, name: "runtime-timeout" });
  const timedResult = await registry.wait([timed.taskId], "all", 5);
  assert.equal(timedResult.completed[0]?.status, "timed_out");
});

integration("instance ownership blocks control but permits historical reads", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-bg-integration-"));
  const first = new TaskRegistry(cwd, newInstanceId(), runner);
  const second = new TaskRegistry(cwd, newInstanceId(), runner);
  t.after(async () => {
    await first.shutdown(true).catch(() => undefined);
    await second.shutdown(true).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  });
  await first.initialize();
  await second.initialize();
  const task = await first.start({ cwd, command: "sleep 10", name: "owned" });
  const seen = await second.get(task.taskId);
  assert.equal(seen.ownedByCurrentInstance, false);
  assert.equal(seen.status, "unknown");
  await assert.rejects(() => second.send(task.taskId, { text: "x" }), /another Pi instance/);
  await assert.rejects(() => second.terminate(task.taskId), /another Pi instance/);
});

integration("registry can reload with the same instance ID", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-bg-integration-"));
  const instanceId = newInstanceId();
  const first = new TaskRegistry(cwd, instanceId, runner);
  await first.initialize();
  const task = await first.start({ cwd, command: "sleep 0.2; printf 'restored\\n'", name: "reload" });
  first.dispose();
  const restored = new TaskRegistry(cwd, instanceId, runner);
  t.after(async () => {
    await restored.shutdown(true).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  });
  await restored.initialize();
  const result = await restored.wait([task.taskId], "all", 5);
  assert.equal(result.completed[0]?.status, "completed");
});

integration("session branch references control visibility without stopping tasks", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-bg-integration-"));
  const visible = new Set<string>();
  const registry = new TaskRegistry(cwd, newInstanceId(), runner, "branch-session", () => visible);
  t.after(async () => {
    await registry.shutdown(true).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  });
  await registry.initialize();
  const task = await registry.start({ cwd, command: "sleep 10", name: "branch-owned" });

  // The just-started task stays visible until its tool result is persisted.
  assert.deepEqual((await registry.list("session")).map(({ taskId }) => taskId), [task.taskId]);
  registry.refreshBranchScope();
  assert.equal((await registry.list("session")).length, 0);
  assert.equal((await registry.get(task.taskId)).status, "running");

  visible.add(task.taskId);
  assert.deepEqual((await registry.list("session")).map(({ taskId }) => taskId), [task.taskId]);
});

integration("resumed Pi session can see history from an earlier process owner", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-bg-integration-"));
  const piSessionId = "session-resume-test";
  const first = new TaskRegistry(cwd, newInstanceId(), runner, piSessionId);
  await first.initialize();
  const task = await first.start({ cwd, command: "printf 'persisted\\n'", name: "history" });
  await first.wait([task.taskId], "all", 5);
  first.dispose();

  const resumed = new TaskRegistry(cwd, newInstanceId(), runner, piSessionId);
  t.after(async () => {
    await resumed.shutdown(true).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  });
  await resumed.initialize();
  const history = await resumed.list("session");
  assert.equal(history.length, 1);
  assert.equal(history[0]?.taskId, task.taskId);
  assert.equal(history[0]?.status, "completed");
  assert.equal(history[0]?.ownedByCurrentInstance, false);
  assert.equal(await resumed.clearFinished(), 1);
  await assert.rejects(() => resumed.get(task.taskId), /Task not found/);
});

async function setup(t: test.TestContext): Promise<{ cwd: string; registry: TaskRegistry }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-bg-integration-"));
  const registry = new TaskRegistry(cwd, newInstanceId(), runner);
  t.after(async () => {
    await registry.shutdown(true).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  });
  await registry.initialize();
  return { cwd, registry };
}

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
