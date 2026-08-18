# @ragnarok/vscode

VS Code extension for RAGnarōk. Wires `@ragnarok/core` to VS Code APIs via
thin adapter classes, providing a full RAG-powered Copilot tool, sidebar UI,
and command palette integration.

The extension requires VS Code 1.105 or newer. The optional
`vscode.lm.computeEmbeddings` integration is a proposed API and additionally
requires a compatible VS Code build, explicit proposed-API enablement, and a
registered provider. The local HuggingFace backend remains the supported
fallback.

The extension creates memory storage under `context.globalStorageUri` and uses
core `MemoryService`; it does not open the MCP server's configured storage root.
There is no cross-host data sharing with MCP.

Release VSIX files are built for Linux, macOS, and Windows on x64 and arm64.
Each exact VSIX must pass install/activation/native-load smoke testing on its
target; see the repository [release procedure](../../docs/RELEASE.md).

---

## Architecture

```mermaid
flowchart LR
  subgraph VS Code Extension Host
    ext["extension.ts\n(activate)"]

    subgraph Adapters
      cfg["VsCodeConfigProvider"]
      log["VsCodeLoggerFactory"]
      ntf["VsCodeNotifier"]
      llm["VsCodeLLMProvider"]
    end

    subgraph Components
      tool["ragTool.ts\n(ragQuery)"]
      topic["topicTool.ts\n(ragTopic)"]
      cmd["commands.ts\n(20+ commands)"]
      tree["topicTreeView.ts\n(topics + config sidebar)"]
      lmb["vscodeLmBackend.ts\n(proposed embeddings)"]
      ghm["githubTokenManager.ts"]
      memory["memoryTools.ts\n(ragMemory)"]
      mtree["memoryTreeView.ts\n(memory sidebar + reset)"]
      graph["memoryGraphCommand.ts\n(command + webview)"]
    end
  end

  subgraph "@ragnarok/core"
    core["Portable RAG engine"]
  end

  ext --> cfg & log & ntf & llm
  cfg -- "IConfigProvider" --> core
  log -- "ILoggerFactory" --> core
  ntf -- "INotifier" --> core
  llm -- "ILLMProvider" --> core

  ext --> tool & topic & cmd & tree & memory & mtree & graph
  tool --> core
  topic --> core
  memory --> core
  mtree --> core
  cmd --> core
```

---

## Module Layout

```
src/
├── extension.ts            # Activation entry point — creates adapters, wires core
├── index.ts                # Barrel export
├── constants.ts            # Commands, views, context keys (extends core constants)
├── ragTool.ts              # Copilot LM tool (ragQuery), per-topic RAGAgent cache
├── topicTool.ts            # Read-only Copilot LM tool (ragTopic): list and stats
├── commands.ts             # 20+ VS Code commands
├── topicTreeView.ts        # Topics & config sidebar tree view providers
├── vscodeLmBackend.ts      # Proposed vscode.lm.computeEmbeddings backend
├── githubTokenManager.ts   # GitHub PAT management via SecretStorage
├── memoryTools.ts          # Native ragMemory language-model tool
├── memoryTreeView.ts       # Memory sidebar section: stats, refresh, confirmed reset
├── memoryHostContext.ts    # Resolves the workspace/branch context memory runs against
├── toolRegistrationHost.ts # Injectable vscode.lm seam every LM tool registers through
├── memoryGraphCommand.ts   # RAGnarok: Show Memory Graph command
├── memoryGraphPanel.ts     # CSP-restricted local graph webview
├── extensionLifecycle.ts   # Startup/shutdown gating and cancellable operation runner
├── migrationUx.ts          # Storage migration preview and apply prompts
├── workspaceContext.ts      # Workspace file discovery for context enrichment
│
└── adapters/
    ├── index.ts
    ├── vsCodeConfigProvider.ts   # IConfigProvider → vscode.workspace.getConfiguration
    ├── vsCodeLogger.ts           # ILoggerFactory → vscode.window.createOutputChannel
    ├── vsCodeNotifier.ts         # INotifier → vscode.window.show*Message / withProgress
    └── vsCodeLLMProvider.ts      # ILLMProvider → vscode.lm.selectChatModels
```

---

## Adapters

Each adapter maps one `@ragnarok/core` interface to the corresponding VS Code
API, keeping the core completely decoupled from the extension host.

| Adapter                                | Core Interface               | VS Code API                                                          |
| -------------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `VsCodeConfigProvider`                 | `IConfigProvider`            | `vscode.workspace.getConfiguration("ragnarok")`                      |
| `VsCodeLoggerFactory` / `VsCodeLogger` | `ILoggerFactory` / `ILogger` | `vscode.window.createOutputChannel("RAGnarōk")`                      |
| `VsCodeNotifier`                       | `INotifier`                  | `vscode.window.show{Info,Warning,Error}Message()` + `withProgress()` |
| `VsCodeLLMProvider`                    | `ILLMProvider`               | `vscode.lm.selectChatModels()`                                       |

