import { EventEmitter } from "node:events";
import { existsSync, watch, type FSWatcher } from "node:fs";
import type {
  CancellationReason,
  LogChunk,
  TaskMeta,
  TaskPaths,
  TaskResult,
  TaskStatus,
  TaskSummary,
  WaitResult,
} from "./types.js";
import { isTerminalStatus, TASK_SCHEMA_VERSION } from "./types.js";
import { TaskStore } from "./persistence.js";
import { TmuxBackend } from "./tmux.js";
import { abortError, assertTaskId, delay, durationMs, newTaskId, sessionName, socketName } from "./utils.js";
import { readLogChunk, stripAnsi } from "./logs.js";

export interface StartTaskInput {
  command: string;
  name?: string;
  cwd: string;
  timeoutSeconds?: number;
  notifyOnCompletion?: boolean;
}

export interface SendTaskInput {
  text?: string;
  enter?: boolean;
  key?: "Ctrl+C" | "Ctrl+D" | "Ctrl+Z" | "Escape" | "Up" | "Down" | "Left" | "Right";
}

export class TaskRegistry extends EventEmitter {
  readonly store: TaskStore;
  readonly backend: TmuxBackend;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timeoutTimers = new Map<string, NodeJS.Timeout>();
  private readonly seenCompletions = new Set<string>();
  private readonly activeWaiters = new Map<string, number>();
  private readonly locallyStartedTaskIds = new Set<string>();
  private reconciliationTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(
    readonly projectCwd: string,
    readonly instanceId: string,
    private readonly runnerPath: string,
    readonly piSessionId?: string,
    private readonly visibleTaskIds?: () => ReadonlySet<string>,
  ) {
    super();
    this.store = new TaskStore(projectCwd, instanceId);
    this.backend = new TmuxBackend(socketName(instanceId), runnerPath);
  }

  async initialize(): Promise<void> {
    await this.backend.assertAvailable();
    await this.store.initialize();
    for (const taskId of await this.store.listOwnTaskIds()) {
      this.watchTask(taskId);
      await this.restoreTimeout(taskId);
    }
    await this.reconcile();
    this.reconciliationTimer = setInterval(() => void this.reconcile(), 1_000);
    this.reconciliationTimer.unref();
  }

