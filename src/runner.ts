import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { CancellationRequest, TaskMeta, TaskResult } from "./types.js";

const taskDir = process.argv[2];
if (!taskDir) throw new Error("Task directory argument is required");

const metaPath = join(taskDir, "meta.json");
const resultPath = join(taskDir, "result.json");
const gatePath = join(taskDir, "start.signal");
const cancelPath = join(taskDir, "cancel.json");

const meta = JSON.parse(readFileSync(metaPath, "utf8")) as TaskMeta;
await waitForGate(gatePath, 10_000);
const startedAt = new Date().toISOString();
let child: ChildProcess | undefined;
let finalized = false;

function cancellation(): CancellationRequest | undefined {
  try {
    return JSON.parse(readFileSync(cancelPath, "utf8")) as CancellationRequest;
  } catch {
    return undefined;
  }
}

function finalize(exitCode: number | null, signal: NodeJS.Signals | null, fallbackReason?: string): void {
  if (finalized || existsSync(resultPath)) return;
  finalized = true;
  const cancel = cancellation();
  const status = cancel
    ? cancel.reason === "timed_out"
      ? "timed_out"
      : "cancelled"
    : fallbackReason === "runner terminated"
      ? "interrupted"
    : exitCode === 0
      ? "completed"
      : "failed";
  const reason = cancel?.reason ?? fallbackReason;
  const result: TaskResult = {
    schemaVersion: 1,
    taskId: meta.taskId,
    status,
    exitCode,
    signal,
    startedAt,
    endedAt: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  };
  const temp = `${resultPath}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    linkSync(temp, resultPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temp);
  }
}

for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    finalize(null, signal, "runner terminated");
    if (child && !child.killed) child.kill(signal);
    process.exit(128);
  });
}

// The command shares tmux's foreground process group, so terminal Ctrl+C reaches
// both runner and command. Keeping the runner alive lets it persist the result.
process.on("SIGINT", () => undefined);

try {
  child = spawn(meta.shell, ["-lc", meta.command], {
    cwd: meta.cwd,
    env: process.env,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    finalize(null, null, error.message);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    finalize(code, signal);
    process.exitCode = code ?? (signal ? 128 : 1);
  });
} catch (error) {
  finalize(null, null, error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function waitForGate(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for start signal");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
