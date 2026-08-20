import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = ["NOTICE", "THIRD_PARTY_MODELS.md", "bom.cdx.json", "bom.spdx.json"];
for (const workspace of ["packages/core", "packages/mcp-server"]) {
  for (const file of files) {
    await copyFile(path.join(root, file), path.join(root, workspace, file));
  }
}
console.log("Prepared NOTICE, model provenance, and SBOM package metadata.");
