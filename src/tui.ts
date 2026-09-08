import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TaskRegistry } from "./registry.js";
import type { TaskStatus, TaskSummary } from "./types.js";
import { formatDuration } from "./utils.js";

export interface CommandOutputEntry {
  title: string;
  body: string;
  timestamp: number;
}

export function renderToolResult(summary: TaskSummary, theme: Theme, expanded: boolean): Text {
  const state = colorStatus(theme, summary.status, statusLabel(summary.status));
  let text = `${state} ${theme.fg("accent", summary.taskId)} ${theme.fg("muted", summary.name)}`;
  if (expanded) {
    text += `\n${theme.fg("dim", `cwd: ${summary.cwd}`)}`;
    text += `\n${theme.fg("dim", `runtime: ${formatDuration(summary.durationMs)}`)}`;
    if (summary.exitCode !== null) text += `\n${theme.fg("dim", `exit: ${summary.exitCode}`)}`;
    text += `\n${theme.fg("dim", `log: ${summary.logPath}`)}`;
  }
  return new Text(text, 0, 0);
}

export class TaskDashboard {
  private tasks: TaskSummary[] = [];
  private selected = 0;
  private expanded = false;
  private latestLog = "";
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private autoRefreshTimer: NodeJS.Timeout | undefined;
  private refreshInFlight = false;
  private refreshQueued = false;
  private detailsInFlight = false;
  private disposed = false;
  private readonly onRegistryChanged = () => void this.refresh();

  constructor(
    private readonly registry: TaskRegistry,
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly onClose: () => void,
    private readonly includeHistory: boolean,
  ) {}

  async initialize(): Promise<void> {
    this.registry.on("changed", this.onRegistryChanged);
    await this.refresh();
    this.autoRefreshTimer = setInterval(() => void this.tick(), 1_000);
    this.autoRefreshTimer.unref();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
      this.dispose();
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selected = Math.max(0, this.selected - 1);
      void this.updateDetails();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selected = Math.min(Math.max(0, this.tasks.length - 1), this.selected + 1);
      void this.updateDetails();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.expanded = !this.expanded;
      void this.updateDetails();
      return;
    }
    if (matchesKey(data, "r")) void this.refresh();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const th = this.theme;
    const usable = Math.max(1, width);
    const lines: string[] = [""];
    const title = th.fg("accent", th.bold(" Background Tasks "));
    lines.push(truncateToWidth(`${th.fg("borderMuted", "──")}${title}${th.fg("borderMuted", "─".repeat(Math.max(0, usable - 22)))}`, usable));
    lines.push(truncateToWidth(`  ${th.fg("muted", `${this.tasks.length} task${this.tasks.length === 1 ? "" : "s"}`)}  ${th.fg("dim", this.includeHistory ? "all project history" : "current session branch")}`, usable));
    lines.push("");
    if (this.tasks.length === 0) {
      lines.push(`  ${th.fg("dim", "No background tasks yet.")}`);
    } else {
      for (const [index, task] of this.tasks.entries()) {
        const cursor = index === this.selected ? th.fg("accent", ">") : " ";
        const state = colorStatus(th, task.status, statusGlyph(task.status));
        const name = truncatePlain(task.name, Math.max(8, usable - 48)).padEnd(Math.max(8, usable - 48));
        const ownership = task.ownedByCurrentInstance ? "" : th.fg("dim", " history");
        const line = ` ${cursor} ${state} ${th.fg("text", name)} ${th.fg("dim", formatDuration(currentDurationMs(task)).padStart(8))} ${th.fg("muted", task.taskId.slice(0, 11))}${ownership}`;
        lines.push(truncateToWidth(line, usable));
      }
    }
    const task = this.tasks[this.selected];
    if (this.expanded && task) {
      lines.push("");
      pushCodeBlock(lines, "Command", task.command, usable, th, "bash");
      pushStructuredField(lines, "Cwd", task.cwd, usable, th);
      if (task.attachCommand) pushStructuredField(lines, "Attach", task.attachCommand, usable, th);
      pushStructuredField(lines, "Log", task.logPath, usable, th);
      if (this.latestLog.trim()) {
        pushCodeBlock(lines, "Latest output", this.latestLog.trimEnd().split("\n").slice(-8).join("\n"), usable, th, "text");
      }
    }
    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "↑↓ select  Enter details  r refresh  q close")}  ${th.fg("success", "● live")}`, usable));
    lines.push("");
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.autoRefreshTimer) clearInterval(this.autoRefreshTimer);
    this.autoRefreshTimer = undefined;
    this.registry.off("changed", this.onRegistryChanged);
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return;
    }
    this.refreshInFlight = true;
    try {
      const selectedId = this.tasks[this.selected]?.taskId;
      this.tasks = await this.registry.list(this.includeHistory ? "all" : "session");
      this.selected = Math.max(0, selectedId ? this.tasks.findIndex((task) => task.taskId === selectedId) : 0);
      if (this.selected < 0) this.selected = 0;
      await this.updateDetails();
    } finally {
      this.refreshInFlight = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  private async updateDetails(): Promise<void> {
    if (this.detailsInFlight) return;
    this.detailsInFlight = true;
    this.latestLog = "";
    const task = this.tasks[this.selected];
    try {
      if (this.expanded && task) {
        const size = await import("node:fs/promises").then(({ stat }) => stat(task.logPath).then((value) => value.size).catch(() => 0));
        const chunk = await this.registry.logs(task.taskId, Math.max(0, size - 4_096), 4_096, true).catch(() => undefined);
        if (this.expanded && this.tasks[this.selected]?.taskId === task.taskId) this.latestLog = chunk?.text ?? "";
      }
    } finally {
      this.detailsInFlight = false;
      this.invalidate();
      this.requestRender();
    }
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    if (this.expanded) await this.updateDetails();
    else {
      this.invalidate();
      this.requestRender();
    }
  }
}

export function colorStatus(theme: Theme, status: TaskStatus, text: string): string {
  if (status === "completed") return theme.fg("success", text);
  if (status === "starting" || status === "running") return theme.fg("accent", text);
  if (status === "unknown") return theme.fg("dim", text);
  if (status === "cancelled") return theme.fg("muted", text);
  return theme.fg("error", text);
}

function statusGlyph(status: TaskStatus): string {
  if (status === "completed") return "✓";
  if (status === "starting" || status === "running") return "●";
  if (status === "cancelled") return "■";
  if (status === "unknown") return "?";
  return "×";
}

function statusLabel(status: TaskStatus): string {
  return `${statusGlyph(status)} ${status}`;
}

function truncatePlain(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(1, length - 1))}…`;
}

