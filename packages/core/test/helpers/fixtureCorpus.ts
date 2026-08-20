import { Document as LangChainDocument } from "@langchain/core/documents";

export interface FixtureCorpusEntry {
  id: string;
  content: string;
  source: string;
  topic: string;
}

export const SEMANTIC_SMOKE_CORPUS: FixtureCorpusEntry[] = [
  {
    id: "python-overview",
    content: "Python is a high-level programming language used for automation, data analysis, and machine learning.",
    source: "python-overview.txt",
    topic: "python",
  },
  {
    id: "javascript-overview",
    content:
      "JavaScript is used for web development and enables interactive behavior in browsers and server applications.",
    source: "javascript-overview.txt",
    topic: "javascript",
  },
  {
    id: "typescript-overview",
    content: "TypeScript adds static typing to JavaScript and improves maintainability for larger codebases.",
    source: "typescript-overview.txt",
    topic: "typescript",
  },
  {
    id: "machine-learning-overview",
    content:
      "Machine learning models process data to identify patterns and support prediction and classification tasks.",
    source: "machine-learning-overview.txt",
    topic: "machine-learning",
  },
  {
    id: "react-overview",
    content: "React is a JavaScript library for building user interfaces with reusable components.",
    source: "react-overview.txt",
    topic: "react",
  },
];

export const SEARCH_OPERATIONS_CORPUS: FixtureCorpusEntry[] = [
  {
    id: "index-sync",
    content:
      "The internal knowledge base syncs source records into the search index each night so retrieval stays current for downstream tools.",
    source: "index-sync.txt",
    topic: "operations",
  },
  {
    id: "document-ingestion",
    content:
      "Reference guide for document ingestion. Each record is normalized before it is written to the vector index and made available for semantic search.",
    source: "document-ingestion.txt",
    topic: "operations",
  },
  {
    id: "index-reconciliation",
    content:
      "Operational checklist for reconciling imported records against the search index when retrieval quality drops after a bulk update.",
    source: "index-reconciliation.txt",
    topic: "operations",
  },
  {
    id: "billing-support",
    content: "Customer support playbook for invoice disputes and billing escalations.",
    source: "billing-support.txt",
    topic: "support",
  },
  {
    id: "warehouse-ops",
    content: "Warehouse receiving process for new hardware shipments and stock reconciliation.",
    source: "warehouse-ops.txt",
    topic: "operations",
  },
];

export function toLangChainDocuments(
  entries: FixtureCorpusEntry[],
  metadataBuilder?: (entry: FixtureCorpusEntry, index: number) => Record<string, unknown>,
): LangChainDocument[] {
  return entries.map(
    (entry, index) =>
      new LangChainDocument({
        pageContent: entry.content,
        metadata: metadataBuilder?.(entry, index) ?? {
          id: entry.id,
          source: entry.source,
          topic: entry.topic,
        },
      }),
  );
}
