import { open, stat } from "node:fs/promises";
import type { LogChunk } from "./types.js";

const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export async function readLogChunk(
  taskId: string,
  path: string,
  offset = 0,
  limitBytes = 16 * 1024,
  cleanAnsi = true,
): Promise<LogChunk> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 4 || limitBytes > 64 * 1024) {
    throw new Error("limitBytes must be between 4 and 65536");
  }

  const size = (await stat(path)).size;
  const start = Math.min(offset, size);
  const bytesToRead = Math.min(limitBytes, size - start);
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await open(path, "r");
  let bytesRead = 0;
  try {
    ({ bytesRead } = await handle.read(buffer, 0, bytesToRead, start));
  } finally {
    await handle.close();
  }

  const safeLength = completeUtf8PrefixLength(buffer.subarray(0, bytesRead));
  const raw = buffer.subarray(0, safeLength).toString("utf8");
  return {
    taskId,
    source: "log",
    text: cleanAnsi ? stripAnsi(raw) : raw,
    offset: start,
    nextOffset: start + safeLength,
    endOfLog: start + safeLength >= size,
    truncated: start + safeLength < size,
  };
}

function completeUtf8PrefixLength(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let lead = buffer.length - 1;
  while (lead >= 0 && (buffer[lead]! & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return 0;
  const byte = buffer[lead]!;
  const expected = byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  return buffer.length - lead < expected ? lead : buffer.length;
}
