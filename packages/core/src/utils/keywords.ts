/**
 * Shared keyword extraction utility
 *
 * Centralizes stop word filtering and keyword extraction logic
 * used by KeywordRetriever, QueryPlannerAgent, and RAGAgent.
 */

/**
 * Base stop words — union of all stop word lists across the codebase.
 * Common English function words that carry little semantic meaning.
 */
export const BASE_STOP_WORDS = new Set([
  "a",
  "about",
  "also",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "even",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "how",
  "in",
  "is",
  "it",
  "its",
  "just",
  "may",
  "might",
  "more",
  "most",
  "not",
  "of",
  "on",
  "only",
  "or",
  "shall",
  "should",
  "such",
  "that",
  "the",
  "their",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "very",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
]);

/**
 * Query-intent words — verbs/nouns that express user intent rather than
 * topic content. Used by QueryPlannerAgent to strip intent from BM25 queries.
 */
export const QUERY_INTENT_WORDS: readonly string[] = [
  "mean",
  "means",
  "meaning",
  "meant",
  "definition",
  "define",
  "defined",
  "explain",
  "explained",
  "explanation",
  "describe",
  "described",
  "description",
  "tell",
  "give",
  "show",
  "list",
  "find",
  "know",
  "understand",
  "purpose",
  "reason",
  "example",
  "examples",
  "important",
  "biggest",
  "main",
];

/**
 * Options for keyword extraction
 */
export interface ExtractKeywordsOptions {
  /** Additional stop words to filter (merged with BASE_STOP_WORDS) */
  extraStopWords?: readonly string[];
  /** Regex to sanitize input text (default: /[^\w\s]/g) */
  sanitizeRegex?: RegExp;
  /** Replacement string for sanitize matches (default: " ") */
  replacement?: string;
  /** Minimum word length to keep (default: 3, i.e. words must be length > 2) */
  minLength?: number;
  /** Whether to deduplicate results (default: true) */
  deduplicate?: boolean;
}

/**
 * Extract keywords from text by removing stop words and short tokens.
 *
 * @param text - Input text to extract keywords from
 * @param options - Extraction options
 * @returns Array of keyword strings
 */
export function extractKeywords(text: string, options: ExtractKeywordsOptions = {}): string[] {
  const { extraStopWords, sanitizeRegex = /[^\w\s]/g, replacement = " ", minLength = 3, deduplicate = true } = options;

  const stopWords = extraStopWords ? new Set([...BASE_STOP_WORDS, ...extraStopWords]) : BASE_STOP_WORDS;

  const lowered = text.toLowerCase();

  // Split first, then sanitize each token to avoid merging words
  // when replacement is "" and sanitizeRegex matches whitespace
  const tokens = lowered
    .split(/\s+/)
    .map((w) => w.replace(sanitizeRegex, replacement))
    .flatMap((w) => w.split(/\s+/)) // re-split in case replacement introduced spaces
    .filter((word) => word.length >= minLength && !stopWords.has(word));

  return deduplicate ? [...new Set(tokens)] : tokens;
}
