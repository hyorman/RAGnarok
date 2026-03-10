import { expect } from 'chai';
import mockVscode from '../setup';
import { RAGTool } from '../../src/ragTool';
import { QueryPlannerAgent } from '../../src/agents/queryPlannerAgent';
import { TopicManager } from '../../src/managers/topicManager';
import { WorkspaceContextProvider } from '../../src/utils/workspaceContext';
import { CONFIG } from '../../src/utils/constants';
import { RetrievalStrategy } from '../../src/utils/types';

describe('RAGTool workspace context gating', function() {
  let originalGetConfiguration: typeof mockVscode.workspace.getConfiguration;
  let originalCanRefineWithLLM: typeof QueryPlannerAgent.canRefineWithLLM;
  let originalGetContext: typeof WorkspaceContextProvider.getContext;
  let originalTopicManagerGetInstance: typeof TopicManager.getInstance;
  let originalRegisterCleanup: typeof TopicManager.registerAgentCacheCleanupCallback;

  beforeEach(function() {
    originalGetConfiguration = mockVscode.workspace.getConfiguration;
    originalCanRefineWithLLM = QueryPlannerAgent.canRefineWithLLM;
    originalGetContext = WorkspaceContextProvider.getContext;
    originalTopicManagerGetInstance = TopicManager.getInstance;
    originalRegisterCleanup = TopicManager.registerAgentCacheCleanupCallback;

    TopicManager.getInstance = async () => ({
      getTopicStats: async () => ({ documentCount: 1, chunkCount: 2 }),
    } as any);
    TopicManager.registerAgentCacheCleanupCallback = () => undefined;

    mockVscode.workspace.getConfiguration = (section?: string) => {
      const baseConfig = originalGetConfiguration(section);
      return {
        ...baseConfig,
        get: <T>(key: string, defaultValue?: T): T => {
          if (key === CONFIG.INCLUDE_WORKSPACE) {
            return true as T;
          }
          return baseConfig.get(key, defaultValue);
        },
      };
    };
  });

  afterEach(function() {
    mockVscode.workspace.getConfiguration = originalGetConfiguration;
    QueryPlannerAgent.canRefineWithLLM = originalCanRefineWithLLM;
    WorkspaceContextProvider.getContext = originalGetContext;
    TopicManager.getInstance = originalTopicManagerGetInstance;
    TopicManager.registerAgentCacheCleanupCallback = originalRegisterCleanup;
  });

  async function createConfiguredTool() {
    const tool = new RAGTool() as any;
    const capturedOptions: any[] = [];

    tool.embeddingService = { initialize: async () => undefined };
    tool.topicManager = Promise.resolve({
      getTopicStats: async () => ({ documentCount: 1, chunkCount: 2 }),
    });
    tool.findBestMatchingTopic = async () => ({
      topic: { id: 'topic-1', name: 'Docs' },
      matchType: 'exact',
      availableTopics: undefined,
    });
    tool.getOrCreateAgent = async () => ({
      query: async (_query: string, options: any) => {
        capturedOptions.push(options);
        return {
          query: _query,
          plan: {
            originalQuery: _query,
            complexity: 'simple',
            subQueries: [
              { query: _query, reasoning: 'Direct search', topK: 5, priority: 'high' },
            ],
            strategy: 'parallel',
            explanation: 'Simple query',
          },
          results: [
            {
              document: {
                pageContent: 'Result text',
                metadata: { source: 'doc.md', chunkIndex: 0 },
              },
              score: 0.9,
              source: RetrievalStrategy.HYBRID,
            },
          ],
          iterations: 1,
          avgConfidence: 0.9,
          confidenceMet: true,
        };
      },
    });

    return { tool, capturedOptions };
  }

  it('should skip workspace context collection when LLM refinement is unavailable', async function() {
    const { tool, capturedOptions } = await createConfiguredTool();
    let contextCalls = 0;

    QueryPlannerAgent.canRefineWithLLM = async () => false;
    WorkspaceContextProvider.getContext = async () => {
      contextCalls++;
      return { workspace: { name: 'workspace' } } as any;
    };

    await tool.executeQuery({
      topic: 'Docs',
      query: 'What is RAG?',
      topK: 3,
      retrievalStrategy: RetrievalStrategy.HYBRID,
    });

    expect(contextCalls).to.equal(0);
    expect(capturedOptions).to.have.lengthOf(1);
    expect(capturedOptions[0].workspaceContext).to.equal(undefined);
  });

  it('should collect workspace context when LLM refinement is available', async function() {
    const { tool, capturedOptions } = await createConfiguredTool();
    let contextCalls = 0;

    QueryPlannerAgent.canRefineWithLLM = async () => true;
    WorkspaceContextProvider.getContext = async () => {
      contextCalls++;
      return {
        workspace: { name: 'workspace' },
        activeFile: { path: 'src/index.ts', language: 'typescript', symbols: [] },
      } as any;
    };

    await tool.executeQuery({
      topic: 'Docs',
      query: 'Explain the current codebase structure',
      topK: 3,
      retrievalStrategy: RetrievalStrategy.HYBRID,
    });

    expect(contextCalls).to.equal(1);
    expect(capturedOptions).to.have.lengthOf(1);
    expect(capturedOptions[0].workspaceContext).to.be.a('string');
    expect(capturedOptions[0].workspaceContext).to.include('src/index.ts');
  });
});