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

/** `RegExp.escape` needs Node 24 and `engines` allows 22, so escape by hand. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * A name counts as documented only as a whole token: not inside a longer name
 * (`ragnarok.llm` in `ragnarok.llmModel`) and not as the parent of a dotted key
 * (`llm` in `llm.provider`). A sentence-ending period is fine.
 */
function wholeToken(token) {
  return new RegExp(`(?<![A-Za-z0-9_.])${escapeRegExp(token).replace(/ /g, "\\s+")}(?![A-Za-z0-9_]|\\.[A-Za-z0-9_])`);
}
/** A phrase pin must survive a rewrap, so each space in it matches any whitespace, a line break included. */
function phrase(text, flags) {
  return new RegExp(escapeRegExp(text).replace(/ /g, "\\s+"), flags);
}

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
const sourceText = (await Promise.all([...sourceFiles.values()].flat().map((file) => readFile(file, "utf8")))).join(
  "\n",
);
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

// Each package guide's Module Layout is a map of src/, and it is checked by
// path, not by file name: `types.ts` and `index.ts` exist in several
// directories, so a bare name proves nothing. In both directions, every file
// directly under src/, every directory directly under src/, and every file
// under a directory the layout expands (lists children for) must be named at
// its own path, and everything the layout names must exist. A split that adds
// modules has to say what they are, or the map stops being the one place to
// look. A directory listed with no children is a summary of what is inside it;
// that is legitimate only where it is declared here, so adding another is a
// deliberate edit to this list rather than a quiet omission.
const summarisedDirectories = {
  core: new Set(["sharedTopics", "tools", "memory", "models", "visualization"]),
  "mcp-server": new Set(["ui"]),
  vscode: new Set(),
};
function parseModuleLayout(readmeContents, relative) {
  const section = readmeContents.split(/^## Module Layout$/m)[1];
  assert.ok(section, `${relative} must have a "Module Layout" section`);
  const layout = /```[^\n]*\n([\s\S]*?)```/.exec(section)?.[1];
  assert.ok(layout, `${relative} Module Layout must contain a tree`);
  const files = new Set();
  const directories = new Map(); // path under src/ -> { children, comment }
  const open = []; // names of the directories enclosing the current line
  for (const line of layout.split("\n")) {
    if (!/[├└]──/.test(line)) continue;
    const entry = /^((?:│   |    )*)[├└]── (\S+)(?:\s+#\s*(.*?))?\s*$/.exec(line);
    assert.ok(entry, `${relative} Module Layout: cannot read "${line.trim()}"`);
    const depth = entry[1].length / 4;
    assert.ok(depth <= open.length, `${relative} Module Layout: "${line.trim()}" is not inside a directory`);
    open.length = depth;
    const isDirectory = entry[2].endsWith("/");
    const name = isDirectory ? entry[2].slice(0, -1) : entry[2];
    const entryPath = [...open, name].join("/");
    if (depth > 0) directories.get(open.join("/")).children += 1;
    if (isDirectory) {
      directories.set(entryPath, { children: 0, comment: entry[3] ?? "" });
      open.push(name);
    } else {
      files.add(entryPath);
    }
  }
  return { files, directories };
}
async function typeScriptFilesUnder(directory, prefix) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await typeScriptFilesUnder(path.join(directory, entry.name), relative)));
    else if (entry.name.endsWith(".ts")) found.push(relative);
  }
  return found;
}
for (const pkg of ["core", "mcp-server", "vscode"]) {
  const relative = `packages/${pkg}/README.md`;
  const { files: listed, directories } = parseModuleLayout(await readFile(path.join(root, relative), "utf8"), relative);
  const src = path.join(root, "packages", pkg, "src");
  const required = new Set();
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) required.add(entry.name);
    if (entry.isDirectory()) {
      assert.ok(directories.has(entry.name), `${relative} Module Layout must list the ${entry.name}/ directory`);
    }
  }
  for (const [directory, { children, comment }] of directories) {
    await access(path.join(src, directory)).catch(() => {
      throw new Error(`${relative} Module Layout lists ${directory}/, which does not exist`);
    });
    if (children > 0) {
      for (const file of await typeScriptFilesUnder(path.join(src, directory), directory)) required.add(file);
    } else {
      assert.ok(
        summarisedDirectories[pkg].has(directory),
        `${relative} Module Layout lists ${directory}/ without its files: list them, or declare it summarised in check-docs`,
      );
      assert.ok(comment, `${relative} Module Layout must say what the summarised ${directory}/ directory holds`);
    }
  }
  for (const directory of summarisedDirectories[pkg]) {
    assert.equal(
      directories.get(directory)?.children,
      0,
      `${relative} Module Layout must list ${directory}/ as a summarised directory (check-docs declares it so)`,
    );
  }
  for (const file of required) {
    assert.ok(listed.has(file), `${relative} Module Layout must list ${file}`);
  }
  for (const file of listed) {
    await access(path.join(src, file)).catch(() => {
      throw new Error(`${relative} Module Layout lists ${file}, which does not exist`);
    });
  }
}

