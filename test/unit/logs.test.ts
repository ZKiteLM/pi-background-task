import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readLogChunk, stripAnsi } from "../../src/logs.js";

test("log reads are byte bounded and incremental", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bg-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "output.log");
  await writeFile(path, "first\nsecond\nthird\n");
  const first = await readLogChunk("task", path, 0, 6);
  assert.equal(first.text, "first\n");
  assert.equal(first.nextOffset, 6);
  assert.equal(first.endOfLog, false);
  const second = await readLogChunk("task", path, first.nextOffset, 64);
  assert.equal(second.text, "second\nthird\n");
  assert.equal(second.endOfLog, true);
});

test("ANSI control sequences can be stripped", () => {
  assert.equal(stripAnsi("\u001b[31mred\u001b[0m\r\n"), "red\n");
});

test("incremental reads do not split a UTF-8 code point", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bg-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "output.log");
  await writeFile(path, "ab中文cd");
  const first = await readLogChunk("task", path, 0, 4);
  assert.equal(first.text, "ab");
  assert.equal(first.nextOffset, 2);
  const second = await readLogChunk("task", path, first.nextOffset, 6);
  assert.equal(second.text, "中文");
});

test("log limit is capped", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bg-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "output.log");
  await writeFile(path, "x");
  await assert.rejects(() => readLogChunk("task", path, 0, 65_537), /limitBytes/);
});