---

## Key Components

### `extension.ts`

Activation entry point. Creates all adapters, initialises the
`EmbeddingService` and `TopicManager`, registers commands, tree views, and the
Copilot LM tool. Installs the VS Code logger factory with `setLoggerFactory()`
before any other code runs.

### `ragTool.ts`

Registers a Copilot Language Model tool (`ragQuery`) via `vscode.lm.registerTool`
and delegates to core's `executeQueryTool`, the same executor behind the MCP
server's `rag_query`. Its `RAGQueryService` maintains an LRU cache of up to 10
`RAGAgent` instances (one per topic) to avoid re-initialising vector stores on
every invocation.

### `topicTool.ts`

Registers the read-only `ragTopic` tool. Copilot may `list` topics or read one
topic's `stats` (statistics plus indexed documents) and nothing else — creating,
renaming, exporting, importing, and deleting topics stay sidebar commands so a
human confirms them. The read half calls core's `executeTopicRead`, the same
executor behind `rag_topic`'s `list` and `stats`, so both hosts return identical
payloads.

### Tool input schemas

The extension contributes exactly three language-model tools — `ragQuery`,
`ragTopic`, and `ragMemory`. Their `inputSchema` blocks in the root
`package.json` are generated, not hand-written: `npm run tools:manifest` writes
them from the canonical JSON Schema contracts in `@ragnarok/core`
(`src/tools/toolContracts.ts`), and `npm run tools:manifest:check` fails on
drift. Edit the contracts, then regenerate.

### Memory tools and graph

`ragMemory` exposes the shared core memory actions — store, recall, forget,
list, stats, decay, history, promote, links, communities — as a native Copilot
language-model tool, normalising its input with core's `normalizeMemoryInput`
before calling the same `MemoryService.execute` the MCP server calls. There is
no reset tool: an irreversible wipe of every memory in the extension location is
**Reset Memory** in the sidebar's Memory section, which asks for a modal
confirmation from the user. A model-generated boolean cannot stand in for
approval, so the model has no path to it at all.

Run **RAGnarok: Show Memory Graph** from the Command Palette, or from the Memory
view's title bar, to choose workspace or current-branch memory and open the
interactive webview. The webview receives validated graph documents over
`postMessage`, announces readiness before the host sends data, uses only packaged
`media/memoryGraph.js` and `media/memoryGraph.css`, and has no network access. It
does not invoke MCP or read MCP storage.

### `memoryTreeView.ts`

Provides the **Memory** sidebar view (`ragMemory`): a row per memory statistic —
totals, per-scope counts, the detected branch, entity and relationship counts,
and when memory was last updated — with **Show Memory Graph**, **Refresh
Memory**, and **Reset Memory** in the view title. A store holding nothing renders
the view's welcome content instead of eight zero rows. Counts can go stale after
Copilot writes through `ragMemory`; Refresh is the recovery, and Reset refreshes
on completion.

### `commands.ts`

Registers 20+ commands under the `ragnarok.*` namespace. Grouped by function:

| Category            | Commands                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| **Topics**          | `createTopic`, `deleteTopic`, `renameTopic`, `refreshTopics`                                   |
| **Documents**       | `addDocument`, `addGithubRepo`, `addWebUrl`                                                    |
| **Import / Export** | `exportTopic`, `importTopic`                                                                   |
| **Embedding**       | `setEmbeddingModel`, `selectHfEmbeddingModel`, `selectVscodeEmbeddingModel`, `clearModelCache` |
| **Configuration**   | `editConfigItem`, `selectLLMModel`                                                             |
| **GitHub tokens**   | `addGithubToken`, `listGithubTokens`, `removeGithubToken`                                      |
| **Maintenance**     | `clearDatabase`                                                                                |

The memory commands `showMemoryGraph`, `refreshMemory`, and `resetMemory` are in
the same `ragnarok.*` namespace but are registered by `memoryGraphCommand.ts` and
`memoryTreeView.ts`, not here.

### `topicTreeView.ts`

Provides two of the RAG sidebar's three tree views:

- **Topics** (`ragTopics`) — topic list with document counts, expand to see
  documents.
- **Configuration** (`ragConfig`) — live settings display (embedding model,
  retrieval strategy, chunk size, etc.).

The third, **Memory** (`ragMemory`), lives in `memoryTreeView.ts`.

### `vscodeLmBackend.ts`

An `EmbeddingBackend` implementation using the **proposed** `vscode.lm.computeEmbeddings`
API. Falls back to the HuggingFace backend when the proposed API is unavailable.

### `githubTokenManager.ts`

Manages GitHub personal access tokens via `vscode.SecretStorage`. Tokens are
used by the GitHub document loader for authenticated repository ingestion.
