/**
 * Query Planner Agent - Decomposes complex queries into sub-queries
 * Uses LangChain StructuredOutputParser with Zod schemas
 *
 * Architecture: LLM-powered query analysis and decomposition
 * Determines optimal search strategy (sequential vs parallel)
 */

import * as vscode from 'vscode';
import { z } from 'zod';
import { Logger } from '../utils/logger';
import { CONFIG } from '../utils/constants';
import { RetrievalStrategy } from '../utils/types';

/** Default timeout for LLM requests in milliseconds */
const LLM_TIMEOUT_MS = 15_000;

/** Supported execution strategies */
const STRATEGIES = ['sequential', 'parallel', 'hybrid', 'priority-based'] as const;
export type ExecutionStrategy = (typeof STRATEGIES)[number];

// Zod schema for query plan
const SubQuerySchema = z.object({
  query: z.string().describe('The sub-query to search for'),
  reasoning: z.string().describe('Why this sub-query is needed'),
  topK: z.number().optional().describe('Number of results for this sub-query'),
  priority: z.enum(['high', 'medium', 'low']).optional().describe('Search priority'),
});

const QueryPlanSchema = z.object({
  originalQuery: z.string().describe('The original user query'),
  complexity: z.enum(['simple', 'moderate', 'complex']).describe('Query complexity'),
  subQueries: z.array(SubQuerySchema).describe('Decomposed sub-queries'),
  strategy: z.enum(STRATEGIES).describe('Execution strategy'),
  explanation: z.string().describe('Brief explanation of the search strategy'),
});

export type SubQuery = z.infer<typeof SubQuerySchema>;
export type QueryPlan = z.infer<typeof QueryPlanSchema>;

export interface QueryPlannerOptions {
  /** Topic name for context */
  topicName?: string;

  /** Workspace context (open files, etc.) */
  workspaceContext?: string;

  /** Maximum number of sub-queries */
  maxSubQueries?: number;

  /** Default topK for sub-queries */
  defaultTopK?: number;

  /** Minimum topK for any sub-query (default: 1) */
  minTopK?: number;

  /** LLM model family to use (e.g. 'gpt-4o') */
  modelFamily?: string;

  /** Cancellation token to abort long-running LLM requests */
  token?: vscode.CancellationToken;

  /**
   * topK multipliers by priority level.
   * Defaults: `{ high: 1.0, medium: 0.7, low: 0.5 }`
   */
  topKMultipliers?: { high?: number; medium?: number; low?: number };

  /** Retrieval strategy — when BM25 or ensemble, sub-queries are converted to keywords */
  retrievalStrategy?: RetrievalStrategy;
}

/**
 * Query Planner Agent using Zod for validation
 */