const mcp = await readFile(path.join(root, "packages/mcp-server/README.md"), "utf8");
assert.doesNotMatch(mcp, /Existing branch-era storage .* intentionally not migrated/);
// The stdio server has no roles, so the guide must not resurrect a role matrix.
assert.doesNotMatch(mcp, /Shared reader|Shared curator|Shared admin/);
// The settings that moved into config.json must be documented by their key.
// Asserting on the old variable names would pin the guide to a configuration
// mechanism the server no longer has.
for (const key of ["security.allowedPaths", "embedding.model", "llm.provider", "limits.maxResponseBytes"]) {
  assert.match(mcp, wholeToken(key), `MCP guide must document ${key}`);
}
// The environment is a closed set, and the MCP guide's table is the whole of
// it: every RAGNAROK_* variable the shipped sources name is documented there,
// and no guide names one the sources do not read. That is what keeps a variable
// of the removed HTTP transport out of every guide, without a list of removed
// names to maintain. Release tooling reads one more, which only BENCHMARKS.md
// documents.
const environmentVariables = (text) => new Set(text.match(/RAGNAROK_[A-Z0-9_]+/g) ?? []);
const sourceVariables = environmentVariables(sourceText);
for (const variable of sourceVariables) {
  assert.match(mcp, wholeToken(variable), `MCP guide must document ${variable}`);
}
const releaseToolingVariables = new Set(["RAGNAROK_RELEASE_ARTIFACT_DIR"]);
for (const relative of canonical) {
  for (const variable of environmentVariables(await readFile(path.join(root, relative), "utf8"))) {
    assert.ok(
      sourceVariables.has(variable) || releaseToolingVariables.has(variable),
      `${relative} names ${variable}, which nothing reads`,
    );
  }
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
  assert.match(
    core,
    new RegExp(`\\*\\*${escapeRegExp(strategy)}\\*\\*`),
    `Core guide must document the ${strategy} strategy`,
  );
}
for (const removed of ["GRAPH_HYBRID", "EnsembleRetriever", "LangGraph"]) {
  assert.doesNotMatch(
    core,
    new RegExp(escapeRegExp(removed)),
    `Core guide must not document removed subsystem ${removed}`,
  );
}
assert.match(core, phrase("embedding fingerprint", "i"));
assert.match(core, phrase("requires reindexing", "i"));

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
    assert.match(contents, wholeToken(tool), `${name} must document the ${tool} tool`);
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
assert.match(vscodeReadme, phrase("RAG: Show Memory Graph"));
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
  assert.match(readme, wholeToken(key), `README.md must document the ${key} setting`);
}
for (const command of manifest.contributes.commands) {
  assert.equal(command.category, "RAG", `${command.command} must use the RAG command category`);
  assert.match(readme, wholeToken(`RAG: ${command.title}`), `README.md must document "RAG: ${command.title}"`);
}
// ragQuery and ragTopic only read, and the user guide must say so. ragMemory
// stores and forgets, so the claim must not be attached to it.
const nativeTools = rootReadme.split("\n").find((line) => line.startsWith("- **Native VS Code Tools**"));
assert.ok(nativeTools, 'README.md must keep its "Native VS Code Tools" bullet');
assert.match(
  nativeTools,
  /`ragQuery`.*`ragTopic`.*both read-only.*`ragMemory`/,
  "README.md must say ragQuery and ragTopic are read-only",
);
// contributes.languageModelTools is generated, so a contributor who hand-edits
// package.json meets the drift check's failure before its cause. The command
// list that sends contributors to `npm run` must name both scripts, and each
// must exist.
for (const script of ["tools:manifest", "tools:manifest:check"]) {
  assert.ok(manifest.scripts[script], `package.json must define the ${script} script`);
  assert.match(
    readme,
    new RegExp(`npm run ${escapeRegExp(script)}(?![\\w:])`),
    `README.md Build & Test Commands must name npm run ${script}`,
  );
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
assert.match(architecture, phrase("separate storage", "i"));
assert.match(core, /MemoryService/);
assert.match(vscodeReadme, /confirmation/i);
assert.match(mcp, phrase("inline MCP App", "i"));
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
// Nothing scans for the removed HTTP-transport variables, so a guide that says
// the server rejects, refuses, aborts or errors on one describes a guard that
// does not exist (the MCP guide used to list one, and SECURITY.md promised one).
// The removed names are the ones the Docker gate checks the image bakes none of;
// that list is read, not copied. A sentence is about them when it names one, says
// "removed ... variable/transport", pairs "network listener" with a variable, or
// (as "Setting one ...") points back at them; "They are rejected" is about them
// when the sentence before it was. A rejection verb that is negated ("does not
// reject", "so they are not rejected", "nothing rejects them") is the true claim
// and is allowed.
const dockerGate = await readFile(path.join(root, "scripts/docker-gate.mjs"), "utf8");
const removedList = /const removedEnvVars = \[([^\]]*)\]/.exec(dockerGate)?.[1] ?? "";
const removedVariables = [...removedList.matchAll(/"(RAGNAROK_[A-Z0-9_]+)"/g)].map((match) => match[1]);
assert.ok(
  removedVariables.includes("RAGNAROK_PORT") && removedVariables.includes("RAGNAROK_DEPLOYMENT_MODE"),
  "scripts/docker-gate.mjs must keep listing the removed HTTP-transport variables in removedEnvVars",
);
const namesRemovedVariable = new RegExp(`\\b(?:${removedVariables.join("|")})\\b`);
const aboutRemovedVariables = (sentence) =>
  namesRemovedVariable.test(sentence) ||
  /\bremoved[- ](?:(?:HTTP|transport|environment|network)[- ])*(?:transport|variables?|listener)|\bsetting (?:one|any one|any of them)\b/i.test(
    sentence,
  ) ||
  (/\bnetwork listener\b/i.test(sentence) && /\b(?:variables?|settings?|removed|transport)\b/i.test(sentence));
