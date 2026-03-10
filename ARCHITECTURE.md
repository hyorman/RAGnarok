# RAGnarōk — Architecture Documentation

## Table of Contents

- [1. System Overview](#1-system-overview)
- [2. High-Level Architecture](#2-high-level-architecture)
- [3. Document Ingestion Pipeline](#3-document-ingestion-pipeline)
- [4. Query Execution Pipeline](#4-query-execution-pipeline)
- [5. Iterative Refinement & Gap Analysis](#5-iterative-refinement--gap-analysis)
- [6. Embedding Subsystem](#6-embedding-subsystem)
- [7. Retrieval Strategies](#7-retrieval-strategies)
- [8. Class Diagram](#8-class-diagram)
- [9. Sequence Diagrams](#9-sequence-diagrams)
- [10. Storage & Persistence](#10-storage--persistence)
- [11. Configuration Reference](#11-configuration-reference)
- [12. Commands Reference](#12-commands-reference)

---

## 1. System Overview

RAGnarōk is a VS Code extension that implements a full Retrieval-Augmented Generation (RAG) pipeline, exposing a Copilot-compatible language model tool for agentic query processing. It supports multiple embedding backends, retrieval strategies, iterative refinement with LLM-powered gap analysis, and per-topic vector stores backed by LanceDB.

### Core Capabilities

| Capability | Description |
|---|---|
| **Multi-format ingestion** | PDF, Markdown, HTML, plain text, GitHub repos, web pages |
| **Semantic chunking** | Structure-aware splitting with heading metadata preservation |
| **Dual embedding backends** | HuggingFace Transformers.js (local ONNX) or VS Code LM API |
| **4 retrieval strategies** | Vector, Hybrid, Ensemble (RRF), BM25 |
| **Agentic query planning** | LLM-powered query decomposition with heuristic fallback |
| **Iterative refinement** | Gap analysis → follow-up query generation → convergence detection |
| **Per-topic isolation** | Independent vector stores, document caches, and metadata per topic |

---

## 2. High-Level Architecture

```mermaid
graph TB
    subgraph "VS Code Host"
        UI[Tree Views & Commands]
        Config[Configuration Panel]
    end

    subgraph "Extension Core"
        EXT[extension.ts<br/>Activation & Wiring]
        CMD[CommandHandler<br/>Command Registry]
        TOOL[RAGTool<br/>Copilot LM Tool]
    end

    subgraph "Agentic Layer"
        AGENT[RAGAgent<br/>Orchestrator]
        QP[QueryPlannerAgent<br/>Decomposition]
        LLM[VSCodeLLM<br/>LangChain Wrapper]
    end

    subgraph "Retrieval Layer"
        VR[VectorRetriever<br/>Semantic Search]
        KR[KeywordRetriever<br/>BM25 + Keyword Scoring]
        HR[HybridRetriever<br/>Weighted Score Fusion]
        ER[EnsembleRetriever<br/>RRF Rank Fusion]
    end

    subgraph "Embedding Layer"
        ES[EmbeddingService<br/>Backend Router]
        HF[HuggingFaceBackend<br/>Local ONNX/WASM]
        VLM[VscodeLmBackend<br/>Proposed API]
        MR[ModelRegistry<br/>Model Discovery]
    end

    subgraph "Storage Layer"
        TM[TopicManager<br/>Topic Lifecycle]
        DP[DocumentPipeline<br/>Ingestion Orchestrator]
        VSF[VectorStoreFactory<br/>LanceDB Manager]
        DLF[DocumentLoaderFactory<br/>Multi-Format Orchestrator]
        SC[SemanticChunker<br/>Structure-Aware Splitter]
    end

    subgraph "Persistence"
        LANCE[(LanceDB<br/>Vector Tables)]
        META[(JSON Files<br/>Topics Index & Metadata)]
    end

    UI --> CMD
    Config --> CMD
    EXT --> CMD
    EXT --> TOOL
    EXT --> TM
    EXT --> ES

    TOOL --> AGENT
    AGENT --> QP
    QP --> LLM
    AGENT --> HR
    AGENT --> ER
    AGENT --> BM

    HR --> ES
    ER --> BM

    ES --> HF
    ES --> VLM
    ES --> MR

    CMD --> TM
    TM --> DP
    TM --> VSF
    DP --> DLF
    DP --> SC
    DP --> ES
    DP --> VSF

    VSF --> LANCE
    TM --> META

    classDef core fill:#4a9eff,stroke:#2d7cd6,color:#fff
    classDef agent fill:#ff6b6b,stroke:#d64545,color:#fff
    classDef retrieval fill:#51cf66,stroke:#37b24d,color:#fff
    classDef embedding fill:#ffd43b,stroke:#f59f00,color:#333
    classDef storage fill:#845ef7,stroke:#7048e8,color:#fff
    classDef persist fill:#868e96,stroke:#495057,color:#fff

    class EXT,CMD,TOOL core
    class AGENT,QP,LLM agent
    class HR,ER,BM retrieval
    class ES,HF,VLM,MR embedding
    class TM,DP,VSF,DLF,SC storage
    class LANCE,META persist
```

---

## 3. Document Ingestion Pipeline

The ingestion pipeline transforms raw files into searchable vector embeddings stored in LanceDB.

### Flow Diagram

```mermaid
flowchart TD
    START([User adds document]) --> LOAD

    subgraph "Stage 1: Loading"
        LOAD{Detect file type}
        LOAD -->|.pdf| PDF[PdfDocumentLoader<br/>Page splitting]
        LOAD -->|.md .markdown| MD[MarkdownDocumentLoader<br/>isMarkdown flag]
        LOAD -->|.html .htm| HTML[HtmlDocumentLoader<br/>Regex tag stripping]
        LOAD -->|.txt .text| TXT[TextDocumentLoader<br/>Plain text]
        LOAD -->|github.com/...| GH[GithubDocumentLoader<br/>Clone & load]
        LOAD -->|https://...| WEB[WebDocumentLoader<br/>CheerioWebBaseLoader]
    end

    PDF & MD & HTML & TXT & GH & WEB --> ENRICH[Enrich metadata<br/>fileName, filePath, fileType,<br/>fileSize, source, loadedAt]

    subgraph "Stage 2: Chunking"
        ENRICH --> DETECT{Detect strategy}
        DETECT -->|markdown| MDS[MarkdownTextSplitter<br/>Heading-aware separators]
        DETECT -->|code| CODE[RecursiveCharacterTextSplitter<br/>Code-optimized]
        DETECT -->|text/html/pdf| REC[RecursiveCharacterTextSplitter<br/>General purpose]

        MDS & CODE & REC --> CHUNKS[Chunk Documents]
        CHUNKS --> META_ENRICH[Enrich chunk metadata<br/>chunkIndex, headingPath,<br/>sectionTitle, position]
    end

    subgraph "Stage 3: Embedding"
        META_ENRICH --> BATCH[Batch Processing<br/>batchSize: 32]
        BATCH --> EMBED{Active Backend}
        EMBED -->|HuggingFace| HF_E[ONNX Pipeline<br/>feature-extraction<br/>pooling: mean, normalize: true]
        EMBED -->|VS Code LM| VS_E[vscode.lm.computeEmbeddings<br/>Proposed API]
        HF_E & VS_E --> VECTORS[Embedding Vectors<br/>number arrays]
    end

    subgraph "Stage 4: Storage"
        VECTORS --> STORE[VectorStoreFactory]
        STORE --> LANCE_W[Write to LanceDB<br/>Per-topic table]
        LANCE_W --> UPDATE[Update topic metadata<br/>& document index]
    end

    UPDATE --> DONE([Pipeline Complete<br/>Return PipelineResult])
```

### Pipeline Result

Each pipeline execution returns a `PipelineResult` containing:

| Field | Description |
|---|---|
| `stages` | Boolean success per stage (loading, chunking, embedding, storing) |
| `metadata.originalDocuments` | Count of source documents loaded |
| `metadata.chunksCreated` | Total chunks after splitting |
| `metadata.chunksEmbedded` | Chunks successfully embedded |
| `metadata.chunksStored` | Chunks written to LanceDB |
| `metadata.stageTimings` | Per-stage timing breakdown |

### Loader Module Architecture

The document loading system uses a **modular architecture** with a shared `DocumentLoader` interface. `DocumentLoaderFactory` is a thin orchestrator that delegates to format-specific loaders.

```mermaid
classDiagram
    class DocumentLoader {
        <<interface>>
        +load(filePath, options) Promise~LangChainDocument[]~
    }

    class TextDocumentLoader {
        +load(filePath, options) Promise~LangChainDocument[]~
    }
    class MarkdownDocumentLoader {
        +load(filePath, options) Promise~LangChainDocument[]~
    }
    class HtmlDocumentLoader {
        +load(filePath, options) Promise~LangChainDocument[]~
    }
    class PdfDocumentLoader {
        +load(filePath, options) Promise~LangChainDocument[]~
    }
    class GithubDocumentLoader {
        +load(url, options) Promise~LangChainDocument[]~
    }
    class WebDocumentLoader {
        +load(url, options) Promise~LangChainDocument[]~
    }

    DocumentLoader <|.. TextDocumentLoader
    DocumentLoader <|.. MarkdownDocumentLoader
    DocumentLoader <|.. HtmlDocumentLoader
    DocumentLoader <|.. PdfDocumentLoader
    DocumentLoader <|.. GithubDocumentLoader
    DocumentLoader <|.. WebDocumentLoader
```

| Module | File | Method |
|---|---|---|
| **TextDocumentLoader** | `src/loaders/textLoader.ts` | UTF-8 file read, returns single document |
| **MarkdownDocumentLoader** | `src/loaders/markdownLoader.ts` | Text read with `isMarkdown` and `preserveStructure` metadata |
| **HtmlDocumentLoader** | `src/loaders/htmlLoader.ts` | Regex-based: strips `<script>`, `<style>`, comments, all tags; decodes HTML entities; normalizes whitespace |
| **PdfDocumentLoader** | `src/loaders/pdfLoader.ts` | Delegates to LangChain `PDFLoader` (`pdf-parse`), optional page splitting |
| **GithubDocumentLoader** | `src/loaders/githubLoader.ts` | Delegates to LangChain `GithubRepoLoader`, supports GitHub Enterprise |
| **WebDocumentLoader** | `src/loaders/webLoader.ts` | Delegates to `CheerioWebBaseLoader`, security checks (rejects 401/403, login redirects, password fields) |

### Chunking Configuration

| Setting | Default | Description |
|---|---|---|
| `chunkSize` | 512 | Target characters per chunk |
| `chunkOverlap` | 50 | Overlap between adjacent chunks |
| `preserveStructure` | true | Keep heading hierarchy (Markdown) |

**Recommended chunk sizes by use case:**

| Use Case | Chunk Size |
|---|---|
| Q&A | 500 |
| Search | 1000 |
| Summarization | 2000 |

---

## 4. Query Execution Pipeline

### End-to-End Flow

```mermaid
flowchart TD
    START([Copilot invokes RAG tool]) --> MATCH

    subgraph "Topic Resolution"
        MATCH[Find matching topic<br/>exact → fuzzy → fallback]
        MATCH --> CACHE{Agent cached?}
        CACHE -->|Yes| REUSE[Reuse RAGAgent]
        CACHE -->|No| CREATE[Create RAGAgent<br/>+ initialize retrievers]
    end

    REUSE & CREATE --> PLAN

    subgraph "Query Planning"
        PLAN[Analyze complexity] --> SCORE{Complexity score}
        SCORE -->|Simple| HEUR[Heuristic plan<br/>1-2 sub-queries]
        SCORE -->|Moderate/Complex| LLM_REF{LLM available?}
        LLM_REF -->|Yes| REFINE[LLM refinement<br/>Zod-validated output]
        LLM_REF -->|No| HEUR
        REFINE --> QPLAN[QueryPlan<br/>sub-queries + strategy]
        HEUR --> QPLAN
    end

    QPLAN --> ITER{Iterative refinement<br/>enabled AND<br/>complexity != simple?}
    ITER -->|No| EXEC
    ITER -->|Yes| ITERLOOP

    subgraph "Initial Retrieval"
        EXEC[Execute sub-queries] --> DISPATCH
        DISPATCH{Strategy}
        DISPATCH -->|hybrid| HYB[HybridRetriever<br/>VectorRetriever + KeywordRetriever<br/>weighted score fusion]
        DISPATCH -->|ensemble| ENS[EnsembleRetriever<br/>VectorRetriever + KeywordRetriever<br/>RRF rank fusion]
        DISPATCH -->|bm25| BM25[KeywordRetriever<br/>BM25 keyword only]
        DISPATCH -->|vector| VEC[VectorRetriever<br/>Similarity only]
        HYB & ENS & BM25 & VEC --> RESULTS[Initial results]
    end

    subgraph "Iterative Refinement Loop"
        ITERLOOP[Execute initial plan] --> CHECK_CONF
        CHECK_CONF{avgConfidence ≥<br/>threshold?}
        CHECK_CONF -->|Yes| DONE_ITER[Refinement complete]
        CHECK_CONF -->|No| CHECK_MAX{iterations < max?}
        CHECK_MAX -->|No| DONE_ITER
        CHECK_MAX -->|Yes| GAP[Gap Analysis<br/>Identify weak sub-queries]
        GAP --> FOLLOWUP[Generate follow-up<br/>queries via LLM]
        FOLLOWUP --> EXEC_FU[Execute follow-ups]
        EXEC_FU --> MERGE[Merge & deduplicate]
        MERGE --> CHECK_CONF
    end

    RESULTS --> POST
    DONE_ITER --> POST

    subgraph "Post-Processing"
        POST[Deduplicate by content hash] --> RANK[Re-rank by score]
        RANK --> TOPK[Limit to topK]
        TOPK --> FORMAT[Format RAGQueryResult<br/>with agenticMetadata]
    end

    FORMAT --> RETURN([Return to Copilot])
```

### Query Planning: Complexity Analysis

The `QueryPlannerAgent` scores query complexity using heuristics:

| Factor | Weight | Example |
|---|---|---|
| Sentence/clause count | +1 per extra sentence | "How does X work? And how about Y?" |
| Question words | +1 per question word | what, how, why, when, where |
| Comparison indicators | +2 | "compare X vs Y", "difference between" |
| Word count > 25 | +1 | Long, detailed queries |
| Conjunctions | +0.5 | and, or, but, also |

**Complexity mapping:**

| Score | Classification | Sub-queries |
|---|---|---|
| 0–2 | Simple | 1 (passthrough) |
| 3–5 | Moderate | 2–3 |
| 6+ | Complex | 3–5 |

---

## 5. Iterative Refinement & Gap Analysis

### Refinement Loop Sequence

```mermaid
sequenceDiagram
    participant RA as RAGAgent
    participant QP as QueryPlannerAgent
    participant RET as Retriever
    participant LLM as VS Code LLM

    RA->>QP: createPlan(query, options)
    QP-->>RA: QueryPlan {subQueries, complexity}

    loop Iteration 1..maxIterations
        RA->>RET: execute sub-queries
        RET-->>RA: RetrievalResult[]

        RA->>RA: calculateAvgConfidence()
        alt confidence ≥ threshold
            RA-->>RA: Break loop (converged)
        else confidence < threshold
            RA->>RA: analyzeGaps(results, plan)
            Note over RA: Identify sub-queries with:<br/>- no_results (0 hits)<br/>- low_score (avg < gapThreshold)<br/>- coverage_imbalance

            alt gaps found
                RA->>QP: generateFollowUpPlan(gaps)
                QP->>LLM: Refine follow-up queries
                LLM-->>QP: Follow-up sub-queries
                QP-->>RA: Follow-up QueryPlan

                RA->>RET: Execute follow-ups
                RET-->>RA: Additional results

                RA->>RA: Merge + deduplicate
                RA->>RA: Recalculate confidence
            else no gaps
                RA-->>RA: Break loop (no improvement possible)
            end
        end
    end

    RA->>RA: Final dedup + re-rank + topK
    RA-->>RA: Return RAGResult
```

### Gap Analysis Logic

Gap analysis evaluates each sub-query's retrieval quality:

```
For each sub-query in the plan:
  1. Filter results attributed to this sub-query
  2. Calculate: resultCount, avgScore
  3. Classify gap reason:
     - no_results: resultCount === 0
     - low_score:  avgScore < gapScoreThreshold (default: 0.4)
     - coverage_imbalance: resultCount < expected proportion
```

### Follow-Up Query Generation

When gaps are detected, the system generates targeted follow-up queries:

1. **LLM path** — Sends gap context to `QueryPlannerAgent` for LLM refinement
2. **Heuristic fallback** — Generates reformulated queries using keyword extraction
3. **Circuit breaker** — Stops if follow-ups would exceed `maxIterations`
4. **Fair allocation** — Distributes follow-up budget proportionally across gaps

### Convergence Detection

The loop terminates when any of these conditions are met:

| Condition | Description |
|---|---|
| Confidence met | `avgConfidence ≥ confidenceThreshold` |
| Max iterations | `iteration ≥ maxIterations` |
| No gaps found | Gap analysis returns empty list |
| Cancellation | `token.isCancellationRequested` |

---

## 6. Embedding Subsystem

### Backend Selection Flow

```mermaid
flowchart TD
    START([Embedding request]) --> RESOLVE{Backend config}

    %% use plain labels (no inner quotes or HTML) to avoid parser issues
    RESOLVE -->|auto (default)| AUTO{VS Code LM API available?}
    AUTO -->|Yes| VSCODE[VscodeLmBackend]
    AUTO -->|No| HF[HuggingFaceBackend]

    RESOLVE -->|vscodeLM| FORCE_VS{API available?}
    FORCE_VS -->|Yes| VSCODE
    FORCE_VS -->|No| ERROR([Error: API unavailable])

    RESOLVE -->|huggingface| HF

    VSCODE --> EXEC[Execute embedding]
    HF --> EXEC

    EXEC --> FAIL{Failure?}
    FAIL -->|No| RETURN([Return vectors])
    FAIL -->|Yes + auto mode| FALLBACK[Switch to HuggingFace\nShow warning]
    FAIL -->|Yes + forced| ERROR2([Propagate error])
    FALLBACK --> HF
```

### Backend Comparison

| Feature | HuggingFace | VS Code LM |
|---|---|---|
| **Runtime** | ONNX / WASM (local) | VS Code proposed API |
| **Models** | Xenova/* (bundled or downloaded) | Copilot-provided |
| **Latency** | ~50ms first load, ~5ms after | API-dependent |
| **Offline** | Yes | No |
| **Dimensions** | Model-dependent (384/768) | Provider-dependent |
| **Batch** | Sequential (per text) | Native batch API |

### Class Diagram: Embedding Subsystem

```mermaid
classDiagram
    class EmbeddingBackend {
        <<interface>>
        +isAvailable() Promise~boolean~
        +initialize(modelName?) Promise~void~
        +embed(text) Promise~number[]~
        +embedBatch(texts, callback?) Promise~number[][]~
        +getDimension() number | null
        +dispose() void
    }

    class EmbeddingService {
        -instance$ EmbeddingService
        -activeBackend EmbeddingBackend
        -activeBackendType string
        -hfBackend HuggingFaceBackend
        -initPromise Promise~void~
        -modelRegistry ModelRegistry
        +getInstance()$ EmbeddingService
        +embed(text) Promise~number[]~
        +embedBatch(texts, cb?) Promise~number[][]~
        +initialize(modelName?) Promise~void~
        +getCurrentModel() string
        +getDimension() number
        +resetBackendSelection() void
        -resolveBackend() Promise~string~
        -executeWithFallback(op, name) Promise~T~
        +onModelChanged$ Event
    }

    class HuggingFaceBackend {
        -pipeline FeatureExtractionPipeline
        -currentModel string
        -dimension number
        -initMutex Mutex
        +isAvailable() Promise~boolean~
        +initialize(modelName?) Promise~void~
        +embed(text) Promise~number[]~
        +embedBatch(texts, cb?) Promise~number[][]~
        -truncateText(text, maxTokens?) string
    }

    class VscodeLmBackend {
        -model EmbeddingModel
        -dimension number
        +isAvailable() Promise~boolean~
        +initialize(modelName?) Promise~void~
        +embed(text) Promise~number[]~
        +embedBatch(texts, cb?) Promise~number[][]~
        -validateDimensions(embeddings) void
    }

    class ModelRegistry {
        -instance$ ModelRegistry
        +getInstance()$ ModelRegistry
        +getDefaultModel() string
        +resolveModelIdentifier(name) string
        +resolveLocalModelPath(config?) string
        +discoverLocalModels() Promise~AvailableModel[]~
        +validateModelPath(path) Promise~void~
        +CURATED_MODELS$ string[]
    }

    EmbeddingBackend <|.. HuggingFaceBackend
    EmbeddingBackend <|.. VscodeLmBackend
    EmbeddingService --> EmbeddingBackend : activeBackend
    EmbeddingService --> HuggingFaceBackend : hfBackend
    EmbeddingService --> ModelRegistry : modelRegistry
```

---

## 7. Retrieval Strategies

### Strategy Comparison

| Strategy | Semantic | Keyword | Speed | Memory | Best For |
|---|---|---|---|---|---|
| **Vector** | Yes | No | Fast | Medium | Pure semantic similarity |
| **Hybrid** (default) | Yes | Yes | Medium | Medium | General purpose |
| **Ensemble (RRF)** | Yes | Yes | Medium-Slow | High | Robustness, multi-signal |
| **BM25** | No | Yes | Fast | High | Exact term match, code, IDs |

### Hybrid Retrieval Scoring

```mermaid
flowchart LR
    Q([Query]) --> VS[Vector Search<br/>k=15]
    Q --> KE[Keyword Extraction<br/>Remove stop words]

    VS --> VSCORE[vectorScore<br/>normalized 0-1]
    KE --> KMATCH[Keyword Matching<br/>in documents]
    KMATCH --> KSCORE[keywordScore<br/>term frequency]

    VSCORE --> FUSION["hybridScore =<br/>0.7 × vectorScore +<br/>0.3 × keywordScore"]
    KSCORE --> FUSION

    FUSION --> RANK[Sort by hybridScore<br/>Return topK]
```

### Ensemble (RRF) Fusion

```mermaid
flowchart LR
    Q([Query]) --> VS2[Vector Search<br/>ranked results]
    Q --> BM[BM25 Search<br/>ranked results]

    VS2 --> RRF["RRF Score per doc:<br/>Σ weight/(60 + rank + 1)"]
    BM --> RRF

    RRF --> DEDUP[Deduplicate by<br/>document hash]
    DEDUP --> SORT[Sort by total<br/>RRF score]
    SORT --> TOP[Return topK]
```

### Retriever Class Diagram

```mermaid
classDiagram
    class VectorRetriever {
        -vectorStore VectorStore
        +search(query, k?) Promise~VectorSearchResult[]~
        +getDocuments(query, k?) Promise~Document[]~
        +setVectorStore(store) void
        -normalizeDistance(distance, doc) number
    }

    class KeywordRetriever {
        -bm25Retriever BM25Retriever
        -documents LangChainDocument[]
        -STOP_WORDS Set~string~
        +initialize(documents) Promise~void~
        +search(query, k?) Promise~KeywordSearchResult[]~
        +scoreDocument(text, keywords, boosting?) number
        +extractKeywords(query, customStopWords?) string[]
        +isInitialized() boolean
        +getDocumentCount() number
        +refresh(documents) Promise~void~
    }

    class HybridRetriever {
        -vectorRetriever VectorRetriever
        -keywordRetriever KeywordRetriever
        +search(query, options?) Promise~HybridSearchResult[]~
        +vectorSearch(query, k?) Promise~HybridSearchResult[]~
    }

    class EnsembleRetrieverWrapper {
        -vectorRetriever VectorRetriever
        -keywordRetriever KeywordRetriever
        +search(query, options?) Promise~EnsembleSearchResult[]~
        -reciprocalRankFusion(vecResults, bm25Results, vW, bW) Document[]
        -getDocumentId(doc) string
        +isInitialized() boolean
        +getDocumentCount() number
    }

    HybridRetriever --> VectorRetriever : delegates vector search
    HybridRetriever --> KeywordRetriever : delegates keyword search
    EnsembleRetrieverWrapper --> VectorRetriever : delegates vector search
    EnsembleRetrieverWrapper --> KeywordRetriever : delegates keyword search
```

---

## 8. Class Diagram

### Full System Class Relationships

```mermaid
classDiagram
    %% Core Services (Singletons)
    class EmbeddingService {
        <<singleton>>
    }
    class TopicManager {
        <<singleton>>
    }
    class ModelRegistry {
        <<singleton>>
    }

    %% Extension Entry
    class Extension {
        +activate(context) Promise~void~
        +deactivate() void
    }

    %% Commands & Tool
    class CommandHandler {
        +registerCommands(context)$
        +createTopic()
        +deleteTopic(id)
        +addDocuments(id, paths)
        +setEmbeddingModel(model)
    }

    class RAGTool {
        -agentCache Map~string, RAGAgent~
        +register(context)$ Disposable
        +executeQuery(params) Promise~RAGQueryResult~
        -getOrCreateAgent(topicId) Promise~RAGAgent~
        -findBestMatchingTopic(name)
    }

    %% Agents
    class RAGAgent {
        -queryPlanner QueryPlannerAgent
        -vectorRetriever VectorRetriever
        -keywordRetriever KeywordRetriever
        -hybridRetriever HybridRetriever
        -ensembleRetriever EnsembleRetrieverWrapper
        -vectorStore VectorStore
        +query(query, options?) Promise~RAGResult~
        -iterativeRetrieval(plan, options) Promise
        -analyzeGaps(results, plan) SubQueryGap[]
        -generateFollowUpPlan(gaps, options) Promise
    }

    class QueryPlannerAgent {
        +createPlan(query, options?) Promise~QueryPlan~
        +canRefineWithLLM(query, family?)$ Promise~boolean~
        -analyzeComplexityScore(query, options) number
        -heuristicPlan(query, options) QueryPlan
        -refinePlanWithLLM(query, plan, options) Promise~QueryPlan~
    }

    class VSCodeLLM {
        -modelFamily string
        -vendor string
        +_generate(messages, options?) Promise~ChatResult~
        +isModelAvailable(vendor?, family?)$ Promise~boolean~
    }

    %% Storage & Pipeline
    class DocumentPipeline {
        +processDocuments(paths, topicId, options?) Promise~PipelineResult~
        -loadDocuments(paths, options)
        -storeDocuments(chunks, topicId, options)
    }

    class VectorStoreFactory {
        +createStore(config, docs?) Promise~void~
        +loadStore(topicId, dir?) Promise~VectorStore~
        +deleteStore(topicId) Promise~void~
        +addDocuments(topicId, docs) Promise~void~
        +invalidateCache(topicId?) void
    }

    class DocumentLoaderFactory {
        -loaders Record~SupportedFileType, DocumentLoader~
        +loadDocument(options) Promise~LoadedDocument~
        +loadDocuments(paths) Promise~LangChainDocument[]~
        +getSupportedExtensions()$ string[]
        +isSupported(filePath)$ boolean
        +isWebUrl(path)$ boolean
        -detectFileType(filePath) SupportedFileType
        -validateFile(filePath) Promise~void~
        -isDirectory(filePath) Promise~boolean~
        -collectFilesFromDirectory(dir) Promise~string[]~
    }

    class DocumentLoader {
        <<interface>>
        +load(filePath, options) Promise~LangChainDocument[]~
    }

    DocumentLoaderFactory --> DocumentLoader : delegates to 6 loaders

    class SemanticChunker {
        +chunkDocuments(docs, options?) Promise~ChunkingResult~
        -determineStrategy(docs, options) string
        -enrichChunksInBatches(chunks, options) Document[]
    }

    %% UI
    class TopicTreeDataProvider {
        +refresh() void
        +getChildren(element?) Promise~TopicTreeItem[]~
    }

    %% Relationships
    Extension --> CommandHandler : registers
    Extension --> RAGTool : registers
    Extension --> TopicManager : initializes
    Extension --> EmbeddingService : initializes

    RAGTool --> RAGAgent : creates/caches
    RAGTool --> TopicManager : resolves topics

    RAGAgent --> QueryPlannerAgent : plans queries
    RAGAgent --> VectorRetriever : base vector search
    RAGAgent --> KeywordRetriever : base keyword search
    RAGAgent --> HybridRetriever : weighted fusion
    RAGAgent --> EnsembleRetrieverWrapper : RRF fusion

    QueryPlannerAgent --> VSCodeLLM : LLM refinement

    TopicManager --> DocumentPipeline : processes docs
    TopicManager --> VectorStoreFactory : manages stores
    TopicManager --> EmbeddingService : model info

    DocumentPipeline --> DocumentLoaderFactory : loads files
    DocumentPipeline --> SemanticChunker : chunks text
    DocumentPipeline --> EmbeddingService : generates embeddings
    DocumentPipeline --> VectorStoreFactory : stores vectors

    TopicTreeDataProvider --> TopicManager : reads topics
    TopicTreeDataProvider --> EmbeddingService : model events

    EmbeddingService --> ModelRegistry : resolves models
```

---

## 9. Sequence Diagrams

### 9.1 Extension Activation

```mermaid
sequenceDiagram
    participant VSC as VS Code
    participant EXT as extension.ts
    participant TM as TopicManager
    participant ES as EmbeddingService
    participant CMD as CommandHandler
    participant TOOL as RAGTool
    participant TV as TreeViews

    VSC->>EXT: activate(context)
    EXT->>TM: getInstance(context)
    TM->>TM: init() [load topics index]
    EXT->>ES: getInstance()
    ES->>ES: resolveBackend() [background]
    EXT->>CMD: registerCommands(context)
    EXT->>TV: new TopicTreeDataProvider()
    EXT->>TV: new ConfigTreeDataProvider()
    EXT->>TOOL: RAGTool.register(context)
    TOOL->>VSC: vscode.lm.registerTool()
    EXT->>VSC: setContext('ragnarok.loaded', true)
    EXT->>VSC: setContext('ragnarok.hasTopics', count > 0)
```

### 9.2 Document Ingestion

```mermaid
sequenceDiagram
    participant U as User
    participant CMD as CommandHandler
    participant TM as TopicManager
    participant DP as DocumentPipeline
    participant DLF as DocumentLoaderFactory
    participant SC as SemanticChunker
    participant ES as EmbeddingService
    participant VSF as VectorStoreFactory
    participant DB as LanceDB

    U->>CMD: Add Document command
    CMD->>TM: addDocuments(topicId, filePaths)
    TM->>DP: processDocuments(filePaths, topicId, options)

    rect rgb(240, 248, 255)
        Note over DP,DLF: Stage 1: Loading
        DP->>DLF: loadDocument(options) per file
        DLF->>DLF: detectFileType() → strategy
        DLF-->>DP: LoadedDocument[] with metadata
    end

    rect rgb(240, 255, 240)
        Note over DP,SC: Stage 2: Chunking
        DP->>SC: chunkDocuments(documents, chunkingOptions)
        SC->>SC: determineStrategy() → markdown|recursive|code
        SC->>SC: split + enrichChunksInBatches()
        SC-->>DP: ChunkingResult {chunks, stats}
    end

    rect rgb(255, 248, 240)
        Note over DP,ES: Stage 3: Embedding
        DP->>ES: embedBatch(chunkTexts, progressCallback)
        ES->>ES: executeWithFallback(embed)
        ES-->>DP: number[][] vectors
    end

    rect rgb(248, 240, 255)
        Note over DP,DB: Stage 4: Storage
        DP->>VSF: addDocuments(topicId, chunks)
        VSF->>DB: LanceDB.fromDocuments() or addDocuments()
        VSF->>VSF: saveStoreMetadata(topicId)
        VSF-->>DP: stored
    end

    DP-->>TM: PipelineResult
    TM->>TM: Update topic index + document cache
    TM-->>CMD: AddDocumentResult
```

### 9.3 Agentic Query Execution

```mermaid
sequenceDiagram
    participant COP as Copilot
    participant TOOL as RAGTool
    participant TM as TopicManager
    participant RA as RAGAgent
    participant QP as QueryPlannerAgent
    participant LLM as VSCodeLLM
    participant RET as Retriever

    COP->>TOOL: executeQuery({topic, query, topK})
    TOOL->>TM: findBestMatchingTopic(topic)
    TM-->>TOOL: Topic (exact|similar|fallback)
    TOOL->>TOOL: getOrCreateAgent(topicId)
    TOOL->>RA: query(query, agenticOptions)

    rect rgb(255, 245, 245)
        Note over RA,QP: Phase 1: Planning
        RA->>QP: createPlan(query, options)
        QP->>QP: analyzeComplexityScore()
        QP->>QP: heuristicPlan()
        alt Complex + LLM available
            QP->>LLM: refinePlanWithLLM()
            LLM-->>QP: Zod-validated plan
        end
        QP-->>RA: QueryPlan {subQueries, complexity, strategy}
    end

    rect rgb(245, 255, 245)
        Note over RA,RET: Phase 2: Retrieval
        loop Each sub-query
            RA->>RET: search(subQuery, {k, strategy})
            RET-->>RA: RetrievalResult[]
        end
    end

    rect rgb(245, 245, 255)
        Note over RA,LLM: Phase 3: Iterative Refinement
        alt complex query (not simple)
            loop Until converged or maxIterations
                RA->>RA: calculateAvgConfidence()
                alt confidence < threshold
                    RA->>RA: analyzeGaps()
                    RA->>QP: generateFollowUpPlan(gaps)
                    QP->>LLM: Refine follow-ups
                    LLM-->>QP: Follow-up queries
                    QP-->>RA: Follow-up plan
                    RA->>RET: Execute follow-ups
                    RET-->>RA: Additional results
                    RA->>RA: Merge + deduplicate
                end
            end
        end
    end

    RA->>RA: Final dedup + re-rank + topK
    RA-->>TOOL: RAGResult
    TOOL->>TOOL: Format RAGQueryResult + agenticMetadata
    TOOL-->>COP: JSON response
```

### 9.4 Embedding Backend Fallback

```mermaid
sequenceDiagram
    participant C as Caller
    participant ES as EmbeddingService
    participant VLM as VscodeLmBackend
    participant HF as HuggingFaceBackend

    C->>ES: embed(text)
    ES->>ES: ensureBackend()

    alt activeBackendType = vscodeLM
        ES->>VLM: embed(text)
        alt Success
            VLM-->>ES: number[]
            ES-->>C: number[]
        else Failure + auto mode
            VLM--xES: Error
            ES->>ES: shouldFallbackToHuggingFace()
            ES->>HF: initialize()
            ES->>ES: activeBackendType = 'huggingface'
            ES->>HF: embed(text)
            HF-->>ES: number[]
            ES-->>C: number[]
            Note over ES: Show warning to user
        end
    else activeBackendType = huggingface
        ES->>HF: embed(text)
        HF-->>ES: number[]
        ES-->>C: number[]
    end
```

---

## 10. Storage & Persistence

### File System Layout

```
${extensionStorageDir}/
├── database/
│   ├── topics.json                    # Global topics index
│   ├── lancedb/
│   │   ├── ${topicId}/               # Per-topic LanceDB table
│   │   │   ├── ${topicId}.lance      # Vector data
│   │   │   └── .lancedb/            # Table metadata/index
│   │   └── ...
│   ├── documents/
│   │   ├── ${topicId}.json           # Document metadata per topic
│   │   └── ...
│   └── metadata/
│       ├── ${topicId}.json           # Vector store metadata
│       └── ...
└── common-db/                         # Optional shared database
    └── (same structure as database/)
```

### Data Model

```mermaid
erDiagram
    TOPICS_INDEX ||--o{ TOPIC : contains
    TOPIC ||--o{ DOCUMENT : has
    TOPIC ||--|| VECTOR_STORE : "1:1"
    VECTOR_STORE ||--o{ CHUNK : stores
    DOCUMENT ||--o{ CHUNK : "split into"

    TOPICS_INDEX {
        string version
        Topic[] topics
    }

    TOPIC {
        string id PK
        string name
        string description
        number createdAt
        number updatedAt
        number documentCount
        string source "local|common"
    }

    DOCUMENT {
        string id PK
        string topicId FK
        string name
        string filePath
        string fileType
        number addedAt
        number chunkCount
    }

    VECTOR_STORE {
        string topicId PK
        number documentCount
        number chunkCount
        string embeddingModel
        number createdAt
        number updatedAt
    }

    CHUNK {
        string id PK
        string documentId FK
        string topicId FK
        string text
        float[] embedding
        number chunkIndex
        string documentName
        string headingPath
        string sectionTitle
    }
```

### Caching Strategy

| Cache | Scope | Size Limit | Eviction |
|---|---|---|---|
| **RAGAgent** | Per topic | 10 agents | LRU on overflow |
| **VectorStore** | Per topic | 50 stores | LRU on overflow |
| **QueryPlan** | Per query hash | 50 plans | 1-minute TTL |
| **Topic documents** | Per topic | Unbounded | On topic delete |

---

## 11. Configuration Reference

All settings are under the `ragnarok.*` namespace.

### Core Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `topK` | number | 5 | Number of results per query |
| `chunkSize` | number | 512 | Target chunk size (characters) |
| `chunkOverlap` | number | 50 | Overlap between adjacent chunks |
| `retrievalStrategy` | enum | `hybrid` | `vector` \| `hybrid` \| `ensemble` \| `bm25` |
| `logLevel` | enum | `info` | `debug` \| `info` \| `warn` \| `error` |

### Embedding Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `embeddingBackend` | enum | `auto` | `auto` \| `huggingface` \| `vscodeLM` |
| `embeddingVscodeModelId` | string | `""` | VS Code LM model identifier |
| `localModelPath` | string | `""` | Custom local model directory |

### Query Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `maxIterations` | number | 3 | Max refinement iterations |
| `confidenceThreshold` | number | 0.7 | Min confidence to stop refining |
| `llmModel` | string | `gpt-4o-mini` | LLM model family for planning |
| `includeWorkspaceContext` | boolean | true | Include open files as context |
| `gapScoreThreshold` | number | 0.4 | Min avg score before gap is flagged |

### Advanced Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `commonDatabasePath` | string | `""` | Path to shared read-only database |

---

## 12. Commands Reference

All commands are under the `ragnarok.*` namespace.

### Topic Management

| Command | Title | Description |
|---|---|---|
| `ragnarok.createTopic` | Create New Topic | Create a new RAG topic with name and description |
| `ragnarok.deleteTopic` | Delete Topic | Remove a topic and its vector store |
| `ragnarok.renameTopic` | Rename Topic | Rename an existing topic |
| `ragnarok.exportTopic` | Export Topic | Export topic data to a portable format |
| `ragnarok.importTopic` | Import Topic | Import a previously exported topic |

### Document Ingestion

| Command | Title | Description |
|---|---|---|
| `ragnarok.addDocument` | Add Document to Topic | Add local files (PDF, MD, HTML, TXT) or directories |
| `ragnarok.addGithubRepo` | Add GitHub Repo to Topic | Ingest a GitHub repository (with optional token) |
| `ragnarok.addWebUrl` | Add Web URL to Topic | Load a web page; auto-detects GitHub URLs and routes to repo ingestion |

### Embedding & Model Configuration

| Command | Title | Description |
|---|---|---|
| `ragnarok.setEmbeddingModel` | Set Embedding Model | Choose between HuggingFace and VS Code LM backends |
| `ragnarok.selectVscodeEmbeddingModel` | Select VS Code Embedding Model | Pick from available VS Code LM embedding models |
| `ragnarok.selectHfEmbeddingModel` | Select HuggingFace Model | Pick from curated or custom HuggingFace models |
| `ragnarok.selectLLMModel` | Select LLM Model | Choose LLM for agentic query planning |

### GitHub Token Management

| Command | Title | Description |
|---|---|---|
| `ragnarok.addGithubToken` | Add GitHub Token | Store a PAT for GitHub API access (5000 req/hr) |
| `ragnarok.listGithubTokens` | List GitHub Tokens | View stored tokens by host |
| `ragnarok.removeGithubToken` | Remove GitHub Token | Delete a stored token |

### Maintenance

| Command | Title | Description |
|---|---|---|
| `ragnarok.refreshTopics` | Refresh Topics | Reload topic tree view |
| `ragnarok.clearModelCache` | Clear Model Cache | Remove cached embedding model files |
| `ragnarok.clearDatabase` | Clear Database | Delete all topics and vector data |
| `ragnarok.editConfigItem` | Edit Config Item | Modify a configuration setting inline |
