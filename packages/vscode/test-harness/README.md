# RAGnarōk Test Suite

## Overview

This test suite validates the new LangChain.js-based architecture with comprehensive unit and integration tests.

## Test Structure

```
test/
├── unit/                          # Unit tests for individual components
│   ├── hybridRetriever.test.ts   # Hybrid search tests
│   ├── queryPlannerAgent.test.ts # Query planning tests
│   ├── ragAgent.test.ts          # RAG orchestration tests
│   ├── documentPipeline.test.ts  # Document processing tests
│   └── vscodeLLMWrapper.test.ts  # LLM wrapper tests
├── integration/                   # End-to-end workflow tests
│   ├── documentIngestion.test.ts # Full ingestion pipeline
│   ├── queryExecution.test.ts    # Query workflows
│   └── topicLifecycle.test.ts    # Topic CRUD operations
├── embeddingService.test.ts      # Existing embedding tests
└── fixtures/                      # Test data
    ├── sample.md
    ├── sample.html
    └── sample-text.txt
```

## Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- test/unit/hybridRetriever.test.ts

# Run with coverage
npm run test:coverage
```

## Test Coverage Goals

- **Unit Tests**: 80%+ coverage for core components
- **Integration Tests**: All critical workflows validated
- **Edge Cases**: Error scenarios, boundary conditions

## Test Components

### Unit Tests

#### 1. HybridRetriever
- Vector search accuracy
- Keyword search with BM25 scoring
- Hybrid fusion with configurable weights
- Position boosting
- Result explanations

#### 2. QueryPlannerAgent
- LLM-powered query decomposition
- Heuristic fallback planning
- Complexity analysis (simple/moderate/complex)
- Sub-query generation
- Query validation

#### 3. RAGAgent
- Query orchestration
- Iterative refinement
- Parallel/sequential execution
- Result deduplication
- Confidence evaluation
- Result ranking

#### 4. DocumentPipeline
- Document loading (PDF, MD, HTML, TXT)
- Semantic chunking
- Embedding generation
- Vector store persistence
- Batch processing
- Progress tracking
- Error handling

#### 5. VSCodeLLMWrapper
- Message conversion (LangChain ↔ VS Code)
- Streaming support
- Model caching
- Error handling

### Integration Tests

#### 1. Document Ingestion
- Upload → Load → Chunk → Embed → Store
- Multi-file processing
- Progress callbacks
- Error recovery

#### 2. Query Execution
- Simple mode: Query → Retrieve → Return
- Agentic mode: Plan → Retrieve → Iterate → Return
- Topic matching (exact/semantic)
- Workspace context integration

#### 3. Topic Lifecycle
- Create topic
- Add documents
- Query topic
- Delete topic
- Cache management

## Test Utilities

### Mocks
- VS Code API mocks (workspace, window, LM)
- Progress callback mocks
- Storage path mocks

### Fixtures
- Sample documents (various formats)
- Pre-computed embeddings (optional)
- Expected outputs

### Helpers
- Vector store factory mock
- Embedding service mock (fast mode)
- LLM response mocking

## CI/CD Integration

Tests are designed to run in CI environments:
- No VS Code dependency (fully mocked)
- Deterministic results
- Fast execution (< 5 minutes total)
- Parallel execution support

## Notes

- Tests use Mocha + Chai (existing setup)
- Mocks use existing VS Code mock patterns
- Embedding tests may download model on first run
- Integration tests create temporary storage directories