const rejectionVerbs =
  /\b(?:reject|refus|abort|error|invalid|terminat|crash)\w*|\bfail(?:s|ed|ing|ure)?\b|\bexit(?:s|ed|ing)?\b/gi;
const negation = /\b(?:no|not|never|nothing|neither|nor|cannot|without)\b|n't\b/i;
const claimsRejection = (sentence) =>
  [...sentence.matchAll(rejectionVerbs)].some(
    (verb) =>
      !negation.test(
        sentence
          .slice(0, verb.index)
          .split(/[;:]|\b(?:and|but|so|yet|then)\b/)
          .pop(),
      ),
  );
for (const relative of canonical) {
  const sentences = (await readFile(path.join(root, relative), "utf8")).replace(/\s+/g, " ").split(/(?<=[.!?])\s/);
  sentences.forEach((sentence, index) => {
    const continuesPrevious =
      /^(?:they|these|those|such|each|this|doing so)\b/i.test(sentence) &&
      aboutRemovedVariables(sentences[index - 1] ?? "");
    assert.ok(
      !((aboutRemovedVariables(sentence) || continuesPrevious) && claimsRejection(sentence)),
      `${relative} says removed HTTP-transport variables are rejected or cause an error, but nothing reads or rejects them: "${sentence.slice(0, 80)}"`,
    );
  });
}
assert.match(
  release,
  phrase("second server sharing the volume"),
  "docs/RELEASE.md must say the Docker gate checks that a second server shares the volume",
);
assert.doesNotMatch(
  release,
  phrase("storage locking"),
  "docs/RELEASE.md must not list storage locking in the Docker gate",
);
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
