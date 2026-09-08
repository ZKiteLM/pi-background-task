import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TaskRegistry } from "../../src/registry.js";
import { TaskDashboard } from "../../src/tui.js";
import type { TaskSummary } from "../../src/types.js";

const longTask: TaskSummary = {
  taskId: "bg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  name: "a task with a moderately descriptive name",
  command: `bash -lc 'sum=0; for i in $(seq 1 20); do value=$(date +%s); echo "$value"; sum=$((sum + value)); sleep 1; done; echo "$sum"'`,
  cwd: "/Users/example/a very long project directory/with several/nested/components/that/must/wrap",
  status: "completed",
  createdAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  durationMs: 20_000,
  exitCode: 0,
  signal: null,
  ownerInstanceId: "run_20260908T123456789_p12345_abcdef",
  piSessionId: "01a08008-dfc3-7172-be8b-f50ae81b962a",
  piSessionName: "long session name",
  socketName: "pi-bg-run_20260908T123456789_p12345_abcdef",
  ownedByCurrentInstance: true,
  sessionName: "pi-bg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  logPath: "/Users/example/a very long project/.pi/background-tasks/instances/run/task/output.log",
};

test("expanded task details never exceed the terminal width", async () => {
  const styled: Array<[string, string]> = [];
  const registry = Object.assign(new EventEmitter(), {
    list: async () => [longTask],
    logs: async () => ({ text: "a long output line ".repeat(20) }),
  }) as unknown as TaskRegistry;
  const theme = {
    fg: (color: string, text: string) => {
      styled.push([color, text]);
      return text;
    },
    bold: (text: string) => text,
  } as unknown as Theme;
  const dashboard = new TaskDashboard(registry, theme, () => undefined, () => undefined, false);
  test.after(() => dashboard.dispose());
  await dashboard.initialize();
  dashboard.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));

  for (const width of [20, 40, 80, 131]) {
    dashboard.invalidate();
    for (const line of dashboard.render(width)) {
      assert.ok(visibleWidth(line) <= width, `line width ${visibleWidth(line)} exceeds ${width}: ${line}`);
    }
  }
  const expanded = dashboard.render(131).join("\n");
  assert.match(expanded, /╭─ Command/);
  assert.match(expanded, /Cwd/);
  assert.match(expanded, /Log/);
  assert.match(expanded, /╭─ Latest output/);
  assert.ok(styled.some(([color, text]) => color === "toolTitle" && text === "Command"));
  assert.ok(styled.some(([color, text]) => color === "toolTitle" && text === "Latest output"));
  const detailLines = dashboard.render(131);
  const cwdLine = detailLines.findIndex((line) => line.trim() === "Cwd");
  const latestLine = detailLines.findIndex((line) => line.includes("Latest output"));
  assert.match(detailLines[cwdLine - 1] ?? "", /╰─/);
  assert.notEqual(detailLines[latestLine - 1]?.trim(), "");
});

test("dashboard refreshes when the registry publishes a change", async () => {
  let tasks = [longTask];
  let renders = 0;
  const registry = Object.assign(new EventEmitter(), {
    list: async () => tasks,
    logs: async () => ({ text: "" }),
  }) as unknown as TaskRegistry;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const dashboard = new TaskDashboard(registry, theme, () => { renders += 1; }, () => undefined, false);
  test.after(() => dashboard.dispose());
  await dashboard.initialize();

  tasks = [longTask, { ...longTask, taskId: "bg_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "second task" }];
  registry.emit("changed");
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(dashboard.render(80).join("\n"), /2 tasks/);
  assert.ok(renders >= 2);
});
