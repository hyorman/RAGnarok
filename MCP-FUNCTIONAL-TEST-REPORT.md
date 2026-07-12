# MCP Server Full Functional Test Report

**Commit:** `0baa40541a24b2c0965ea70cd3129efa520d0620`  
**Date:** 2026-07-11  
**Server:** built `packages/mcp-server/dist/index.js`, version 0.4.0  
**Verdict:** **Not fully working; not release-ready.**

## Test approach

The built MCP server was launched as a real child process and driven through the MCP SDK over stdio and Streamable HTTP. Tests used temporary storage, real bundled HuggingFace embeddings, real LanceDB tables, three local fixture documents, server restarts, and real process signals.

All 13 registered tools were invoked. Retrieval was tested with `vector`, `hybrid`, `ensemble`, `bm25`, `graph`, and `graph_hybrid`. LangGraph was also enabled in a separate run.

To distinguish the retrieval implementation from the known reranker packaging failure, a second run temporarily exposed `model_quantized.onnx` under the `model.onnx` filename Transformers.js requests. The symlink was removed immediately afterward; this was a test-only bypass, not a source change or fix.

## Results summary

| Area | Result | Evidence |
|---|---|---|
| MCP initialization / `tools/list` | Pass | 13 tools returned; stdout remained protocol-clean |
| Topic list/create/stats | Pass | Topic created and persisted across restart |
| Document ingestion | **Partial failure** | TXT and HTML added; Markdown failed with Lance schema mismatch |
| Default RAG querying | **Fail** | All six strategies failed because bundled reranker requested missing `onnx/model.onnx` |
| Querying with reranker filename bypass | Pass | All six strategies returned two results |
| LangGraph with bypass | Pass with concerns | All six strategies returned results; every query ran three iterations and auto-wrote query memories |
| Real knowledge-graph traversal | Not proven | No external LLM configured, so entity extraction/KG construction did not occur; graph modes fell back |
| Embedding model list/info | Pass | 13 models listed; active HF model reported correctly |
| Switch embedding model | Pass for no-op switch | Switching to the already-active model succeeded |
| Reranker list/info | Pass | Correctly reported enabled but unavailable in default packaging |
| Switch reranker model | **Fail by default** | Same missing `model.onnx` error; passed only with filename bypass |
| LLM status | Pass | Correctly reported unavailable with provider `none` |
| Memory store/recall/list/stats | Pass in first process | Workspace and branch entries stored and recalled |
| Memory history | Pass basic case | One-version history returned |
| Memory decay | Pass basic/no-op case | Status returned; nothing old enough to decay |
| Memory links | Pass basic/no-entity case | Empty result returned without error |
| Memory promotion | Pass | Branch entry promoted to workspace |
| Memory persistence after first restart | Pass read-only | Three entries visible after restart |
| Memory mutation after restart | **Critical fail** | Arrow-vector schema inference error after table was dropped |
| Memory persistence after failed mutation | **Data loss** | Workspace entries disappeared; only branch entry survived second restart |
| Forget by ID after loss | Endpoint pass, behavior blocked | Returned zero because target workspace entry had already been deleted by the persistence failure |
| Forget expired | Pass basic/no-op case | Returned zero |
| HTTP health | Pass | `/health` returned status `ok`, version 0.4.0 |
| HTTP API-key authentication | Pass | Missing and wrong bearer tokens returned 401 |
| HTTP concurrent sessions | Pass | Two clients each saw all 13 tools; terminating one did not break the other |
| HTTP authenticated tool call | Pass | `rag_list_topics` succeeded through authenticated session |
| HTTP graceful SIGTERM | **Fail, reproduced 2/2** | Process exited via `SIGABRT`, not code 0 |
| HTTP stdout hygiene | Pass | Zero stdout bytes |
| Remote OpenAI/Ollama embeddings | Not tested | No endpoint/credentials supplied |
| OpenAI/Anthropic/Ollama LLM execution | Not tested | No endpoint/credentials supplied |

## Confirmed failures

### 1. Default querying is completely unavailable

Every `rag_query` strategy returned:

```text
Local file missing at ".../ms-marco-MiniLM-L-6-v2/onnx/model.onnx"
```

The package contains `model_quantized.onnx`. Once that exact artifact was temporarily made visible as `model.onnx`, all six retrieval strategies and the LangGraph query flow returned results. This isolates the main default-query failure to reranker loading/error handling rather than the first-stage retrievers.

### 2. Mixed-format ingestion is broken by metadata schema drift

The MCP request added TXT, Markdown, and HTML files sequentially. TXT created the initial LanceDB schema. Markdown then failed with:

```text
Found field not in schema: isMarkdown at row 0
```

HTML subsequently succeeded. The response reported partial success: two documents added and one failed. `normalizeDocumentMetadata()` filters fields but does not materialize a stable set of columns/default values, so the first document type determines a schema later types may not satisfy.

This contradicts the tool's advertised multi-format behavior and should be treated as a release blocker for ingestion.

### 3. Restart-time memory mutation destroys workspace persistence

Sequence tested:

1. Store workspace and branch memories.
2. Promote the branch memory into workspace.
3. Restart; all three persisted entries are visible.
4. Store another workspace memory.
5. Save fails with `Failed to infer data type for field vector.isValid`.
6. The same session's cache misleadingly lists four memories.
7. Restart again; all workspace memories are gone and only the branch entry remains.

This is confirmed durable data loss.

### 4. HTTP SIGTERM aborts in native code

Authentication, concurrent sessions, session termination, and tool calls all passed. On `SIGTERM`, however, the process exited with `SIGABRT` in two consecutive runs and logged:

```text
libc++abi: terminating due to uncaught exception of type std::__1::system_error:
mutex lock failed: Invalid argument
```

The shutdown path is therefore not graceful despite closing at the JavaScript layer. Native LanceDB/ONNX resource teardown and the immediate `process.exit(0)` call should be investigated.

## LangGraph observations

With the reranker filename bypass and `RAGNAROK_LANGGRAPH_ENABLED=true`:

- All six retrieval strategies returned results.
- A simple two-document query used all three configured iterations.
- `agenticMetadata.steps[].resultsCount` remained zero.
- Each query automatically stored a `Query: ... Top result: ...` memory. Six strategy checks inflated memory statistics from the two explicit memories to eight total entries.
- `graph` and `graph_hybrid` did not prove graph traversal because no LLM was available to build a knowledge graph; they returned fallback results.

## Working functionality

The following areas behaved correctly in real-process testing:

- MCP stdio handshake and protocol cleanliness.
- Tool discovery.
- Topic creation, listing, statistics, and restart persistence.
- File allowlisting and per-file partial result reporting.
- First-process memory store, workspace/branch scoping, recall, listing, stats, history, decay reporting, promotion, and empty link discovery.
- Embedding/reranker information tools and LLM-unavailable reporting.
- HTTP health, bearer authentication, concurrent session isolation, explicit session termination, and authenticated tool invocation.

## Release recommendation

Do not release the MCP server until these four functional failures are fixed and covered by real-process CI:

1. Correct the Transformers.js v3 reranker loading option/filename and make failure degrade safely.
2. Normalize all document metadata into one stable LanceDB schema before mixed-format additions.
3. Convert Arrow vectors to arrays and replace destructive memory drop-then-create persistence.
4. Make HTTP shutdown exit cleanly with code 0 under active/previous sessions.

After those fixes, rerun the same workflow with an actual LLM provider to validate entity extraction, knowledge-graph persistence/traversal, memory entities/links, and LangGraph checkpoint behavior. Remote embedding providers also need a provider-backed contract test.
