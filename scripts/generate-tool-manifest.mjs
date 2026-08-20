#!/usr/bin/env node
/**
 * Generates contributes.languageModelTools in the root package.json from the
 * canonical input contracts in @ragnarok/core. Run with --check in CI to fail
 * on drift.
 *
 * Presentation metadata (display names, icons, tags, the prose the model reads)
 * lives here rather than in core, so core stays host-neutral: the MCP server
 * describes the same contracts in its own protocol's vocabulary.
 *
 * Output format: JSON.stringify(..., null, 2) + "\n" is a fixed point of this
 * repo's prettier configuration for package.json (prettier's JSON printer keeps
 * already-expanded objects and arrays expanded), so `npm run tools:manifest`
 * followed by `npm run format` leaves `npm run tools:manifest:check` at exit 0.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractsPath = path.join(root, "packages/core/dist/tools/toolContracts.js");
const contracts = await import(contractsPath);

/**
 * Exactly the tools the extension registers. ragResetMemory is deliberately
 * absent: an irreversible memory wipe is a human action in the sidebar, not
 * something a model may decide to call.
 */
const TOOLS = [
  {
    name: "ragQuery",
    toolReferenceName: "ragQuery",
    displayName: "RAG Query",
    // No "check agenticMetadata" instruction: the canonical empty-topic payload
    // has no such field, so telling the model to always read it invites it to
    // report a missing field as a failure.
    modelDescription:
      "Query an indexed RAG topic to find relevant information. Use it when the user asks about material they have " +
      "added to RAGnarok. The topic is matched exactly when possible and otherwise by the closest semantic match, " +
      "reported in the 'topicMatched' field. Complex queries may be answered with multi-step agentic planning.",
    userDescription: "Search an indexed RAG topic",
    icon: "$(database)",
    canBeReferencedInPrompt: true,
    tags: ["documentation", "search", "copilot", "context", "rag"],
    inputSchema: contracts.RAG_QUERY_INPUT_SCHEMA,
  },
  {
    name: "ragMemory",
    toolReferenceName: "ragMemory",
    displayName: "RAG Memory",
    modelDescription:
      "Store, recall, forget, list, or inspect project memories scoped to the workspace or the current git branch.",
    userDescription: "Work with project memories",
    icon: "$(archive)",
    canBeReferencedInPrompt: true,
    tags: ["memory", "context", "rag"],
    inputSchema: contracts.RAG_MEMORY_INPUT_SCHEMA,
  },
  {
    name: "ragTopic",
    toolReferenceName: "ragTopic",
    displayName: "RAG Topics",
    modelDescription:
      "List the available RAG topics, or get one topic's statistics and indexed documents. Read-only: creating, " +
      "renaming, exporting, importing, and deleting topics are user actions in the RAGnarok sidebar.",
    userDescription: "List RAG topics and inspect one topic",
    icon: "$(list-tree)",
    canBeReferencedInPrompt: true,
    tags: ["documentation", "search", "rag"],
    inputSchema: contracts.RAG_TOPIC_READ_INPUT_SCHEMA,
  },
];

for (const tool of TOOLS) {
  if (!tool.inputSchema) {
    throw new Error(`No input schema exported from ${contractsPath} for ${tool.name}`);
  }
}

const manifestPath = path.join(root, "package.json");
const original = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(original);
const contributed = manifest.contributes.languageModelTools;
manifest.contributes.languageModelTools = TOOLS;
const updated = JSON.stringify(manifest, null, 2) + "\n";

if (process.argv.includes("--check")) {
  if (updated !== original) {
    // Distinguish the two ways this fails, because the fixes differ.
    const contributedMatches = JSON.stringify(contributed) === JSON.stringify(TOOLS);
    console.error(
      contributedMatches
        ? "package.json languageModelTools is current but the file is not formatted. Run: npm run format"
        : "package.json languageModelTools is out of date. Run: npm run tools:manifest",
    );
    process.exit(1);
  }
  console.log("tool manifest up to date");
} else {
  writeFileSync(manifestPath, updated);
  console.log(`tool manifest written: ${TOOLS.length} tools`);
}
