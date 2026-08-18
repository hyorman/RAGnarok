# Sample Markdown Document

## Introduction

This is a sample markdown document for testing the chunking functionality. It contains multiple sections with different levels of headings.

## Getting Started

### Prerequisites

Before you begin, ensure you have the following:

- Node.js version 18 or higher
- NPM or Yarn package manager
- Basic understanding of TypeScript

### Installation

To install the dependencies, run the following command:

```bash
npm install
```

This will download all the required packages from the npm registry.

## Core Concepts

### Embedding Models

Embedding models convert text into high-dimensional vectors. These vectors capture semantic meaning and allow for similarity comparisons.

#### Popular Models

Some popular embedding models include:

1. all-MiniLM-L6-v2 - Fast and efficient
2. all-MiniLM-L12-v2 - Better accuracy
3. multi-qa-MiniLM-L6-cos-v1 - Optimized for Q&A

### Vector Databases

Vector databases store embeddings and enable fast similarity search. They use specialized indexing techniques like HNSW or IVF.

## Advanced Topics

### Semantic Chunking

Semantic chunking splits documents based on structure rather than arbitrary character limits. This preserves context and improves retrieval quality.

Key benefits:
- Maintains logical boundaries
- Preserves heading hierarchy
- Better context for embeddings

### Retrieval Strategies

Different strategies can be used for retrieval:

1. **Top-K retrieval** - Return the K most similar chunks
2. **Threshold-based** - Return all chunks above a similarity threshold
3. **Hybrid search** - Combine semantic and keyword search

## Conclusion

This document demonstrates various markdown features that the chunking algorithm should handle correctly. It includes headings at multiple levels, lists, code blocks, and formatted text.

