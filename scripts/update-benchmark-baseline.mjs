import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const label = process.argv.find((arg) => arg.startsWith("--approval-label="))?.split("=")[1];
const results = process.argv.find((arg) => arg.startsWith("--results="))?.split("=")[1];
if (label !== "benchmark-baseline-approved" || !results) {
  throw new Error(
    "Baseline update requires --approval-label=benchmark-baseline-approved and --results=<reviewed CI artifact>",
  );
}
const evidence = JSON.parse(await readFile(path.resolve(root, results), "utf8"));
if (evidence.status !== "passed" || !evidence.sourceCommit || !evidence.corpusManifestSha256) {
  throw new Error("Benchmark evidence is incomplete or did not pass");
}
await copyFile(path.resolve(root, results), path.join(root, "benchmarks/approved-result.json"));
console.log(
  "Reviewed evidence copied to benchmarks/approved-result.json. Threshold changes remain an explicit reviewed edit.",
);
