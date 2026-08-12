<div align="center">
  <img src="./assets/icon.png" alt="RAGnarok icon" title="RAGnarok" width="120" height="120" />
  <h1>RAGnarōk <br/>Local, Agentic Knowledge RAG for VS Code</h2>
  <p><strong>Find precise answers from your files and repos using local embeddings, smart query planning, and embedded vector search.</strong></p>
</div>

RAGnarōk helps developers, knowledge workers, and enterprise teams search, summarize, review, and answer questions over local documents, repositories, and the active VS Code workspace — with privacy and compliance in mind. Use it fully offline with local Transformers.js embeddings and LanceDB storage, or enable optional LLM-based planning and evaluation via VS Code Copilot models without any external API key for advanced query decomposition and result assessment.

Why install?

- Fast, private semantic search over PDFs, Markdown, HTML, and code
- Enterprise-friendly: per-topic stores, file-based persistence, and secure token handling for private repos
- Agentic query planning and evaluation: optionally use LLMs for decomposition, iterative refinement, and answer evaluation
- Include workspace context: surface relevant open files, symbols, and code snippets to enrich answers
- Code-review assistance: apply retrieved guidelines and documentation to review your code and get actionable suggestions
- Embedded LanceDB vector store — no external servers required
- Works offline with local Transformers.js embedding models

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![LangChain](https://img.shields.io/badge/LangChain.js-0.2-green.svg)](https://js.langchain.com/)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.105+-purple.svg)](https://code.visualstudio.com/)

---

## 🌟 Features

### 🧩 **Local Embedding Model Support**

- **Run embeddings locally**: Use Transformers.js models (ONNX/wasm) without external APIs.
- **Local model picker**: Load models from `ragnarok.localModelPath` and switch models in the tree view.
- **Offline & private**: Keep embeddings and inference on-device for privacy and compliance.
- **Default model included**: Ships with `Xenova/all-MiniLM-L6-v2` by default for fast, 384-dimension embeddings.

### 🔌 **Pluggable Embedding Backends**

RAGnarōk supports multiple embedding providers via a pluggable backend system:

| Mode            | Setting value    | Description                                                                                                 |
| --------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| **Auto**        | `auto` (default) | Tries registered backends in order; uses first available                                                    |
| **VS Code LM**  | `vscodeLM`       | Uses the proposed `vscode.lm.computeEmbeddings` API (requires a registered provider such as GitHub Copilot) |
| **HuggingFace** | `huggingface`    | Local Transformers.js ONNX/WASM inference — fully offline, no external services                             |
| **Remote**      | `remote`         | OpenAI or Ollama-compatible embedding API (MCP server only)                                                 |

**Configuration:**

- `ragnarok.embeddingBackend` — select `auto`, `vscodeLM`, `huggingface`, or any registered backend name
- `ragnarok.embeddingVscodeModelId` — (optional) specific VS Code LM model ID; leave blank to auto-select

**Prerequisites for VS Code LM embeddings:**

- VS Code Insiders (or any build that supports the proposed embeddings API)
- `"enabledApiProposals": ["embeddings"]` in the extension manifest (already configured)
- An embeddings provider registered at runtime (e.g., GitHub Copilot with embeddings support)

> ⚠️ **Known limitation:** The `vscode.lm.computeEmbeddings` API is a _proposed API_ and may not be available on stable VS Code builds. When using `auto` mode, the extension shows user-visible warning/info notifications and falls back to HuggingFace if the API is unavailable.

### 🔧 Enable VS Code LM embeddings (proposed API)

To use the VS Code Language Model embeddings API (`vscode.lm.computeEmbeddings`) you must enable proposed APIs for this extension and start the VS Code with the `--enable-proposed-api` flag referencing the extension id.

You can also add the same flag as a runtime argument in your VS Code.
`Ctrl+Shift+P` -> "Preferences: Configure Runtime Arguments" and add the following to the `argv.json`:

```json
{
  "enable-proposed-api": ["hyorman.ragnarok"]
}
```

Notes:

- If you run VS Code remotely (WSL/Containers), run the `code`/`code-insiders` command on the host where the Extension Host will run.
- After enabling proposed APIs restart the Extension Development Host.
- A proposed API requires a runtime provider (e.g., GitHub Copilot) — ensure the provider is installed and active.

### 🧠 **Agentic RAG with Query Planning**

- **Intelligent Query Decomposition**: Automatically breaks complex queries into sub-queries
  -- **LLM-Powered Planning**: Uses Copilot (VS Code LM API) models such as `gpt-4o` for advanced reasoning (Copilot required; no external API key). LLM usage is optional
- **Heuristic Fallback**: Works without LLM using rule-based planning
- **Iterative Refinement**: Confidence-based iteration for high-quality results
- **Parallel/Sequential Execution**: Smart execution strategy based on query complexity

### 🔍 **Multiple Retrieval Strategies**

- **Hybrid Search** (recommended): Combines vector + keyword (90%/10% weights, configurable)
- **Vector Search**: Pure semantic similarity using embeddings
- **BM25 Search**: Pure keyword search using Okapi BM25 algorithm (no embeddings needed)
- **Cross-Encoder Reranking**: Optional second-stage reranking over any strategy's candidates
- **Position Boosting**: Keywords near document start weighted higher
- **Result Explanations**: Human-readable scoring breakdown for all strategies

### 📚 **Document Processing**

- **Multi-Format Support**: PDF, Markdown, HTML, plain text, GitHub repositories
- **Semantic Chunking**: Automatic strategy selection (markdown/code/recursive)
- **Structure Preservation**: Maintains heading hierarchy and context
- **Batch Processing**: Multi-file upload with progress tracking
- **GitHub Integration**: Load entire repositories from GitHub.com or GitHub Enterprise Server
- **LangChain Loaders**: Industry-standard document loading

### 💾 **Vector Storage**

- **LanceDB**: Embedded vector database with file-based persistence (no server needed)
- **Cross-Platform**: Works on Windows, macOS, Linux, and ARM
- **Per-Topic Stores**: Efficient isolation and management
- **Serverless**: Truly embedded, like SQLite for vectors
- **Caching**: Optimized loading and reuse

### 🎨 **Enhanced UI**

- **Configuration View**: See agentic settings at a glance
- **Embedding Model Picker**: Tree view lists curated + local models (from `ragnarok.localModelPath`) with download status; click to switch
- **Statistics Display**: Documents, chunks, store type, model info
- **Progress Tracking**: Real-time updates during processing
- **Rich Icons**: Visual hierarchy with emojis and theme icons

### 🛠️ **Developer Experience**

- **Comprehensive Logging**: Debug output at every step
- **Type-Safe**: Full TypeScript with strict mode
- **Error Handling**: Robust error recovery throughout
- **Async-Safe**: Mutex locks prevent race conditions
- **Configurable**: 15+ settings for customization

### 🧠 **Standalone Memory Module**

- **Persistent Project Memory**: Store and recall facts, preferences, conventions, and context across sessions — scoped to workspace or git branch
- **Automatic Git Branch Detection**: Memories can be scoped per branch via `GitBranchDetector`, auto-detecting the current branch from the working directory
- **Vector-Based Recall + Entity Graph**: Memories are embedded and stored in a dedicated LanceDB instance; an entity graph (graphology) tracks relationships between extracted concepts
- **LLM-Powered Entity Extraction**: Optionally extracts entities (facts, preferences, concepts, tools, conventions) from stored memories; the graph stays empty when no LLM provider is configured
- **Markdown Export**: Automatically generates a `memories.md` file summarizing stored memories for human review
- **MCP Integration**: Exposed as the `rag_memory` tool with store, recall, forget, stats, list, decay, history, promote, link, and community operations. `communities` clusters the memory entity graph and requires an LLM provider — without one the tool says so instead of returning an empty result. Memory TTL is supported; reserved `auto:` memories are hidden unless explicitly requested. Memory is written and recalled only through explicit `rag_memory` calls — there is no automatic query-time recall or write-back.

#### MCP memory graph visualization

Graphs exist only in the memory subsystem. There is no document knowledge
graph, no entity extraction over ingested documents, and no `graph` or
`graph_hybrid` retrieval strategy.

The `rag_graph_visualize` tool exports the local user's own memory graph. It
accepts exactly
`{ source: "memory", memoryScope: "workspace", maxNodes? }` or
`{ source: "memory", memoryScope: "branch", branch, maxNodes? }` and returns the
deterministic `ragnarok.graph.visualization.v1` document. The default is 500
nodes, the accepted range is 1 through 2,000, and output is capped at 10,000
edges and the MCP response-byte limit. Failures surface as
`GRAPH_VISUALIZATION_RECORD_TOO_LARGE` or `GRAPH_VISUALIZATION_FAILED`; an empty
or unknown scope returns an empty document rather than fabricated data.

Documents include full persisted node/edge descriptions, provenance,
confidence, scope/branch fields, and arbitrary metadata, but never embedding
vectors. MCP Apps hosts load the self-contained `ui://ragnarok/graph` resource
as `text/html;profile=mcp-app` via modern `_meta.ui.resourceUri`. The app
provides loading, empty, error, keyboard, screen-reader, touch, detail-panel,
and viewport reset behavior. The VS Code extension webview remains deferred. See
the [MCP server graph contract](packages/mcp-server/README.md#memory-graph-visualization).

---

## 🚀 Quick Start

### Installation

#### From Source

```bash
git clone https://github.com/hyorman/ragnarok.git
cd ragnarok
npm install
npm run compile
# Press F5 to run in development mode
```

#### From VSIX

```bash
code --install-extension ragnarok-0.1.6.vsix
```

### Basic Usage

#### 0. (Optional) Choose/prepare your embedding model

- Default: `Xenova/all-MiniLM-L6-v2`
- Offline/local: set `ragnarok.localModelPath` to a folder containing Transformers.js-compatible models (each model in its own subfolder). The tree view will list those models alongside curated ones; click any entry to load it.
- When you change the embedding model, existing topics keep their original embeddings—create a new topic if you need to ingest with the new model.

#### 1. Create a Topic

```
Cmd/Ctrl+Shift+P → RAG: Create New Topic
```

Enter name (e.g., "React Docs") and optional description.

#### 2. Add Documents

```
Cmd/Ctrl+Shift+P → RAG: Add Document to Topic
```

Select topic, then choose one or more files. The extension will:

- Load documents using LangChain loaders
- Apply semantic chunking
- Generate embeddings
- Store in vector database

**Supported formats**: `.pdf`, `.md`, `.html`, `.txt`

#### 2b. Add GitHub Repository

```
Cmd/Ctrl+Shift+P → RAG: Add GitHub Repository to Topic
```

Or right-click a topic in the tree view and select the GitHub icon. You can:

- **GitHub.com or GitHub Enterprise Server**: Choose between public GitHub or your organization's GitHub Enterprise Server
- Enter repository URL:
  - GitHub.com: `https://github.com/facebook/react`
  - GitHub Enterprise: `https://github.company.com/team/project`
- Specify branch (defaults to `main`)
- Configure ignore patterns (e.g., `*.test.js, docs/*`)
- Add access token for private repositories (see [Token Management](#github-token-management) below)

The extension will recursively load all files from the repository and process them just like local documents.

**Note**: Supports GitHub.com and GitHub Enterprise Server only. The repository must be accessible from your network. For other Git hosting services (GitLab, Bitbucket, etc.), clone the repository locally and add it as local files.

#### 2c. GitHub Token Management

For accessing private repositories, RAGnarōk securely stores GitHub access tokens per host using VS Code's Secret Storage API.

**Add a Token:**

```
Cmd/Ctrl+Shift+P → RAG: Add GitHub Token
```

1. Enter the GitHub host (e.g., `github.com`, `github.company.com`)
2. Paste your GitHub Personal Access Token (PAT)
3. The token is securely stored and automatically used for that host

**List Saved Tokens:**

```
Cmd/Ctrl+Shift+P → RAG: List GitHub Tokens
```

Shows all hosts with saved tokens (tokens themselves are never displayed).

**Remove a Token:**

```
Cmd/Ctrl+Shift+P → RAG: Remove GitHub Token
```

Select a host to remove its stored token.

#### 2d. Export and Import Topics

**Export a Topic:**

```
Cmd/Ctrl+Shift+P → RAG: Export Topic
```

Or select a topic in the tree view and select the export icon. This creates a portable archive containing:

- Topic metadata (name, description)
- Vector embeddings and documents
- Model configuration

Exported topics can be shared with teammates or imported into other workspaces.

**Import a Topic:**

```
Cmd/Ctrl+Shift+P → RAG: Import Topic
```

Or click the import icon in the tree view title bar. Select an exported topic archive to restore it into your workspace.

**Rename a Topic:**

```
Cmd/Ctrl+Shift+P → RAG: Rename Topic
```

Or select a topic in the tree view and click the edit icon.

**How to Create a GitHub PAT:**

1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Click "Generate new token (classic)"
3. Select the `repo` scope
4. Generate and copy the token
5. Use the "RAG: Add GitHub Token" command to save it

**Benefits:**

- ✅ Tokens stored securely in VS Code's Secret Storage (not in settings.json)
- ✅ Support for multiple GitHub hosts (GitHub.com + multiple Enterprise servers)
- ✅ Automatic token selection based on repository URL
- ✅ No need to enter token every time you add a repository

#### 2e. Using Common/Shared Databases

RAGnarōk supports read-only access to shared team knowledge bases via the `ragnarok.commonDatabasePath` setting.

**Setup:**

1. Export topics from a source workspace
2. Place exported topic archives in a shared location (network drive, shared folder)
3. Configure `ragnarok.commonDatabasePath` to point to this folder:

```json
{
  "ragnarok.commonDatabasePath": "/path/to/shared/rag-databases"
}
```

**Benefits:**

- ✅ Share curated knowledge bases across teams
- ✅ Read-only topics prevent accidental modification
- ✅ Centralized documentation and policy storage
- ✅ Works with any file-sharing system

**Note**: Topics from common database path appear in the tree view but cannot be deleted or modified.

#### 3. Query with Copilot

```
Open Copilot Chat (@workspace)
Type: @workspace #ragQuery What is [your question]?
```

The RAG tool will:

1. Match your topic semantically
2. Decompose complex queries (if agentic mode enabled)
3. Perform hybrid retrieval
4. Return ranked results with context

### Maintenance Commands

**Clear Model Cache:**

```
Cmd/Ctrl+Shift+P → RAG: Clear Model Cache
```

Removes cached embedding models. Useful when switching models or troubleshooting.

**Clear Database:**

```
Cmd/Ctrl+Shift+P → RAG: Clear Database
```

⚠️ **Warning**: Deletes all topics and documents. This action cannot be undone.

**Refresh Topics:**

```
Cmd/Ctrl+Shift+P → RAG: Refresh Topics
```

Reloads the topic tree view. Useful after importing topics or external changes.

---

## ⚙️ Configuration

### Basic Settings

```json
{
  // Path to local Transformers.js embedding model folder
  "ragnarok.localModelPath": "",

  // Number of results to return
  "ragnarok.topK": 5,

  // Chunk size for splitting documents
  "ragnarok.chunkSize": 512,

  // Chunk overlap for context preservation
  "ragnarok.chunkOverlap": 50,

  // Retrieval strategy: vector, hybrid, bm25
  "ragnarok.retrievalStrategy": "hybrid",

  // Path to shared/common RAG database (read-only topics)
  "ragnarok.commonDatabasePath": ""
}
```

**Note**: GitHub access tokens are now managed via secure Secret Storage, not settings.json. See [GitHub Token Management](#github-token-management) section.

### Query Settings

```json
{
  // Maximum refinement iterations (1-10)
  "ragnarok.maxIterations": 3,

  // Confidence threshold (0-1) for stopping iteration
  "ragnarok.confidenceThreshold": 0.7,

  // LLM model: gpt-4o, gpt-4o-mini, gpt-3.5-turbo
  "ragnarok.llmModel": "gpt-4o",

  // Include workspace context (selected code, active file, imports, symbols)
  "ragnarok.includeWorkspaceContext": true
}
```

Set `ragnarok.localModelPath` to point at a folder that already contains compatible Transformers.js models (one subfolder per model—e.g., an ONNX export downloaded ahead of time). Entries found here appear in the tree view and can be selected directly, and this local path takes precedence over `ragnarok.embeddingModel`.

**Available Embedding Models to Download** (local, no API needed):

- `Xenova/all-MiniLM-L6-v2` (default) - Fast, 384 dimensions
- `Xenova/all-MiniLM-L12-v2` - More accurate, 384 dimensions
- `Xenova/paraphrase-MiniLM-L6-v2` - Optimized for paraphrasing
- `Xenova/multi-qa-MiniLM-L6-cos-v1` - Optimized for Q&A

_The extension ships with `Xenova/all-MiniLM-L6-v2` by default; to use other local models, set `ragnarok.localModelPath` or click the model name in tree view._

Any models you place under `ragnarok.localModelPath` show up in the tree view alongside these curated options (with download indicators) and can be loaded with one click.

**LLM Models** (when agentic planning is enabled): models are available via VS Code Copilot / LM API (no external API key required).

- `gpt-4o` (default) - Most intelligent
- `gpt-4o-mini` - Faster, still capable
- `gpt-3.5-turbo` - Fastest, most economical

---

## 📦 Project Structure

RAGnarōk is organized as an **npm workspaces monorepo** with three packages:

```
copilot-rag/
├── packages/
│   ├── core/          # @ragnarok/core — portable RAG engine (no VS Code dependency)
│   ├── vscode/        # @ragnarok/vscode — VS Code extension adapters and UI
│   └── mcp-server/    # @ragnarok/mcp-server — MCP server for CLI/TUI/GUI agents
├── test/              # VS Code extension test infrastructure and fixtures
├── assets/            # Extension icon and bundled embedding models
└── scripts/           # Build and packaging helpers
```

| Package                    | Description                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`@ragnarok/core`**       | Loaders, chunkers, embeddings, retrievers, agents, stores — all platform-agnostic with dependency injection                                                 |
| **`@ragnarok/vscode`**     | VS Code adapters (`IConfigProvider`, `ILogger`, `INotifier`, `ILLMProvider`), commands, tree view, and extension entry point                                |
| **`@ragnarok/mcp-server`** | Exposes RAG and memory tools via the [Model Context Protocol](https://modelcontextprotocol.io) — works with any MCP-compatible agent (stdio transport only) |

### MCP 0.7.0 protocol

RAGnarok 0.7.0 serves MCP protocol `2026-07-28` only. Clients must use
`server/discover` or modern version negotiation; legacy `initialize` is
rejected. There is no compatibility mode and no `Mcp-Session-Id`.

**Stdio is the only transport.** The HTTP transport, shared deployment mode,
bearer roles, and upload/download handles were removed; the server is a child
process of one MCP client, running as the user who spawned it. Environment
variables belonging to the removed transport are rejected at startup, with an
error naming every one that was set. Cacheable discovery,
list, and resource-read results advertise `ttlMs=0` and `cacheScope=private`.
See the [MCP server guide](packages/mcp-server/README.md) for the complete tool
surface and configuration.

MCP server settings live in `config.json` in the storage directory, which the
server generates on first run. That file is the only place they are set — a key
present in it pins your value, a key absent uses the current built-in default,
and there is no environment variable for any of them. The environment carries
only credentials, the two bootstrap paths, and the two one-shot switches. The
[key table](packages/mcp-server/README.md#configuration) lists both sets.

_(These are the MCP server's settings. The VS Code extension is configured
separately through the `ragnarok.*` settings above.)_

### Build & Test Commands

```bash
npm install              # Install all workspace dependencies
npm run compile          # Build all packages (tsc -b)
npm run test:all         # Run all tests (core → vscode → mcp-server)
npm run test:core        # Run core package tests only
npm test                 # Run VS Code extension tests only
npm run test:mcp         # Run MCP server tests only
npm run bench:smoke      # Fast deterministic retrieval/reranker gate
npm run bench:release    # Pinned release benchmark; missing inputs fail
npm run test:docs        # Validate canonical documentation links/contracts
npm run lint             # Lint all packages
npm run format           # Format all source and test files
npm run clean            # Clean all build artifacts
```

### MCP Tools

The MCP server exposes these tools to any MCP-compatible agent:

| Tool                         | Description                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `rag_query`                  | Query a topic with agentic RAG (supports all retrieval strategies)                       |
| `rag_list_topics`            | List available topics                                                                    |
| `rag_topic_stats`            | Get statistics for a topic                                                               |
| `rag_create_topic`           | Create a new topic                                                                       |
| `rag_add_documents`          | Add documents to a topic                                                                 |
| `rag_list_embedding_models`  | List available embedding models                                                          |
| `rag_embedding_info`         | Get current embedding model info                                                         |
| `rag_switch_embedding_model` | Switch the active embedding model                                                        |
| `rag_llm_status`             | Get current LLM provider status                                                          |
| `rag_memory`                 | Store, recall, forget, list, or get stats for project memories (workspace/branch-scoped) |
| `rag_list_documents`         | List stable source documents in a topic                                                  |
| `rag_delete_topic`           | Delete a topic after explicit confirmation                                               |
| `rag_remove_document`        | Remove a document and reconcile its chunks                                               |
| `rag_rename_topic`           | Rename a topic                                                                           |
| `rag_add_url`                | Securely ingest a public HTTP(S) page                                                    |
| `rag_add_github_repo`        | Ingest an allowlisted GitHub/GHES repository                                             |
| `rag_export_topic`           | Export a checksummed storage-v2 `.rag` archive                                           |
| `rag_import_topic`           | Validate and import a `.rag` archive                                                     |
| `rag_reset_memory`           | Reset incompatible or unwanted standalone memory after confirmation                      |
| `rag_storage_status`         | Inspect storage-format readiness and reset requirements                                  |
| `rag_list_reranker_models`   | List available cross-encoder reranker models                                             |
| `rag_reranker_info`          | Get current reranker configuration and status                                            |
| `rag_switch_reranker_model`  | Switch the cross-encoder reranker model                                                  |
| `rag_graph_visualize`        | Return a deterministic memory graph document and associate the MCP App                   |

That is the complete surface: 24 tools, all registered unconditionally on every
connection. There are no roles and no capability tiers — the client already runs
with the owner's authority. Parameters and error contracts are in the
[MCP server guide](packages/mcp-server/README.md).

### Storage compatibility

Version 0.4.0 uses storage format v2 and `.rag` archive format 2.0. New empty installations initialize automatically. Non-empty 0.3/unversioned storage fails closed and must be converted with the supported offline migrator; VS Code offers a preview before migration and never silently resets it. See [MIGRATION.md](MIGRATION.md). Embedding fingerprints are persisted per topic and memory store so incompatible semantic spaces are rejected even when dimensions happen to match.

**Single-writer constraint:** Only one process (VS Code window, MCP server
instance, or CLI tool) may access a storage directory at a time. A second
process fails fast instead of silently corrupting data. See
[the architecture](ARCHITECTURE.md#storage) for the complete concurrency and
locking model.

### Delivery and operations

- [Architecture](ARCHITECTURE.md)
- [Storage migration](MIGRATION.md)
- [Operations and recovery](docs/OPERATIONS.md)
- [Security](docs/SECURITY.md)
- [Benchmark gates](docs/BENCHMARKS.md)
- [Release evidence and publication](docs/RELEASE.md)

Release evidence is truthful by construction: required jobs are recorded as
passed, failed, or unrun. Docker runtime and all six installed VSIX platform
combinations are release blockers until their designated CI environments
execute them; a local compile or package build does not imply those gates
passed. The release benchmark also exits nonzero with `status: "blocked"` when
child-process peak RSS, isolated index time, or exact package-size
measurements are absent; deterministic smoke tests do not stand in for those
declared measurements.

---

## 🏗️ Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────┐
│                   VS Code Extension                 │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─────────────┐  ┌──────────────┐   ┌────────────┐ │
│  │ Commands    │  │ Tree View    │   │ RAG Tool   │ │
│  │ (UI)        │  │ (UI)         │   │ (Copilot)  │ │
│  └─────┬───────┘  └──────┬───────┘   └─────┬──────┘ │
│        │                 │                 │        │
│  ┌─────┴─────────────────┴─────────────────┴──────┐ │
│  │              Topic Manager                     │ │
│  │  (Topic lifecycle, caching, coordination)      │ │
│  └─────┬──────────────────────────────────┬───────┘ │
│        │                                  │         │
│  ┌─────┴─────────┐                 ┌──────┴───────┐ │
│  │ Document      │                 │ RAG Agent    │ │
│  │ Pipeline      │                 │ (Orchestr.)  │ │
│  └┬─────────┬────┘                 └┬─────────┬───┘ │
│   │         │                       │         │     │
│ ┌─┴────┐ ┌──┴────┐           ┌──────┴──┐ ┌────┴───┐ │
│ │Loader│ │Chunker│           │ Planner │ │Retriev.│ │
│ │      │ │       │           │         │ │        │ │
│ └──┬───┘ └───┬───┘           └────┬────┘ └───┬────┘ │
│    │         │                    │          │      │
│  ┌─┴─────────┴────┐          ┌────┴──────────┴────┐ │
│  │ Embedding      │          │ Vector Store       │ │
│  │ Service        │          │ (LanceDB)          │ │
│  │ (Local Models) │          │ (Embedded DB)      │ │
│  └────────────────┘          └────────────────────┘ │
│                                                     │
└─────────────────────────────────────────────────────┘
                          │
                   ┌──────┴───────┐
                   │ LangChain.js │
                   │ (Foundation) │
                   └──────────────┘
```

---

## 🎯 How It Works

### Agentic Query Flow

```
User Query: "Compare React hooks vs class components"
    ↓
┌───┴────────────────────────────────────────┐
│ 1. Topic Matching (Semantic Similarity)    │
│    → Finds best matching topic             │
└───┬────────────────────────────────────────┘
    ↓
┌───┴────────────────────────────────────────┐
│ 2. Query Planning (LLM or Heuristic)       │
│    Complexity: complex                     │
│    Sub-queries:                            │
│    - "React hooks features and usage"      │
│    - "React class components features"     │
│    Strategy: parallel                      │
└───┬────────────────────────────────────────┘
    ↓
┌───┴────────────────────────────────────────┐
│ 3. Hybrid Retrieval (for each sub-query)   │
│    Vector search: 70% weight               │
│    Keyword search: 30% weight              │
│    → Returns ranked results                │
└───┬────────────────────────────────────────┘
    ↓
┌───┴────────────────────────────────────────┐
│ 4. Iterative Refinement (if enabled)       │
│    Check confidence: 0.65 < 0.7            │
│    → Refine query and retrieve again       │
│    Check confidence: 0.78 ≥ 0.7 ✓          │
└───┬────────────────────────────────────────┘
    ↓
┌───┴────────────────────────────────────────┐
│ 5. Result Processing                       │
│    - Deduplicate by content hash           │
│    - Rank by score                         │
│    - Limit to topK                         │
└───┬────────────────────────────────────────┘
    ↓
Return: Ranked results with metadata
```

### Document Processing Flow

```
User uploads: document1.pdf, document2.md
    ↓
┌───┴────────────────────────────────────────┐
│ 1. Document Loading (LangChain Loaders)    │
│    PDF: PDFLoader                          │
│    MD: TextLoader                          │
│    HTML: CheerioWebBaseLoader              │
│    → Returns Document[] with metadata      │
└───┬────────────────────────────────────────┘
    ↓
┌───┴────────────────────────────────────────┐
│ 2. Semantic Chunking                       │
│    Strategy selection:                     │
│    - Markdown: MarkdownTextSplitter        │
│    - Code: RecursiveCharacterTextSplitter  │
│    - Other: RecursiveCharacterTextSplitter │
│    → Preserves headings and structure      │
└───┬────────────────────────────────────────┘
    ↓
┌───┴────────────────────────────────────────┐
│ 3. Embedding Generation (Batched)          │
│    Model: Xenova/all-MiniLM-L6-v2 (local)  │
│    Batch size: 32 chunks                   │
│    → Generates 384-dim vectors             │
└───┬────────────────────────────────────────┘
    ↓
┌───┴────────────────────────────────────────┐
│ 4. Vector Storage                          │
│    LanceDB embedded database               │
│    → Stores embeddings + metadata          │
└───┬────────────────────────────────────────┘
    ↓
Complete: Documents ready for retrieval
```

---

## 📊 Performance

Performance depends on CPU architecture, model revision, corpus, storage, and
Node version. Reproducible smoke and release-grade benchmark commands, pinned
inputs, quality thresholds, latency/memory/package budgets, and the reviewed
baseline update process are documented in
[docs/BENCHMARKS.md](docs/BENCHMARKS.md). Historical approximate timings are
not treated as release evidence.

### Optimization Tips

1. **Use local embeddings** for privacy and no API costs
2. **Enable agent caching** (automatic per topic)
3. **Adjust chunk size** based on document type
4. **Use simple mode** for fast queries
5. **Batch document uploads** for efficiency
6. **Measure your corpus** — capacity and latency are bounded by local storage,
   memory, native dependencies, and workload shape

---

## 🛠️ Troubleshooting

### Embedding Backend Issues

| Problem                                     | Solution                                                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **"No embeddings provider registered"**     | Ensure a provider (e.g., GitHub Copilot) is installed and active. Set `ragnarok.embeddingBackend` to `huggingface` as a workaround.                                                |
| **"Proposed API not enabled"**              | The `vscode.lm.computeEmbeddings` API requires `"enabledApiProposals": ["embeddings"]` in the extension manifest. Use VS Code Insiders for full support.                           |
| **VS Code LM embedding dimension mismatch** | Switching backends may change the embedding dimension. Existing vector stores need re-indexing after backend changes. Delete the topic and re-add documents.                       |
| **Fallback warnings appearing frequently**  | If you see repeated "falling back to HuggingFace" messages, either set `ragnarok.embeddingBackend` to `huggingface` explicitly, or check that your VS Code LM provider is running. |
| **Model not found in VS Code LM**           | Verify the model ID in `ragnarok.embeddingVscodeModelId` matches one listed in `vscode.lm.embeddingModels`. Leave blank to auto-select.                                            |

---

## 🧪 Testing

### Run Tests

```bash
npm test
```

---

## 🤝 Contributing

Open an issue before large changes and include the relevant compile, lint,
test, benchmark, migration, or packaging evidence with the pull request.

### Development Setup

```bash
git clone https://github.com/hyorman/ragnarok.git
cd ragnarok
npm install
npm run watch  # Watch mode for development
```

## 📄 License

MIT License - see [LICENSE](LICENSE) for details

---

## 🙏 Acknowledgments

Built with:

- [LangChain.js](https://js.langchain.com/) - Document processing framework
- [Transformers.js](https://huggingface.co/docs/transformers.js) - Local embeddings
- [LanceDB](https://lancedb.github.io/lancedb/) - Embedded vector database
- [VS Code Extension API](https://code.visualstudio.com/api) - Extension platform
- [VS Code LM API](https://code.visualstudio.com/api/extension-guides/language-model) - Copilot integration

---

<div align="center">
  <p>Made with ❤️ by the hyorman</p>
  <p>⭐ Star us on GitHub if you find this useful!</p>
</div>
