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
  strategy: z.enum(['sequential', 'parallel']).describe('Execution strategy'),
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

  /** Enable LLM-based planning (requires LM API access) */
  useLLM?: boolean;

  /** LLM model family to use (e.g. 'gpt-4o') */
  modelFamily?: string;
}

/**
 * Query Planner Agent using Zod for validation
 */
export class QueryPlannerAgent {
  private logger: Logger;

  constructor() {
    this.logger = new Logger('QueryPlannerAgent');
    this.logger.info('QueryPlannerAgent initialized');
  }

  /**
   * Build the prompt for LLM query planning
   */
  private buildPrompt(query: string, context: string): string {
    return `You are a query planning assistant for a RAG (Retrieval-Augmented Generation) system.
Your task is to analyze user queries and create an optimal search strategy.

${context}

User Query: "${query}"

Guidelines:
1. Simple queries (single concept): Use ONE sub-query
2. Moderate queries (2-3 concepts): Break into 2-3 focused sub-queries
3. Complex queries (comparisons, multi-part): Break into multiple specific sub-queries

Strategies:
- Sequential: When results of one query inform the next
- Parallel: When sub-queries are independent

Response Format: Provide a JSON object with this exact structure:
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
  "strategy": "sequential" | "parallel",
  "explanation": "brief explanation of the strategy"
}

Provide your analysis as valid JSON:`;
  }

  /**
   * Create a query plan using LLM (if available)
   */
  public async createPlan(
    query: string,
    options: QueryPlannerOptions = {}
  ): Promise<QueryPlan> {
    this.logger.info('Creating query plan', {
      query: query.substring(0, 100),
      useLLM: options.useLLM,
    });

    try {
      // Use LLM-based planning if enabled and available
      if (options.useLLM !== false) {
        const llmPlan = await this.createLLMPlan(query, options);
        if (llmPlan) {
          return llmPlan;
        }
      }

      // Fallback to heuristic-based planning
      this.logger.debug('Using heuristic-based planning (LLM not available)');
      return this.createHeuristicPlan(query, options);
    } catch (error) {
      this.logger.error('Failed to create query plan', {
        error: error instanceof Error ? error.message : String(error),
        query: query.substring(0, 100),
      });

      // Fallback to simple plan
      return this.createSimplePlan(query, options);
    }
  }

  /**
   * Create a plan using VS Code Language Model API
   */
  private async createLLMPlan(
    query: string,
    options: QueryPlannerOptions
  ): Promise<QueryPlan | null> {
    try {
      // Get VS Code Language Model
      const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
      const modelFamily = options.modelFamily || config.get<string>(CONFIG.AGENTIC_LLM_MODEL, 'gpt-4o');

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

      // Build prompt
      const prompt = this.buildPrompt(query, context);

      // Send request to LLM
      const messages = [
        { role: 1, content: prompt } as any, // UserMessage role
      ];

      const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

      // Collect response
      let responseText = '';
      for await (const chunk of response.text) {
        responseText += chunk;
      }

      this.logger.debug('LLM response received', {
        responseLength: responseText.length,
      });

      // Parse JSON response
      // Extract JSON from markdown code blocks if present
      const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/) || responseText.match(/```\n([\s\S]*?)\n```/);
      const jsonText = jsonMatch ? jsonMatch[1] : responseText;

      const parsedJSON = JSON.parse(jsonText.trim());
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

      this.logger.info('LLM query plan created', {
        complexity: plan.complexity,
        subQueryCount: plan.subQueries.length,
        strategy: plan.strategy,
      });

      return plan;
    } catch (error) {
      this.logger.warn('LLM planning failed, will use fallback', {
        error: error instanceof Error ? error.message : String(error),
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
    this.logger.debug('Creating heuristic query plan');

    const defaultTopK = options.defaultTopK || 5;

    // Analyze query for complexity indicators
    const hasComparison = /\b(vs|versus|compare|difference|between|better|worse)\b/i.test(query);
    const hasMultipleQuestions = (query.match(/\?/g) || []).length > 1;
    const hasMultipleConcepts = query.split(/\band\b|\bor\b/i).length > 2;
    const isLongQuery = query.split(/\s+/).length > 15;

    let complexity: 'simple' | 'moderate' | 'complex';
    let subQueries: SubQuery[];
    let strategy: 'sequential' | 'parallel';
    let explanation: string;

    if (hasComparison) {
      // Comparison query
      complexity = 'complex';
      strategy = 'parallel';

      const parts = query.split(/\b(vs|versus|compare|difference|between)\b/i);
      subQueries = parts
        .filter((p) => p.trim().length > 3)
        .filter((p) => !/^(vs|versus|compare|difference|between|and)$/i.test(p.trim()))
        .map((part, index) => ({
          query: part.trim(),
          reasoning: `Search for information about ${part.trim()}`,
          topK: defaultTopK,
          priority: 'high' as const,
        }));

      explanation = 'Comparison query broken into parallel searches for each concept';
    } else if (hasMultipleQuestions || hasMultipleConcepts) {
      // Multiple concepts - moderate complexity
      complexity = 'moderate';
      strategy = 'parallel';

      // Split by common delimiters
      const parts = query.split(/[.!?;]\s+|\band\b/i);
      subQueries = parts
        .filter((p) => p.trim().length > 5)
        .slice(0, options.maxSubQueries || 3)
        .map((part) => ({
          query: part.trim(),
          reasoning: `Search for ${part.trim()}`,
          topK: defaultTopK,
          priority: 'medium' as const,
        }));

      explanation = 'Multi-concept query split into parallel searches';
    } else if (isLongQuery) {
      // Long query - extract key phrases
      complexity = 'moderate';
      strategy = 'sequential';

      // Use the full query plus extract key noun phrases
      subQueries = [
        {
          query: query,
          reasoning: 'Full query for comprehensive search',
          topK: defaultTopK,
          priority: 'high' as const,
        },
      ];

      explanation = 'Long query searched as-is with follow-up capability';
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
    });

    return plan;
  }

  /**
   * Create a simple fallback plan (single query)
   */
  private createSimplePlan(query: string, options: QueryPlannerOptions): QueryPlan {
    this.logger.debug('Creating simple fallback plan');

    const defaultTopK = options.defaultTopK || 5;

    return {
      originalQuery: query,
      complexity: 'simple',
      subQueries: [
        {
          query: query,
          reasoning: 'Direct search',
          topK: defaultTopK,
          priority: 'high',
        },
      ],
      strategy: 'parallel',
      explanation: 'Simple single-query search',
    };
  }

  /**
   * Build context string from options
   */
  private buildContextString(options: QueryPlannerOptions): string {
    const parts: string[] = [];

    if (options.topicName) {
      parts.push(`Topic: ${options.topicName}`);
    }

    if (options.workspaceContext) {
      parts.push(`Workspace Context: ${options.workspaceContext}`);
    }

    if (parts.length === 0) {
      return 'No additional context provided.';
    }

    return parts.join('\n');
  }

  /**
   * Validate a query plan
   */
  public validatePlan(plan: QueryPlan): boolean {
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

    return true;
  }
}
