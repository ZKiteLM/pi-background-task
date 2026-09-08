import { access, readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const errors = [];
const serialized = JSON.stringify(packageJson);

if (serialized.includes("YOUR_GITHUB_USERNAME")) {
  errors.push("replace every YOUR_GITHUB_USERNAME placeholder in package.json");
}
if (!packageJson.keywords?.includes("pi-package")) {
  errors.push("keywords must include pi-package for Pi gallery discovery");
}
if (!packageJson.pi?.extensions?.length) {
  errors.push("pi.extensions must contain the compiled extension entry");
}
if (packageJson.pi?.video && !/^https:\/\/.+\.mp4(?:\?.*)?$/i.test(packageJson.pi.video)) {
  errors.push("pi.video must be an HTTPS MP4 URL");
}
if (packageJson.pi?.image && !/^https:\/\/.+\.(?:png|jpe?g|gif|webp)(?:\?.*)?$/i.test(packageJson.pi.image)) {
  errors.push("pi.image must be an HTTPS PNG, JPEG, GIF, or WebP URL");
}

for (const file of ["../README.md", "../README.zh-CN.md", "../LICENSE"]) {
  try {
    await access(new URL(file, import.meta.url));
  } catch {
    errors.push(`required release file is missing: ${file.slice(3)}`);
  }
}

if (errors.length > 0) {
  console.error("Release metadata is not ready:\n- " + errors.join("\n- "));
  process.exitCode = 1;
} else {
  console.log("Release metadata is ready.");
}
