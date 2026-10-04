import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonical = [
  "README.md",
  "ARCHITECTURE.md",
  "docs/OPERATIONS.md",
  "docs/RETRIEVAL-PIPELINE.md",
  "docs/SECURITY.md",
  "docs/BENCHMARKS.md",
  "docs/RELEASE.md",
  "packages/core/README.md",
  "packages/mcp-server/README.md",
  "packages/vscode/README.md",
];
const staleReports = [
  "-CODEX-PLAN.md",
  "CODEX-CHANGES-REVIEW.md",
  "CODEX-COMPREHENSIVE-BRANCH-REVIEW.md",
  "COMPREHENSIVE-BRANCH-REVIEW.md",
  "CONSOLIDATED-FIX-PLAN.md",
  "CORE-REVIEW-REPORT.md",
  "DESIGN-IMPLEMENTATION-REVIEW.md",
  "IMPLEMENTATION-REVIEW.md",
  "MCP-FUNCTIONAL-TEST-REPORT.md",
  "STRUCTURAL-REVIEW-REPORT.md",
  "now-create-comprehensive-plan-serialized-rabbit.md",
];

for (const relative of canonical) {
  const absolute = path.join(root, relative);
  const contents = await readFile(absolute, "utf8");
  for (const match of contents.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
    let target = match[1].trim().replace(/^<|>$/g, "");
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    target = decodeURIComponent(target.split("#", 1)[0]);
    if (!target) continue;
    await access(path.resolve(path.dirname(absolute), target)).catch(() => {
      throw new Error(`${relative}: broken documentation link ${match[1]}`);
    });
  }
}

// The storage migrator was deleted: v2 is the only format and pre-0.4 data is
// refused with UnsupportedStorageError. No canonical doc may describe it.
for (const relative of canonical) {
  const contents = await readFile(path.join(root, relative), "utf8");
  assert.doesNotMatch(contents, /migrat/i, `${relative} still describes the removed storage migration`);
  assert.doesNotMatch(contents, /storage conversion/i, `${relative} still describes storage conversion`);
}

