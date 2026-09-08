import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const TASK_ID_PATTERN = /^bg_[0-9a-f]{32}$/;

export function newTaskId(): string {
  return `bg_${randomUUID().replaceAll("-", "")}`;
}

export function newInstanceId(): string {
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, "").replace("Z", "");
  const suffix = randomUUID().replaceAll("-", "").slice(0, 6);
  return `run_${timestamp}_p${process.pid}_${suffix}`;
}

export function assertTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`Invalid taskId: ${taskId}`);
}

export function socketName(instanceId: string): string {
  const safe = instanceId.replaceAll(/[^a-zA-Z0-9_-]/g, "-").slice(0, 56);
  return `pi-bg-${safe}`;
}

export function sessionName(taskId: string): string {
  assertTaskId(taskId);
  return `pi-${taskId}`;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function resolveWorkingDirectory(input: string | undefined, fallback: string): Promise<string> {
  const path = input ? (isAbsolute(input) ? input : resolve(fallback, input)) : fallback;
  const stat = await lstat(path).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`Working directory does not exist or is not a directory: ${path}`);
  await access(path, fsConstants.R_OK | fsConstants.X_OK);
  return path;
}

export function durationMs(start: string, end = new Date().toISOString()): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

export function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
