import { existsSync, linkSync, unlinkSync } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CancellationRequest, TaskMeta, TaskPaths, TaskResult } from "./types.js";

export class TaskStore {
  readonly root: string;
  readonly instancesRoot: string;
  readonly instanceRoot: string;

  constructor(projectCwd: string, readonly instanceId: string) {
    this.root = join(projectCwd, ".pi", "background-tasks");
    this.instancesRoot = join(this.root, "instances");
    this.instanceRoot = join(this.instancesRoot, instanceId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.instancesRoot, { recursive: true, mode: 0o700 });
    await chmod(this.instancesRoot, 0o700).catch(() => undefined);
  }

  paths(instanceId: string, taskId: string): TaskPaths {
    const dir = join(this.instancesRoot, instanceId, taskId);
    return {
      dir,
      meta: join(dir, "meta.json"),
      log: join(dir, "output.log"),
      result: join(dir, "result.json"),
      gate: join(dir, "start.signal"),
      cancel: join(dir, "cancel.json"),
    };
  }

  ownPaths(taskId: string): TaskPaths {
    return this.paths(this.instanceId, taskId);
  }

  async createTask(meta: TaskMeta): Promise<TaskPaths> {
    const paths = this.ownPaths(meta.taskId);
    await mkdir(this.instanceRoot, { recursive: true, mode: 0o700 });
    await chmod(this.instanceRoot, 0o700).catch(() => undefined);
    await mkdir(paths.dir, { recursive: false, mode: 0o700 });
    await this.writeJson(paths.meta, meta);
    const handle = await open(paths.log, "wx", 0o600);
    await handle.close();
    return paths;
  }

  async readMeta(paths: TaskPaths): Promise<TaskMeta | undefined> {
    return readJson<TaskMeta>(paths.meta);
  }

  async readResult(paths: TaskPaths): Promise<TaskResult | undefined> {
    return readJson<TaskResult>(paths.result);
  }

  async updateMeta(paths: TaskPaths, update: (meta: TaskMeta) => TaskMeta): Promise<TaskMeta> {
    const current = await this.readMeta(paths);
    if (!current) throw new Error(`Missing task metadata: ${paths.meta}`);
    const next = update(current);
    await this.writeJson(paths.meta, next);
    return next;
  }

  async writeResult(paths: TaskPaths, result: TaskResult): Promise<void> {
    if (existsSync(paths.result)) return;
    await this.writeJsonExclusive(paths.result, result);
  }

  async writeCancellation(paths: TaskPaths, request: CancellationRequest): Promise<void> {
    if (!existsSync(paths.cancel)) await this.writeJsonExclusive(paths.cancel, request);
  }

  async signalStart(paths: TaskPaths): Promise<void> {
    await writeFile(paths.gate, "start\n", { mode: 0o600, flag: "wx" });
  }

  async findTask(taskId: string): Promise<{ instanceId: string; paths: TaskPaths } | undefined> {
    for (const instanceId of await listDirectories(this.instancesRoot)) {
      const paths = this.paths(instanceId, taskId);
      if (existsSync(paths.meta)) return { instanceId, paths };
    }
    return undefined;
  }

  async listOwnTaskIds(): Promise<string[]> {
    return listDirectories(this.instanceRoot);
  }

  async listAllTaskRefs(): Promise<Array<{ instanceId: string; taskId: string; paths: TaskPaths }>> {
    const refs: Array<{ instanceId: string; taskId: string; paths: TaskPaths }> = [];
    for (const instanceId of await listDirectories(this.instancesRoot)) {
      for (const taskId of await listDirectories(join(this.instancesRoot, instanceId))) {
        refs.push({ instanceId, taskId, paths: this.paths(instanceId, taskId) });
      }
    }
    return refs;
  }

  async removeTask(taskId: string): Promise<void> {
    const ref = await this.findTask(taskId);
    if (!ref) return;
    await rm(ref.paths.dir, { recursive: true, force: true });
    // Avoid accumulating one empty directory for every previous Pi process.
    await rmdir(dirname(ref.paths.dir)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
    });
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
    await chmod(path, 0o600).catch(() => undefined);
  }

  private async writeJsonExclusive(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try {
      linkSync(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      unlinkSync(temp);
    }
  }
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function listDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