export class QueryPlannerAgent {
  private logger: Logger;
  private planCache = new Map<string, { plan: QueryPlan; timestamp: number }>();
  private static readonly CACHE_TTL_MS = 60_000; // 1 minute
  private static readonly MAX_CACHE_SIZE = 50;
  private static readonly STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
    'from', 'this', 'that', 'these', 'those', 'it', 'its', 'and', 'or', 'but', 'not',
    'about', 'how', 'what', 'when', 'where', 'why', 'which', 'who', 'very', 'also',
    // Query-intent words: useful for understanding the question but not for keyword matching
    'mean', 'means', 'meaning', 'meant', 'definition', 'define', 'defined',
    'explain', 'explained', 'explanation', 'describe', 'described', 'description',
    'tell', 'give', 'show', 'list', 'find', 'know', 'understand',
    'purpose', 'reason', 'example', 'examples', 'important', 'biggest', 'main',
  ]);

  constructor() {
    this.logger = new Logger('QueryPlannerAgent');
    this.logger.info('QueryPlannerAgent initialized');
  }

  /** Build a cache key from query + relevant options */
  private buildCacheKey(query: string, options: QueryPlannerOptions): string {
    const topKMultipliers = options.topKMultipliers
      ? {
          high: options.topKMultipliers.high ?? null,
          medium: options.topKMultipliers.medium ?? null,
          low: options.topKMultipliers.low ?? null,
        }
      : null;

    return JSON.stringify({
      q: query,
      modelFamily: options.modelFamily ?? null,
      maxSubQueries: options.maxSubQueries ?? null,
      defaultTopK: options.defaultTopK ?? null,
      topicName: options.topicName ?? null,
      workspaceContext: options.workspaceContext ?? null,
      minTopK: options.minTopK ?? null,
      retrievalStrategy: options.retrievalStrategy ?? null,
      topKMultipliers,
    });
  }

  /** Determine whether a query can benefit from LLM refinement. */
  public static async canRefineWithLLM(query: string, modelFamily?: string): Promise<boolean> {
    const trimmed = query.trim();
    if (trimmed.length === 0 || !trimmed.includes(' ')) {
      return false;
    }

    if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
      return false;
    }

    try {
      const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
      const resolvedModelFamily = modelFamily || config.get<string>(CONFIG.LLM_MODEL, 'gpt-4o-mini');

      let models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: resolvedModelFamily });
      if (models.length === 0) {
        models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      }

      return models.length > 0;
    } catch {
      return false;
    }
  }

  /** Return a cached plan if still valid, promoting it for LRU eviction */
  private getCachedPlan(key: string): QueryPlan | undefined {
    const entry = this.planCache.get(key);
    if (entry && Date.now() - entry.timestamp < QueryPlannerAgent.CACHE_TTL_MS) {
      // Move to end of Map iteration order (most-recently-used)
      this.planCache.delete(key);
      this.planCache.set(key, entry);
      this.logger.debug('Returning cached query plan');
      return entry.plan;
    }
    if (entry) {
      this.planCache.delete(key);
    }
    return undefined;
  }

  /** Store a plan in the cache, evicting oldest if at capacity */
  private cachePlan(key: string, plan: QueryPlan): void {
    if (this.planCache.size >= QueryPlannerAgent.MAX_CACHE_SIZE) {
      const oldest = this.planCache.keys().next().value;
      if (oldest !== undefined) {
        this.planCache.delete(oldest);
      }
    }
    this.planCache.set(key, { plan, timestamp: Date.now() });
  }

  /** Clear the plan cache */
  public clearCache(): void {
    this.planCache.clear();
  }

  /** Whether the retrieval strategy relies on keyword matching (BM25) */
  private static isKeywordStrategy(strategy?: RetrievalStrategy): boolean {
    return strategy === RetrievalStrategy.BM25 || strategy === RetrievalStrategy.ENSEMBLE;
  }

  /**
   * Convert a natural language sentence into a keyword query by removing stop words
   * and keeping only meaningful terms.
   * "What are the main personality traits of Harry Potter?" -> "personality traits Harry Potter"
   */
  private toKeywordQuery(sentence: string): string {
    const words = sentence
      .replace(/[?!.,;:'"()\[\]{}]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1)
      .filter(w => !QueryPlannerAgent.STOP_WORDS.has(w.toLowerCase()));
    return words.join(' ');
  }

  /**
   * Convert all sub-queries in a plan to keyword form for BM25-based retrieval.
   * Preserves the original sentence in the reasoning field.
   */
  private convertPlanToKeywords(plan: QueryPlan): QueryPlan {
    return {
      ...plan,
      subQueries: plan.subQueries.map(sq => {
        const keywordQuery = this.toKeywordQuery(sq.query);
        if (keywordQuery === sq.query) {
          return sq;
        }
        return {
          ...sq,
          query: keywordQuery,
          reasoning: `${sq.reasoning} (keyword-adapted from: "${sq.query}")`,
        };
      }),
    };
  }

  /**
   * Build a refinement prompt that includes the heuristic plan for LLM to improve
   */
  private buildRefinementPrompt(query: string, context: string, heuristicPlan: QueryPlan, retrievalStrategy?: RetrievalStrategy): string {
    const heuristicJSON = JSON.stringify(heuristicPlan, null, 2);

    const keywordGuidance = QueryPlannerAgent.isKeywordStrategy(retrievalStrategy) ? `
IMPORTANT — Keyword-Based Retrieval Mode:
The retrieval strategy is "${retrievalStrategy}" which uses BM25 keyword matching.
Sub-queries MUST be keyword phrases containing ONLY domain-specific content words.
Remove ALL of these:
- Question/intent words: what, how, why, explain, define, meaning, describe, list, show
- Articles/prepositions: the, a, an, of, in, for, with, at, by, from, to
- Common verbs: is, are, was, were, do, does, have, has, can, will

Examples:
- "What does patronus mean?" -> "patronus"
- "What are the main personality traits of Harry Potter?" -> "Harry Potter personality traits"
- "Compare the backgrounds of Harry and Ron" -> "Harry Ron background family"
- "How does the Sorting Hat work?" -> "Sorting Hat"
Keep ONLY the specific nouns, proper names, and domain terms that would appear in the text.
` : '';

    return `You are a query planning assistant for a RAG (Retrieval-Augmented Generation) system.
Your task is to review and improve a preliminary query plan created by a heuristic planner.

Use the following context to inform your sub-query decomposition and strategy selection:
${context}
${keywordGuidance}

User Query: "${query}"

Heuristic Plan (preliminary analysis):
${heuristicJSON}

Your job:
1. Review the heuristic plan above for correctness and completeness.
2. Improve sub-query decomposition if the heuristic missed nuances or opportunities.
3. Correct the complexity classification if it seems wrong.
4. Adjust the strategy (sequential, parallel, hybrid, or priority-based) if needed.
5. Refine sub-query wording for better retrieval results.
6. Add or remove sub-queries as appropriate.

Guidelines:
- Simple queries (single concept): Use ONE sub-query
- Moderate queries (2-3 concepts): Break into 2-3 focused sub-queries
- Complex queries (comparisons, multi-part): Break into multiple specific sub-queries
- Sequential strategy: When results of one query should inform the next or order matters
- Parallel strategy: When sub-queries are independent and can be searched together
- Hybrid strategy: When high-priority sub-queries can run in parallel, followed by sequential follow-up searches
- Priority-based strategy: When some sub-queries are clearly more important and should run before lower-priority ones

Response Format: Provide an improved JSON object with this exact structure:
{
  "originalQuery": "the original query",
  "complexity": "simple" | "moderate" | "complex",
  "subQueries": [
    {
      "query": "sub-query text",
      "reasoning": "why this sub-query is needed",
      "topK": 5,
      "priority": "high" | "medium" | "low"
    }
  ],
  "strategy": "sequential" | "parallel" | "hybrid" | "priority-based",
  "explanation": "brief explanation of the strategy"
}

Provide your improved plan as valid JSON:`;
  }

  private hasTechnicalContextBoost(query: string, options?: QueryPlannerOptions): boolean {
    if (!options?.topicName && !options?.workspaceContext) {
      return false;
    }

    const ctx = `${options.topicName || ''} ${options.workspaceContext || ''}`.toLowerCase();
    const technicalTerms = /\b(api|code|deploy|server|database|algorithm|pipeline|config|docker|kubernetes|ci\/cd|testing)\b/i;
    return technicalTerms.test(ctx) || technicalTerms.test(query);
  }

  private cleanComparisonConcept(value: string): string {
    return value
      .trim()
      .replace(/^[\s:;,.(\[\]"'`-]+/, '')
      .replace(/[\s:;,.)\[\]"'`!?-]+$/, '')
      .trim();
  }

  private extractComparisonConcepts(query: string): [string, string] | null {
    const normalized = query.trim().replace(/[.!?\s]+$/, '');
    const patterns = [
      /\bdifference between\s+(.+?)\s+and\s+(.+)$/i,
      /\bcompare\s+(.+?)\s+to\s+(.+)$/i,
      /\bcompare\s+(.+?)\s+with\s+(.+)$/i,
      /\bcompare\s+(.+?)\s+and\s+(.+)$/i,
      /(.+?)\s+(?:vs\.?|versus)\s+(.+)$/i,
      /\bwhich is better:?\s+(.+?)\s+or\s+(.+)$/i,
    ] as const;

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (!match) {
        continue;
      }

      const left = this.cleanComparisonConcept(match[1]);
      const right = this.cleanComparisonConcept(match[2]);

      if (left && right) {
        return [left, right];
      }
    }

    return null;
  }

  /**
   * Analyze query complexity using lightweight NLP heuristics.
   * Returns a score from 0 (trivial) to 1 (very complex).
   */
  private analyzeComplexityScore(query: string, options?: QueryPlannerOptions): number {
    let score = 0;
    const words = query.split(/\s+/).filter(Boolean);

    // Sentence / clause count
    const sentences = query.split(/[.!?;]+/).filter(s => s.trim().length > 0);
    if (sentences.length >= 3) { score += 0.25; }
    else if (sentences.length === 2) { score += 0.15; }

    // Independent clauses separated by conjunctions
    const clauses = query.split(/\b(and|or|but|however|whereas|while)\b/i);
    if (clauses.length > 4) { score += 0.2; }
    else if (clauses.length > 2) { score += 0.1; }

    // Comparison / contrast indicators
    if (/\b(vs\.?|versus|compare|differ|between|better|worse|pros|cons)\b/i.test(query)) {
      score += 0.3;
    }

    // Multiple question words
    const questionWords = (query.match(/\b(what|how|why|when|where|which|who)\b/gi) || []);
    if (questionWords.length >= 3) { score += 0.2; }
    else if (questionWords.length === 2) { score += 0.1; }

    // Word count factor
    if (words.length > 25) { score += 0.15; }
    else if (words.length > 15) { score += 0.05; }

    // Technical / domain indicators (code-like patterns)
    if (/[{}()\[\]<>]|\w+\.\w+\(|=>|->/.test(query)) {
      score += 0.1;
    }

    // Context-aware boost: technical topics get a slight bump
    if (this.hasTechnicalContextBoost(query, options)) {
      score += 0.1;
    }

    return Math.min(score, 1);
  }

  /**
   * Adjust topK values based on sub-query priority.
   * Uses configurable multipliers from options, with sensible defaults.
   */
  private applyDynamicTopK(subQueries: SubQuery[], baseTopK: number, options?: QueryPlannerOptions): void {
    const multipliers = {
      high: options?.topKMultipliers?.high ?? 1.0,
      medium: options?.topKMultipliers?.medium ?? 0.7,
      low: options?.topKMultipliers?.low ?? 0.5,
    };
    const minTopK = options?.minTopK ?? 1;

    for (const sq of subQueries) {
      const mult = multipliers[sq.priority || 'high'] ?? 1.0;
      sq.topK = Math.max(minTopK, Math.ceil(baseTopK * mult));
    }
  }

  /**
   * Create a query plan: heuristic first, then LLM refinement if available
   */
  public async createPlan(
    query: string,
    options: QueryPlannerOptions = {}
  ): Promise<QueryPlan> {
    this.logger.info('Creating query plan', {
      query: query.substring(0, 100),
      topicName: options.topicName,
    });

    // Early exit for trivial (empty / single-word) queries
    const trimmed = query.trim();
    if (trimmed.length === 0 || !trimmed.includes(' ')) {
      const reason = trimmed.length === 0 ? 'empty query' : 'single-word query';
      this.logger.debug('Trivial query detected, returning simple plan', { query: trimmed, reason });
      const defaultTopK = options.defaultTopK || 5;
      return {
        originalQuery: query,
        complexity: 'simple',
        subQueries: [{
          query: trimmed || query,
          reasoning: 'Direct search for trivial query',
          topK: defaultTopK,
          priority: 'high',
        }],
        strategy: 'parallel',
        explanation: 'Trivial query handled with single search',
      };
    }

    // Check cache first
    const cacheKey = this.buildCacheKey(query, options);
    const cached = this.getCachedPlan(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      // Step 1: Always start with heuristic planning
      const heuristicPlan = this.createHeuristicPlan(query, options);

      // Step 2: Try to refine with LLM
      const refinedPlan = await this.refinePlanWithLLM(query, heuristicPlan, options);
      if (refinedPlan) {
        const finalPlan = QueryPlannerAgent.isKeywordStrategy(options.retrievalStrategy)
          ? this.convertPlanToKeywords(refinedPlan) : refinedPlan;
        this.cachePlan(cacheKey, finalPlan);
        return finalPlan;
      }

      // If LLM not available, return the heuristic plan as-is
      this.logger.debug('Using heuristic plan directly');
      const finalHeuristic = QueryPlannerAgent.isKeywordStrategy(options.retrievalStrategy)
        ? this.convertPlanToKeywords(heuristicPlan) : heuristicPlan;
      this.cachePlan(cacheKey, finalHeuristic);
      return finalHeuristic;
    } catch (error) {
      this.logger.error('Failed to create query plan', {
        error: error instanceof Error ? error.message : String(error),
        query: query.substring(0, 100),
        stage: 'createPlan',
      });

      // Fallback to heuristic plan (pure sync, won't throw)
      const fallback = this.createHeuristicPlan(query, options);
      return QueryPlannerAgent.isKeywordStrategy(options.retrievalStrategy)
        ? this.convertPlanToKeywords(fallback) : fallback;
    }
  }

  /**
   * Refine a heuristic plan using VS Code Language Model API
   */
  private async refinePlanWithLLM(
    query: string,
    heuristicPlan: QueryPlan,
    options: QueryPlannerOptions
  ): Promise<QueryPlan | null> {
    try {
      // Get VS Code Language Model
      const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
      const modelFamily = options.modelFamily || config.get<string>(CONFIG.LLM_MODEL, 'gpt-4o-mini');

      let models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: modelFamily });

      // Fallback: if specific model not found, try any copilot model
      if (models.length === 0) {
        this.logger.warn(`Model family ${modelFamily} not found, trying any Copilot model`);
        models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      }

      if (models.length === 0) {
        this.logger.debug('No language models available');
        return null;
      }

      const model = models[0];

      // Build context
      const context = this.buildContextString(options);

      // Build refinement prompt with heuristic plan
      const prompt = this.buildRefinementPrompt(query, context, heuristicPlan, options.retrievalStrategy);

      // Send request to LLM with timeout and proper cancellation
      const messages = [
        vscode.LanguageModelChatMessage.User(prompt),
      ];

      const cts = new vscode.CancellationTokenSource();
      const timeout = setTimeout(() => cts.cancel(), LLM_TIMEOUT_MS);

      // Forward caller's cancellation token if provided
      const externalDisposable = options.token?.onCancellationRequested(() => cts.cancel());

      let responseText = '';
      try {
        const response = await model.sendRequest(messages, {}, cts.token);

        // Collect response
        for await (const chunk of response.text) {
          responseText += chunk;
        }
      } finally {
        clearTimeout(timeout);
        externalDisposable?.dispose();
        cts.dispose();
      }

      this.logger.debug('LLM refinement response received', {
        responseLength: responseText.length,
        modelId: model.id,
        modelFamily,
      });

      // Parse JSON response
      // Extract JSON from markdown code blocks if present (handles varied whitespace/CRLF)
      const jsonMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      const jsonText = jsonMatch ? jsonMatch[1] : responseText;
      // Try to parse the extracted text, falling back to outermost {...} extraction
      let cleanedJson = jsonText.trim();
      try {
        JSON.parse(cleanedJson);
      } catch {
        const match = cleanedJson.match(/\{[\s\S]*\}/);
        if (!match) {
          throw new Error('No valid JSON object found in LLM response');
        }
        cleanedJson = match[0];
      }

      const parsedJSON = JSON.parse(cleanedJson);

      if (typeof parsedJSON !== 'object' || parsedJSON === null) {
        this.logger.warn('LLM returned non-object JSON');
        return null;
      }

      const plan = QueryPlanSchema.parse(parsedJSON) as QueryPlan;

      // Apply constraints
      if (options.maxSubQueries && plan.subQueries.length > options.maxSubQueries) {
        plan.subQueries = plan.subQueries.slice(0, options.maxSubQueries);
      }

      // Set default topK if not specified
      const defaultTopK = options.defaultTopK || 5;
      plan.subQueries.forEach((sq: SubQuery) => {
        if (!sq.topK) {
          sq.topK = defaultTopK;
        }
      });

      this.logger.info('LLM-refined query plan created', {
        complexity: plan.complexity,
        subQueryCount: plan.subQueries.length,
        strategy: plan.strategy,
        heuristicComplexity: heuristicPlan.complexity,
        heuristicSubQueries: heuristicPlan.subQueries.length,
      });

      return plan;
    } catch (error) {
      this.logger.warn('LLM refinement failed, using heuristic plan', {
        error: error instanceof Error ? error.message : String(error),
        stage: 'refinePlanWithLLM',
        query: query.substring(0, 100),
        modelFamily: options.modelFamily,
      });
      return null;
    }
  }

  /**
   * Create a plan using heuristic rules (no LLM required)
   */
  private createHeuristicPlan(
    query: string,
    options: QueryPlannerOptions
  ): QueryPlan {
    this.logger.debug('Creating heuristic query plan', {
      query: query.substring(0, 100),
      topicName: options.topicName,
    });

    const defaultTopK = options.defaultTopK || 5;

    // Use NLP-based complexity score alongside pattern checks
    const technicalContextBoostApplied = this.hasTechnicalContextBoost(query, options);
    const complexityScore = this.analyzeComplexityScore(query, options);
    this.logger.debug('Complexity score computed', {
      complexityScore,
      technicalContextBoostApplied,
    });

    // Pattern-based indicators
    const hasComparison = /\b(vs|versus|compare|difference|between|better|worse)\b/i.test(query);
    const hasMultipleQuestions = (query.match(/\?/g) || []).length > 1;
    const hasMultipleConcepts = query.split(/\band\b|\bor\b/i).length > 2;
    const isLongQuery = query.split(/\s+/).length > 15;

    let complexity: 'simple' | 'moderate' | 'complex';
    let subQueries: SubQuery[];
    let strategy: ExecutionStrategy;
    let explanation: string;

    if (hasComparison || complexityScore >= 0.6) {
      // Comparison or high-complexity query
      complexity = 'complex';

      const comparisonConcepts = hasComparison ? this.extractComparisonConcepts(query) : null;

      if (comparisonConcepts) {
        // Clean structured extraction
        subQueries = [
          {
            query: comparisonConcepts[0],
            reasoning: `Search for information about ${comparisonConcepts[0]}`,
            topK: defaultTopK,
            priority: 'high' as const,
          },
          {
            query: comparisonConcepts[1],
            reasoning: `Search for information about ${comparisonConcepts[1]}`,
            topK: defaultTopK,
            priority: 'high' as const,
          },
        ];
        strategy = 'parallel';
      } else if (hasComparison) {
        // Fallback: split by comparison keywords and filter noise
        const parts = query.split(/\b(vs|versus|compare|difference|between)\b/i);
        subQueries = parts
          .filter((p) => p.trim().length > 3)
          .filter((p) => !/^(vs|versus|compare|difference|between|and)$/i.test(p.trim()))
          .map((part) => ({
            query: part.trim(),
            reasoning: `Search for information about ${part.trim()}`,
            topK: defaultTopK,
            priority: 'high' as const,
          }));
        strategy = 'parallel';
      } else {
        // High complexity but not a comparison — use hybrid strategy
        const parts = query.split(/[.!?;]\s+|\band\b|\bor\b/i);
        subQueries = parts
          .filter((p) => p.trim().length > 3)
          .map((part, index) => ({
            query: part.trim(),
            reasoning: `Search for ${part.trim()}`,
            topK: defaultTopK,
            priority: (index === 0 ? 'high' : 'medium') as 'high' | 'medium' | 'low',
          }));
        strategy = 'hybrid';
      }

      explanation = hasComparison
        ? 'Comparison query broken into parallel searches for each concept'
        : 'Complex query decomposed with hybrid strategy';
    } else if (hasMultipleQuestions || hasMultipleConcepts || complexityScore >= 0.35) {
      // Multiple concepts - moderate complexity
      complexity = 'moderate';

      // Split by common delimiters
      const parts = query.split(/[.!?;]\s+|\band\b/i);
      subQueries = parts
        .filter((p) => p.trim().length > 5)
        .slice(0, options.maxSubQueries || 3)
        .map((part, index) => ({
          query: part.trim(),
          reasoning: `Search for ${part.trim()}`,
          topK: defaultTopK,
          priority: (index === 0 ? 'high' : 'medium') as 'high' | 'medium' | 'low',
        }));

      // Use priority-based strategy when sub-queries differ in importance
      strategy = subQueries.length > 2 ? 'priority-based' : 'parallel';
      explanation = 'Multi-concept query split into focused sub-searches';
    } else if (isLongQuery) {
      // Long query - extract key phrases
      complexity = 'moderate';
      strategy = 'sequential';

      // Extract top keywords by filtering out stop words
      const keywords = query.split(/\s+/)
        .map(w => w.replace(/[^a-zA-Z0-9]/g, '').toLowerCase())
        .filter(w => w.length > 2 && !QueryPlannerAgent.STOP_WORDS.has(w));

      // Use the full query as primary, plus a keyword-focused sub-query if useful
      subQueries = [
        {
          query: query,
          reasoning: 'Full query for comprehensive search',
          topK: defaultTopK,
          priority: 'high' as const,
        },
      ];

      if (keywords.length >= 3) {
        subQueries.push({
          query: keywords.slice(0, 6).join(' '),
          reasoning: 'Keyword-focused search for key concepts',
          topK: defaultTopK,
          priority: 'medium' as const,
        });
      }

      explanation = 'Long query searched as-is with keyword-focused follow-up';
    } else {
      // Simple query - single sub-query
      complexity = 'simple';
      strategy = 'parallel';

      subQueries = [
        {
          query: query,
          reasoning: 'Direct search for the query',
          topK: defaultTopK,
          priority: 'high' as const,
        },
      ];

      explanation = 'Simple, focused query requires single search';
    }

    // Ensure we have at least one sub-query
    if (subQueries.length === 0) {
      subQueries = [
        {
          query: query,
          reasoning: 'Fallback to full query search',
          topK: defaultTopK,
          priority: 'high' as const,
        },
      ];
    }

    // Apply maxSubQueries constraint uniformly across all branches
    if (options.maxSubQueries && subQueries.length > options.maxSubQueries) {
      subQueries = subQueries.slice(0, options.maxSubQueries);
    }

    // Dynamic topK adjustment based on priority
    this.applyDynamicTopK(subQueries, defaultTopK, options);

    const plan: QueryPlan = {
      originalQuery: query,
      complexity,
      subQueries,
      strategy,
      explanation,
    };

    this.logger.info('Heuristic query plan created', {
      complexity: plan.complexity,
      subQueryCount: plan.subQueries.length,
      strategy: plan.strategy,
      complexityScore,
      technicalContextBoostApplied,
    });

    return plan;
  }



  /**
   * Build context string from options
   */
  private buildContextString(options: QueryPlannerOptions): string {
    const parts: string[] = [];

    if (options.topicName) {
      parts.push(`Topic: ${JSON.stringify(options.topicName)}`);
    }

    if (options.workspaceContext) {
      parts.push(`Workspace context: ${JSON.stringify(options.workspaceContext)}`);
    }

    if (parts.length === 0) {
      return 'No additional context provided.';
    }

    return parts.join('\n');
  }

  /**
   * Validate a query plan, optionally enforcing option-level constraints.
   */
  public validatePlan(plan: QueryPlan, options?: QueryPlannerOptions): boolean {
    if (!plan.originalQuery || plan.originalQuery.trim().length === 0) {
      this.logger.warn('Invalid plan: empty original query');
      return false;
    }

    if (!plan.subQueries || plan.subQueries.length === 0) {
      this.logger.warn('Invalid plan: no sub-queries');
      return false;
    }

    for (const sq of plan.subQueries) {
      if (!sq.query || sq.query.trim().length === 0) {
        this.logger.warn('Invalid plan: empty sub-query');
        return false;
      }
    }

    if (options?.maxSubQueries && plan.subQueries.length > options.maxSubQueries) {
      this.logger.warn('Invalid plan: exceeds maxSubQueries', {
        actual: plan.subQueries.length,
        max: options.maxSubQueries,
      });
      return false;
    }

    const minTopK = options?.minTopK ?? 1;
    for (const sq of plan.subQueries) {
      if (sq.topK !== undefined && sq.topK < minTopK) {
        this.logger.warn('Invalid plan: sub-query topK below minimum', {
          subQuery: sq.query.substring(0, 50),
          topK: sq.topK,
          minTopK,
        });
        return false;
      }
    }

    if (options?.defaultTopK) {
      for (const sq of plan.subQueries) {
        if (sq.topK !== undefined && sq.topK > options.defaultTopK) {
          this.logger.warn('Invalid plan: sub-query topK exceeds default', {
            subQuery: sq.query.substring(0, 50),
            topK: sq.topK,
            defaultTopK: options.defaultTopK,
          });
          return false;
        }
      }
    }

    return true;
  }
}
