import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const forbidden = /\b(?:AGPL|SSPL|BUSL|Commons-Clause)\b/i;
const violations = [];
for (const [location, pkg] of Object.entries(lock.packages)) {
  if (!location.includes("node_modules/")) continue;
  if (pkg.license && forbidden.test(pkg.license)) violations.push(`${location}: ${pkg.license}`);
}
if (violations.length) throw new Error(`Forbidden production/development licenses:\n${violations.join("\n")}`);
console.log("Dependency license policy passed (unknown licenses remain visible in the SBOM as NOASSERTION).");
