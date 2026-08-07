import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(await readFile(path.join(root, "release-policy.json"), "utf8"));
const files = await readdir(root);
const coreTarballs = files.filter((file) => /^ragnarok-core-.*\.tgz$/.test(file));
const mcpTarballs = files.filter((file) => /^ragnarok-mcp-server-.*\.tgz$/.test(file));
const vsixFiles = files.filter((file) => file.endsWith(".vsix"));
if (coreTarballs.length !== 1 || mcpTarballs.length !== 1) {
  throw new Error("Release assets require exactly one core and one MCP npm tarball");
}
if (vsixFiles.length !== policy.vsixTargets.length) {
  throw new Error(`Release assets require ${policy.vsixTargets.length} VSIX files; found ${vsixFiles.length}`);
}
for (const target of policy.vsixTargets) {
  if (vsixFiles.filter((name) => name.includes(`-${target}-`) || name.includes(`-${target}.`)).length !== 1) {
    throw new Error(`Release assets require exactly one VSIX for ${target}`);
  }
}
const checks = [
  [/^ragnarok-core-.*\.tgz$/, policy.budgets.coreTarballCompressedBytes, "core tarball"],
  [/^ragnarok-mcp-server-.*\.tgz$/, policy.budgets.mcpTarballCompressedBytes, "MCP tarball"],
  [/\.vsix$/, policy.budgets.vsixCompressedBytes, "VSIX"],
];
for (const [pattern, budget, label] of checks) {
  for (const name of files.filter((file) => pattern.test(file))) {
    const bytes = (await stat(path.join(root, name))).size;
    if (bytes > budget) throw new Error(`${label} ${name} is ${bytes} bytes; budget is ${budget}`);
    if (label === "VSIX") {
      const unpackedBytes = new AdmZip(path.join(root, name))
        .getEntries()
        .reduce((total, entry) => total + (entry.isDirectory ? 0 : entry.header.size), 0);
      if (unpackedBytes > policy.budgets.vsixUnpackedBytes) {
        throw new Error(
          `${label} ${name} unpacks to ${unpackedBytes} bytes; budget is ${policy.budgets.vsixUnpackedBytes}`,
        );
      }
    }
  }
}
console.log("Release artifact size budgets passed.");
