import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString().split("\0").filter(Boolean);
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9]{36}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
];
const hits = [];
for (const file of files) {
  if (/\.(?:onnx|png|jpg|jpeg|gif|pdf|vsix|tgz)$/.test(file)) continue;
  const contents = await readFile(path.join(root, file), "utf8").catch(() => "");
  for (const pattern of patterns) if (pattern.test(contents)) hits.push(`${file}: ${pattern}`);
}
if (hits.length) throw new Error(`Possible committed secrets:\n${hits.join("\n")}`);
console.log(`Secret-pattern scan passed for ${files.length} tracked files.`);
