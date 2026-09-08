import { readFile } from "node:fs/promises";

const tag = process.argv[2];
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const expected = `v${packageJson.version}`;

if (tag !== expected) {
  console.error(`Release tag ${JSON.stringify(tag)} does not match package version ${JSON.stringify(expected)}.`);
  process.exitCode = 1;
} else {
  console.log(`Release tag matches package version: ${expected}`);
}
