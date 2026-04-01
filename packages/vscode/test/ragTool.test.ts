import { expect } from "chai";
import mockVscode from "../../../test/setup";
import { TopicManager, CONFIG, RetrievalStrategy, IConfigProvider, ILLMProvider } from "@ragnarok/core";
import { RAGTool, WorkspaceContextProvider } from "@ragnarok/vscode";

const mockConfig: IConfigProvider = {
  get: <T>(_key: string, defaultValue: T): T => defaultValue,
};

describe("RAGTool workspace context gating", function () {
  let originalGetConfiguration: typeof mockVscode.workspace.getConfiguration;
  let originalGetContext: typeof WorkspaceContextProvider.getContext;
  let originalRegisterCleanup: typeof TopicManager.registerAgentCacheCleanupCallback;

  beforeEach(function () {
    originalGetConfiguration = mockVscode.workspace.getConfiguration;
    originalGetContext = WorkspaceContextProvider.getContext;
    originalRegisterCleanup = TopicManager.registerAgentCacheCleanupCallback;

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

  afterEach(function () {
    mockVscode.workspace.getConfiguration = originalGetConfiguration;
    WorkspaceContextProvider.getContext = originalGetContext;
    TopicManager.registerAgentCacheCleanupCallback = originalRegisterCleanup;
  });

  async function createConfiguredTool(llmProvider: ILLMProvider) {
    const mockTopicManager = {
      getTopicStats: async () => ({ documentCount: 1, chunkCount: 2 }),
    } as any;
    const mockEmbeddingService = {
      initialize: async () => undefined,
    } as any;

    const tool = new RAGTool(mockTopicManager, mockEmbeddingService, mockConfig, llmProvider) as any;
    const capturedOptions: any[] = [];

    tool.topicManager = Promise.resolve({
      getTopicStats: async () => ({ documentCount: 1, chunkCount: 2 }),
    });
    tool.findBestMatchingTopic = async () => ({
      topic: { id: "topic-1", name: "Docs" },
      matchType: "exact",
      availableTopics: undefined,
    });
    tool.getOrCreateAgent = async () => ({
      query: async (_query: string, options: any) => {
        capturedOptions.push(options);
        return {
          query: _query,
          plan: {
            originalQuery: _query,
            complexity: "simple",
            subQueries: [{ query: _query, reasoning: "Direct search", topK: 5, priority: "high" }],
            strategy: "parallel",
            explanation: "Simple query",
          },
          results: [
            {
              document: {
                pageContent: "Result text",
                metadata: { source: "doc.md", chunkIndex: 0 },
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

  it("should skip workspace context collection when LLM refinement is unavailable", async function () {
    // LLM provider that returns no model → canRefineWithLLM will return false
    const noLLMProvider: ILLMProvider = {
      selectModel: async () => null,
      isAvailable: async () => false,
    };

    const { tool, capturedOptions } = await createConfiguredTool(noLLMProvider);
    let contextCalls = 0;

    WorkspaceContextProvider.getContext = async () => {
      contextCalls++;
      return { workspace: { name: "workspace" } } as any;
    };

    await tool.executeQuery({
      topic: "Docs",
      query: "What is RAG?",
      topK: 3,
      retrievalStrategy: RetrievalStrategy.HYBRID,
    });

    expect(contextCalls).to.equal(0);
    expect(capturedOptions).to.have.lengthOf(1);
    expect(capturedOptions[0].workspaceContext).to.equal(undefined);
  });

  it("should collect workspace context when LLM refinement is available", async function () {
    // LLM provider that returns a mock model → canRefineWithLLM will return true
    const withLLMProvider: ILLMProvider = {
      selectModel: async () => ({
        id: "mock-model",
        family: "gpt-4o",
        sendRequest: async () =>
          (async function* () {
            yield "test";
          })(),
      }),
      isAvailable: async () => true,
    };

    const { tool, capturedOptions } = await createConfiguredTool(withLLMProvider);
    let contextCalls = 0;

    WorkspaceContextProvider.getContext = async () => {
      contextCalls++;
      return {
        workspace: { name: "workspace" },
        activeFile: { path: "src/index.ts", language: "typescript", symbols: [] },
      } as any;
    };

    await tool.executeQuery({
      topic: "Docs",
      query: "Explain the current codebase structure",
      topK: 3,
      retrievalStrategy: RetrievalStrategy.HYBRID,
    });

    expect(contextCalls).to.equal(1);
    expect(capturedOptions).to.have.lengthOf(1);
    expect(capturedOptions[0].workspaceContext).to.be.a("string");
    expect(capturedOptions[0].workspaceContext).to.include("src/index.ts");
  });
});