// A `file.ts:N` citation rots the first time the file is split, so each one
// must name a source file that exists and a line the file still has. Prefer
// citing the symbol; this only catches the references that remain.
async function sourceFilesByBasename() {
  const byName = new Map();
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.name.endsWith(".ts")) {
        byName.set(entry.name, [...(byName.get(entry.name) ?? []), absolute]);
      }
    }
  };
  for (const pkg of await readdir(path.join(root, "packages"), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    await walk(path.join(root, "packages", pkg.name, "src")).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  return byName;
}
const sourceFiles = await sourceFilesByBasename();
for (const relative of canonical) {
  const contents = await readFile(path.join(root, relative), "utf8");
  for (const match of contents.matchAll(/\b([A-Za-z0-9_-]+\.ts):(\d+)(?:-(\d+))?/g)) {
    const [reference, basename, first, last] = match;
    const candidates = sourceFiles.get(basename) ?? [];
    assert.ok(candidates.length > 0, `${relative}: ${reference} names no source file under packages/*/src`);
    const highest = Math.max(Number(first), Number(last ?? first));
    let fits = false;
    for (const candidate of candidates) {
      const lineCount = (await readFile(candidate, "utf8")).split("\n").length;
      fits ||= highest <= lineCount;
    }
    assert.ok(fits, `${relative}: ${reference} is past the end of ${basename}; cite the symbol instead`);
  }
}

const mcp = await readFile(path.join(root, "packages/mcp-server/README.md"), "utf8");
assert.doesNotMatch(mcp, /Existing branch-era storage .* intentionally not migrated/);
// The stdio server has no roles, so the guide must not resurrect a role matrix.
assert.doesNotMatch(mcp, /Shared reader|Shared curator|Shared admin/);
for (const variable of ["RAGNAROK_STORAGE_DIR"]) {
  assert.match(mcp, new RegExp(variable), `MCP guide must document ${variable}`);
}
// The settings that moved into config.json must be documented by their key.
// Asserting on the old variable names would pin the guide to a configuration
// mechanism the server no longer has.
for (const key of ["security.allowedPaths", "embedding.model", "llm.provider", "limits.maxResponseBytes"]) {
  assert.match(mcp, new RegExp(key.replace(".", "\\.")), `MCP guide must document ${key}`);
}
// Variables that belonged to the removed HTTP transport are no longer read.
// Naming them here would read as documentation of a supported setting.
for (const removed of [
  "RAGNAROK_DEPLOYMENT_MODE",
  "RAGNAROK_ADMIN_API_KEY",
  "RAGNAROK_TLS_CERT_PATH",
  "RAGNAROK_TRUSTED_PROXIES",
  "RAGNAROK_TRANSFER_MAX_FILE_BYTES",
]) {
  assert.doesNotMatch(mcp, new RegExp(removed), `MCP guide must not document removed variable ${removed}`);
}
for (const [name, contents] of [
  ["README.md", await readFile(path.join(root, "README.md"), "utf8")],
  ["packages/mcp-server/README.md", mcp],
]) {
  assert.doesNotMatch(
    contents,
    /assertNoRemovedEnvVars|rejected at startup/,
    `${name} describes a startup guard that does not exist`,
  );
}

const core = await readFile(path.join(root, "packages/core/README.md"), "utf8");
for (const strategy of ["VECTOR", "HYBRID", "BM25"]) {
  assert.match(core, new RegExp(`\\*\\*${strategy}\\*\\*`), `Core guide must document the ${strategy} strategy`);
}
for (const removed of ["GRAPH_HYBRID", "EnsembleRetriever", "LangGraph"]) {
  assert.doesNotMatch(core, new RegExp(removed), `Core guide must not document removed subsystem ${removed}`);
}
assert.match(core, /embedding fingerprint/i);
assert.match(core, /requires reindexing/i);

const rootReadme = await readFile(path.join(root, "README.md"), "utf8");
const vscodeReadme = await readFile(path.join(root, "packages/vscode/README.md"), "utf8");
const architecture = await readFile(path.join(root, "ARCHITECTURE.md"), "utf8");
const operations = await readFile(path.join(root, "docs/OPERATIONS.md"), "utf8");
const security = await readFile(path.join(root, "docs/SECURITY.md"), "utf8");
const release = await readFile(path.join(root, "docs/RELEASE.md"), "utf8");
// The extension contributes exactly ragQuery, ragTopic, and ragMemory. Naming
// ragResetMemory would document a tool that no longer exists: the irreversible
// wipe is the sidebar's Reset Memory command, not something a model may call.
for (const tool of ["ragQuery", "ragTopic", "ragMemory"]) {
  for (const [name, contents] of [
    ["root README", rootReadme],
    ["vscode README", vscodeReadme],
  ]) {
    assert.match(contents, new RegExp(tool), `${name} must document the ${tool} tool`);
  }
}
for (const [name, contents] of [
  ["root README", rootReadme],
  ["vscode README", vscodeReadme],
  ["architecture", architecture],
  ["security", security],
]) {
  assert.doesNotMatch(contents, /ragResetMemory/, `${name} must not document the removed ragResetMemory tool`);
}
assert.match(vscodeReadme, /RAG: Show Memory Graph/);
// The README is the user's reference for the extension surface: every
// contributed setting and Command Palette entry must appear in it, and the
// facts below were each found to contradict the code.
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const readme = rootReadme;
// The welcome panels ship inside the extension and are what a user reads when
// storage is refused. They must not point at a guide that no longer exists.
for (const entry of manifest.contributes.viewsWelcome) {
  assert.doesNotMatch(entry.contents, /migrat/i, `viewsWelcome for ${entry.view} still mentions migration`);
  for (const link of entry.contents.matchAll(/https:\/\/github\.com\/hyorman\/ragnarok\/blob\/main\/([^\s)]+)/g)) {
    const target = decodeURIComponent(link[1].split("#", 1)[0]);
    await access(path.join(root, target)).catch(() => {
      throw new Error(`viewsWelcome for ${entry.view} links to a file that does not exist: ${target}`);
    });
  }
}
for (const key of Object.keys(manifest.contributes.configuration.properties)) {
  assert.match(readme, new RegExp(key.replace(".", "\\.")), `README.md must document the ${key} setting`);
}
for (const command of manifest.contributes.commands) {
  assert.equal(command.category, "RAG", `${command.command} must use the RAG command category`);
  assert.match(readme, new RegExp(`RAG: ${command.title}`), `README.md must document "RAG: ${command.title}"`);
}
for (const [pattern, why] of [
  [/70% weight|30% weight/, "hybrid weights are 0.9/0.1 (hybridRetriever.ts)"],
  [/simple mode|agentic mode/i, "no simple/agentic mode setting exists"],
  [/Batch size: 32/, "embedding batches are 1000 (local) and 100 (remote)"],
  [/ragnarok\.embeddingModel/, "there is no ragnarok.embeddingModel setting"],
  [/gpt-3\.5-turbo|"ragnarok\.llmModel": "gpt-4o"/, "ragnarok.llmModel defaults to gpt-4o-mini"],
  [/"ragnarok\.chunkSize": 512|"ragnarok\.chunkOverlap": 50/, "chunk defaults are 1000/200"],
  [/ragnarok-0\.1\.6\.vsix|TypeScript-5\.3|LangChain\.js-0\.2/, "stale version strings"],
  [/<\/h2>/, "the title opens <h1> and must close </h1>"],
]) {
  assert.doesNotMatch(readme, pattern, `README.md: ${why}`);
}
// The root README is a user guide. Contract detail lives in the package guides
// and ARCHITECTURE.md; these phrases only appeared in duplicated detail.
for (const [pattern, why] of [
  [
    /Type-Safe|Comprehensive Logging|Rich Icons|like SQLite for vectors/,
    "feature list items that describe nothing a user can do",
  ],
  [
    /GRAPH_VISUALIZATION_RECORD_TOO_LARGE|text\/html;profile=mcp-app/,
    "memory-graph contract detail belongs in the MCP guide",
  ],
  [/truthful by construction/, "release-evidence policy belongs in docs/RELEASE.md"],
  [/Cacheable discovery,\s+list, and resource-read results/, "MCP protocol detail belongs in the MCP guide"],
]) {
  assert.doesNotMatch(readme, pattern, `README.md: ${why}`);
}
assert.match(architecture, /separate storage/i);
assert.match(core, /MemoryService/);
assert.match(vscodeReadme, /confirmation/i);
assert.match(mcp, /inline MCP App/i);
for (const [name, contents] of [
  ["root README", rootReadme],
  ["architecture", architecture],
  ["operations", operations],
  ["security", security],
]) {
  assert.match(contents, /no\s+cross-host data sharing/i, `${name} must document host storage isolation`);
}
assert.match(release, /media\/memoryGraph\.js/);
assert.match(release, /media\/memoryGraph\.css/);
const copilotInstructions = await readFile(path.join(root, ".github/copilot-instructions.md"), "utf8");
assert.doesNotMatch(
  copilotInstructions,
  /\brtk\b/,
  "Copilot instructions must describe this project, not a personal CLI wrapper",
);
assert.match(copilotInstructions, /npm run test:fast/, "Copilot instructions must name the project's test command");
assert.doesNotMatch(architecture, /v0\.7 implementation/, "ARCHITECTURE.md must not claim a version");
assert.doesNotMatch(mcp, /removed-variable rejection/, "MCP guide lists a function that does not exist");
for (const module of ["graphVisualizationAdapter.ts", "memoryToolAdapter.ts", "toolRuntime.ts"]) {
  assert.match(mcp, new RegExp(module.replace(".", "\\.")), `MCP guide module layout must list ${module}`);
}
assert.doesNotMatch(core, /@xenova\/transformers/, "core uses @huggingface/transformers");
const history = await readFile(path.join(root, "docs/BENCHMARK-HISTORY.md"), "utf8");
assert.match(history, /not release evidence/, "BENCHMARK-HISTORY.md must say it is historical");

for (const relative of staleReports) {
  await access(path.join(root, relative))
    .then(() => {
      throw new Error(`Stale branch report must not ship: ${relative}`);
    })
    .catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
}

console.log("Canonical documentation contracts passed.");
