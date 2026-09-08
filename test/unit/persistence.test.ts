import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskStore } from "../../src/persistence.js";
import type { TaskMeta } from "../../src/types.js";

test("task metadata is stored atomically with private permissions", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-bg-store-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const instanceId = "instance_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const taskId = "bg_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const store = new TaskStore(cwd, instanceId);
  await store.initialize();
  await assert.rejects(() => stat(store.instanceRoot), { code: "ENOENT" });
  const meta: TaskMeta = {
    schemaVersion: 1,
    taskId,
    ownerInstanceId: instanceId,
    sessionName: `pi-${taskId}`,
    socketName: "pi-bg-test",
    name: "test",
    command: "true",
    cwd,
    shell: "/bin/sh",
    status: "starting",
    createdAt: new Date().toISOString(),
    notifyOnCompletion: true,
  };
  const paths = await store.createTask(meta);
  assert.deepEqual(await store.readMeta(paths), meta);
  assert.equal((await stat(paths.meta)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.dir)).mode & 0o777, 0o700);
  assert.equal(await readFile(paths.log, "utf8"), "");
  assert.equal((await store.listAllTaskRefs())[0]?.taskId, taskId);
  await store.removeTask(taskId);
  await assert.rejects(() => stat(store.instanceRoot), { code: "ENOENT" });
});