  async start(input: StartTaskInput): Promise<TaskSummary> {
    this.assertActive();
    if (!input.command.trim()) throw new Error("command must not be empty");
    const taskId = newTaskId();
    const createdAt = new Date().toISOString();
    const meta: TaskMeta = {
      schemaVersion: TASK_SCHEMA_VERSION,
      taskId,
      ownerInstanceId: this.instanceId,
      visibilityScope: "session-tree",
      sessionName: sessionName(taskId),
      socketName: this.backend.socketName,
      name: input.name?.trim() || input.command.trim().slice(0, 80),
      command: input.command,
      cwd: input.cwd,
      shell: process.env.SHELL || "/bin/sh",
      status: "starting",
      createdAt,
      ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
      notifyOnCompletion: input.notifyOnCompletion ?? true,
    };
    const paths = await this.store.createTask(meta);
    try {
      await this.backend.start(meta, paths);
      await this.store.signalStart(paths);
      const startedAt = new Date().toISOString();
      await this.store.updateMeta(paths, (current) => ({ ...current, status: "running", startedAt }));
      this.watchTask(taskId);
      this.scheduleTimeout(taskId, startedAt, input.timeoutSeconds);
      this.locallyStartedTaskIds.add(taskId);
      const summary = await this.get(taskId);
      this.emit("changed", summary);
      return summary;
    } catch (error) {
      await this.backend.kill(meta.sessionName).catch(() => undefined);
      await this.store.writeResult(paths, {
        schemaVersion: TASK_SCHEMA_VERSION,
        taskId,
        status: "failed",
        exitCode: null,
        signal: null,
        endedAt: new Date().toISOString(),
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async get(taskId: string): Promise<TaskSummary> {
    assertTaskId(taskId);
    const ref = await this.store.findTask(taskId);
    if (!ref) throw new Error(`Task not found: ${taskId}`);
    const meta = await this.store.readMeta(ref.paths);
    if (!meta) throw new Error(`Task metadata is missing: ${taskId}`);
    const result = await this.store.readResult(ref.paths);
    const owned = meta.ownerInstanceId === this.instanceId;
    let status: TaskStatus = result?.status ?? meta.status;
    if (!result) {
      if (!owned) status = "unknown";
      else if (!(await this.backendFor(meta).hasSession(meta.sessionName))) {
        const interrupted: TaskResult = {
          schemaVersion: TASK_SCHEMA_VERSION,
          taskId,
          status: "interrupted",
          exitCode: null,
          signal: null,
          ...(meta.startedAt ? { startedAt: meta.startedAt } : {}),
          endedAt: new Date().toISOString(),
          reason: "tmux session disappeared without a result",
        };
        await this.store.writeResult(ref.paths, interrupted);
        status = "interrupted";
      }
    }
    const finalResult = result ?? (await this.store.readResult(ref.paths));
    const start = finalResult?.startedAt ?? meta.startedAt ?? meta.createdAt;
    const end = finalResult?.endedAt;
    return {
      taskId,
      name: meta.name,
      command: meta.command,
      cwd: meta.cwd,
      status: finalResult?.status ?? status,
      createdAt: meta.createdAt,
      ...(meta.startedAt ? { startedAt: meta.startedAt } : {}),
      ...(end ? { endedAt: end } : {}),
      durationMs: durationMs(start, end),
      exitCode: finalResult?.exitCode ?? null,
      signal: finalResult?.signal ?? null,
      ownerInstanceId: meta.ownerInstanceId,
      ...(meta.piSessionId ? { piSessionId: meta.piSessionId } : {}),
      ...(meta.piSessionName ? { piSessionName: meta.piSessionName } : {}),
      socketName: meta.socketName,
      ownedByCurrentInstance: owned,
      sessionName: meta.sessionName,
      logPath: ref.paths.log,
      ...(owned && !finalResult ? { attachCommand: this.backendFor(meta).attachCommand(meta.sessionName) } : {}),
      ...(finalResult?.reason ? { reason: finalResult.reason } : {}),
    };
  }

  async list(scope: "instance" | "session" | "all" = "session"): Promise<TaskSummary[]> {
    const refs = scope === "instance"
      ? (await this.store.listOwnTaskIds()).map((taskId) => ({ taskId }))
      : await this.store.listAllTaskRefs();
    const summaries = await Promise.all(refs.map(async ({ taskId }) => {
      const task = await this.get(taskId).catch(() => undefined);
      if (!task || scope !== "session") return task;
      const meta = await this.store.readMeta((await this.store.findTask(task.taskId))!.paths);
      if (meta?.visibilityScope === "session-tree" && this.visibleTaskIds) {
        return this.isVisibleInCurrentBranch(task.taskId) ? task : undefined;
      }
      // Records created before branch-aware metadata are kept visible by their
      // former session-wide scope instead of becoming unreachable after upgrade.
      return !task.piSessionId || task.piSessionId === this.piSessionId ? task : undefined;
    }));
    return summaries
      .filter((task): task is TaskSummary => task !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async logs(taskId: string, offset = 0, limitBytes = 16 * 1024, strip = true): Promise<LogChunk> {
    const ref = await this.resolve(taskId);
    return readLogChunk(taskId, ref.paths.log, offset, limitBytes, strip);
  }

  async screen(taskId: string, lines = 200, strip = true): Promise<LogChunk> {
    const { meta, owned } = await this.resolve(taskId);
    if (!owned) throw new Error("Live screen capture is only allowed for tasks owned by this Pi instance");
    const backend = this.backendFor(meta);
    if (!(await backend.hasSession(meta.sessionName))) throw new Error(`Task is not running: ${taskId}`);
    const raw = await backend.capturePane(meta.sessionName, lines);
    return {
      taskId,
      source: "screen",
      text: strip ? stripAnsi(raw) : raw,
      offset: 0,
      nextOffset: Buffer.byteLength(raw),
      endOfLog: true,
      truncated: false,
    };
  }

  async send(taskId: string, input: SendTaskInput): Promise<TaskSummary> {
    const { meta, owned } = await this.resolve(taskId);
    if (!owned) throw new Error("Cannot send input to a task owned by another Pi instance");
    const summary = await this.get(taskId);
    if (isTerminalStatus(summary.status) || summary.status === "unknown") throw new Error(`Task is not running: ${taskId}`);
    if (input.text === undefined && !input.enter && !input.key) throw new Error("Provide text, enter, or key");
    const backend = this.backendFor(meta);
    if (input.text !== undefined) await backend.sendLiteral(meta.sessionName, input.text);
    if (input.key) await backend.sendKey(meta.sessionName, KEY_MAP[input.key]);
    if (input.enter) await backend.sendKey(meta.sessionName, "Enter");
    return this.get(taskId);
  }

  async terminate(taskId: string, reason: CancellationReason = "cancelled", force = false): Promise<TaskSummary> {
    const { meta, paths, owned } = await this.resolve(taskId);
    if (!owned) throw new Error("Cannot terminate a task owned by another Pi instance");
    const current = await this.get(taskId);
    if (isTerminalStatus(current.status)) return current;
    await this.store.writeCancellation(paths, { reason, requestedAt: new Date().toISOString() });
    const backend = this.backendFor(meta);
    if (!force && (await backend.hasSession(meta.sessionName))) {
      await backend.sendKey(meta.sessionName, "C-c").catch(() => undefined);
      const ended = await this.waitForResult(paths, 1_500);
      if (ended) {
        if (reason === "cancelled") await this.markNotified([taskId]);
        return this.get(taskId);
      }
    }
    await backend.kill(meta.sessionName).catch(() => undefined);
    await delay(50);
    const result = await this.store.readResult(paths);
    if (!result) {
      await this.store.writeResult(paths, {
        schemaVersion: TASK_SCHEMA_VERSION,
        taskId,
        status: reason === "timed_out" ? "timed_out" : "cancelled",
        exitCode: null,
        signal: force ? "SIGKILL" : "SIGHUP",
        ...(meta.startedAt ? { startedAt: meta.startedAt } : {}),
        endedAt: new Date().toISOString(),
        reason,
      });
    }
    await this.processCompletion(taskId);
    if (reason === "cancelled") await this.markNotified([taskId]);
    return this.get(taskId);
  }

  async wait(taskIds: string[], mode: "any" | "all", timeoutSeconds: number | undefined, signal?: AbortSignal): Promise<WaitResult> {
    const unique = [...new Set(taskIds)];
    if (unique.length === 0) throw new Error("taskIds must not be empty");
    for (const taskId of unique) {
      const summary = await this.get(taskId);
      if (!summary.ownedByCurrentInstance && !isTerminalStatus(summary.status)) {
        throw new Error(`Cannot wait for non-terminal task owned by another Pi instance: ${taskId}`);
      }
      this.activeWaiters.set(taskId, (this.activeWaiters.get(taskId) ?? 0) + 1);
    }
    try {
      const deadline = timeoutSeconds === undefined ? undefined : Date.now() + timeoutSeconds * 1_000;
      while (true) {
        if (signal?.aborted) throw abortError();
        const summaries = await Promise.all(unique.map((taskId) => this.get(taskId)));
        const completed = summaries.filter((task) => isTerminalStatus(task.status));
        const satisfied = mode === "all" ? completed.length === unique.length : completed.length > 0;
        if (satisfied) {
          await this.markNotified(completed.map((task) => task.taskId));
          return { mode, completed, pending: summaries.filter((task) => !isTerminalStatus(task.status)).map((task) => task.taskId), timedOut: false };
        }
        if (deadline !== undefined && Date.now() >= deadline) {
          await this.markNotified(completed.map((task) => task.taskId));
          return { mode, completed, pending: summaries.filter((task) => !isTerminalStatus(task.status)).map((task) => task.taskId), timedOut: true };
        }
        await this.waitForCompletionEvent(Math.min(1_000, deadline === undefined ? 1_000 : Math.max(1, deadline - Date.now())), signal);
      }
    } finally {
      for (const taskId of unique) {
        const count = (this.activeWaiters.get(taskId) ?? 1) - 1;
        if (count <= 0) this.activeWaiters.delete(taskId);
        else this.activeWaiters.set(taskId, count);
      }
    }
  }

  async markNotified(taskIds: string[]): Promise<void> {
    const notifiedAt = new Date().toISOString();
    await Promise.all(taskIds.map(async (taskId) => {
      const ref = await this.store.findTask(taskId);
      if (!ref || ref.instanceId !== this.instanceId) return;
      await this.store.updateMeta(ref.paths, (meta) => ({ ...meta, notifiedAt }));
    }));
  }

  async shouldNotify(taskId: string): Promise<boolean> {
    if (this.isActivelyWaited(taskId)) return false;
    const ref = await this.store.findTask(taskId);
    if (!ref || ref.instanceId !== this.instanceId) return false;
    const meta = await this.store.readMeta(ref.paths);
    if (meta?.visibilityScope === "session-tree" && this.visibleTaskIds && !this.isVisibleInCurrentBranch(taskId)) return false;
    return meta?.notifyOnCompletion === true && meta.notifiedAt === undefined;
  }

  async visiblePendingCompletions(): Promise<TaskSummary[]> {
    const tasks = await this.list("session");
    const pending: TaskSummary[] = [];
    for (const task of tasks) {
      if (isTerminalStatus(task.status) && await this.shouldNotify(task.taskId)) pending.push(task);
    }
    return pending;
  }

  isActivelyWaited(taskId: string): boolean {
    return (this.activeWaiters.get(taskId) ?? 0) > 0;
  }

  refreshBranchScope(): void {
    // Successful task_start results have been persisted by the time Pi emits a
    // tree-navigation event, so visibility can now come solely from the branch.
    this.locallyStartedTaskIds.clear();
    this.emit("changed");
  }

  async clearFinished(): Promise<number> {
    let removed = 0;
    for (const task of await this.list("session")) {
      if (!isTerminalStatus(task.status)) continue;
      this.watchers.get(task.taskId)?.close();
      this.watchers.delete(task.taskId);
      const timer = this.timeoutTimers.get(task.taskId);
      if (timer) clearTimeout(timer);
      this.timeoutTimers.delete(task.taskId);
      await this.store.removeTask(task.taskId);
      removed += 1;
    }
    return removed;
  }

  async shutdown(terminateTasks: boolean): Promise<void> {
    if (terminateTasks) {
      const tasks = await this.list("instance");
      await Promise.all(tasks.filter((task) => !isTerminalStatus(task.status)).map((task) => this.terminate(task.taskId, "quit").catch(() => undefined)));
    }
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    for (const watcher of this.watchers.values()) watcher.close();
    for (const timer of this.timeoutTimers.values()) clearTimeout(timer);
    this.watchers.clear();
    this.timeoutTimers.clear();
    this.removeAllListeners();
  }

  private async resolve(taskId: string): Promise<{ meta: TaskMeta; paths: TaskPaths; owned: boolean }> {
    assertTaskId(taskId);
    const ref = await this.store.findTask(taskId);
    if (!ref) throw new Error(`Task not found: ${taskId}`);
    const meta = await this.store.readMeta(ref.paths);
    if (!meta) throw new Error(`Task metadata is missing: ${taskId}`);
    return { meta, paths: ref.paths, owned: meta.ownerInstanceId === this.instanceId };
  }

  private backendFor(meta: TaskMeta): TmuxBackend {
    return meta.socketName === this.backend.socketName
      ? this.backend
      : new TmuxBackend(meta.socketName, this.runnerPath);
  }

  private isVisibleInCurrentBranch(taskId: string): boolean {
    return this.locallyStartedTaskIds.has(taskId) || this.visibleTaskIds?.().has(taskId) === true;
  }

  private watchTask(taskId: string): void {
    if (this.watchers.has(taskId)) return;
    const paths = this.store.ownPaths(taskId);
    try {
      const watcher = watch(paths.dir, (_event, filename) => {
        if (filename === "result.json") void this.processCompletion(taskId);
      });
      watcher.on("error", () => {
        watcher.close();
        this.watchers.delete(taskId);
      });
      this.watchers.set(taskId, watcher);
    } catch {
      // The reconciliation timer remains the reliability fallback.
    }
  }

  private async reconcile(): Promise<void> {
    if (this.disposed) return;
    for (const taskId of await this.store.listOwnTaskIds()) {
      this.watchTask(taskId);
      const paths = this.store.ownPaths(taskId);
      if (existsSync(paths.result)) await this.processCompletion(taskId);
      else await this.get(taskId).catch(() => undefined);
    }
  }

  private async processCompletion(taskId: string): Promise<void> {
    const paths = this.store.ownPaths(taskId);
    const result = await this.store.readResult(paths);
    if (!result || this.seenCompletions.has(taskId)) return;
    this.seenCompletions.add(taskId);
    const timer = this.timeoutTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.timeoutTimers.delete(taskId);
    const summary = await this.get(taskId);
    this.emit("completion", summary);
    this.emit("changed", summary);
  }

  private scheduleTimeout(taskId: string, startedAt: string, timeoutSeconds: number | undefined): void {
    if (timeoutSeconds === undefined) return;
    const remaining = Date.parse(startedAt) + timeoutSeconds * 1_000 - Date.now();
    const timer = setTimeout(() => void this.terminate(taskId, "timed_out").catch(() => undefined), Math.max(0, remaining));
    timer.unref();
    this.timeoutTimers.set(taskId, timer);
  }

  private async restoreTimeout(taskId: string): Promise<void> {
    const paths = this.store.ownPaths(taskId);
    const meta = await this.store.readMeta(paths);
    const result = await this.store.readResult(paths);
    if (meta?.timeoutSeconds !== undefined && meta.startedAt && !result) this.scheduleTimeout(taskId, meta.startedAt, meta.timeoutSeconds);
  }

  private waitForCompletionEvent(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const done = () => {
        cleanup();
        resolvePromise();
      };
      const aborted = () => {
        cleanup();
        reject(abortError());
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("completion", done);
        signal?.removeEventListener("abort", aborted);
      };
      const timer = setTimeout(done, timeoutMs);
      this.once("completion", done);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  private async waitForResult(paths: TaskPaths, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(paths.result)) return true;
      await delay(30);
    }
    return existsSync(paths.result);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Task registry has been disposed");
  }
}

const KEY_MAP: Record<NonNullable<SendTaskInput["key"]>, string> = {
  "Ctrl+C": "C-c",
  "Ctrl+D": "C-d",
  "Ctrl+Z": "C-z",
  Escape: "Escape",
  Up: "Up",
  Down: "Down",
  Left: "Left",
  Right: "Right",
};