function pushWrapped(lines: string[], text: string, width: number): void {
  for (const line of wrapTextWithAnsi(text, width)) lines.push(truncateToWidth(line, width));
}

function pushStructuredField(lines: string[], label: string, value: string, width: number, theme: Theme): void {
  lines.push(truncateToWidth(`  ${theme.fg("toolTitle", theme.bold(label))}`, width));
  pushWrapped(lines, `    ${theme.fg("mdCode", value)}`, width);
}

function pushCodeBlock(lines: string[], label: string, code: string, width: number, theme: Theme, language: string): void {
  const indent = width >= 10 ? "  " : "";
  const frameWidth = width - indent.length;
  if (frameWidth < label.length + 6) {
    lines.push(truncateToWidth(theme.fg("toolTitle", theme.bold(label)), width));
    for (const line of code.split("\n")) lines.push(truncateToWidth(theme.fg("mdCodeBlock", line), width));
    return;
  }

  const border = (value: string) => theme.fg("mdCodeBlockBorder", value);
  const topFill = "─".repeat(Math.max(0, frameWidth - label.length - 5));
  const title = theme.fg("toolTitle", theme.bold(label));
  lines.push(truncateToWidth(`${indent}${border("╭─ ")}${title}${border(` ${topFill}╮`)}`, width));
  const innerWidth = Math.max(1, frameWidth - 4);
  let highlighted: string[];
  try {
    highlighted = highlightCode(code, language);
  } catch {
    highlighted = code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
  }
  if (highlighted.length === 0) highlighted = [""];
  for (const sourceLine of highlighted) {
    const wrapped = wrapTextWithAnsi(sourceLine, innerWidth);
    for (const segment of wrapped.length ? wrapped : [""]) {
      const clipped = truncateToWidth(segment, innerWidth, "");
      const padding = theme.fg("mdCodeBlock", " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped))));
      lines.push(truncateToWidth(`${indent}${border("│")} ${clipped}${padding} ${border("│")}`, width, ""));
    }
  }
  lines.push(truncateToWidth(`${indent}${border(`╰${"─".repeat(Math.max(0, frameWidth - 2))}╯`)}`, width));
}

function currentDurationMs(task: TaskSummary): number {
  if (task.endedAt) return task.durationMs;
  const started = Date.parse(task.startedAt ?? task.createdAt);
  return Number.isFinite(started) ? Math.max(0, Date.now() - started) : task.durationMs;
}
