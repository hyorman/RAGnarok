import { expect } from "chai";
import mockVscode from "../test-harness/setup";
import { TopicManager, RetrievalStrategy, IConfigProvider, ILLMProvider, TopicEmptyError } from "@ragnarok/core";
import { RAGTool, WorkspaceContextProvider, VSCODE_CONFIG } from "@ragnarok/vscode";

const mockConfig: IConfigProvider = {
  get: <T>(_key: string, defaultValue: T): T => defaultValue,
};

describe("RAGTool workspace context gating", function () {
  let originalGetConfiguration: typeof mockVscode.workspace.getConfiguration;
  let originalGetContext: typeof WorkspaceContextProvider.getContext;
  let originalSubscribe: typeof TopicManager.onAgentCacheCleanup.subscribe;

  beforeEach(function () {
    originalGetConfiguration = mockVscode.workspace.getConfiguration;
    originalGetContext = WorkspaceContextProvider.getContext;
    originalSubscribe = TopicManager.onAgentCacheCleanup.subscribe;

    (TopicManager.onAgentCacheCleanup as any).subscribe = () => ({ unsubscribe: () => {} });

    mockVscode.workspace.getConfiguration = (section?: string) => {
      const baseConfig = originalGetConfiguration(section);
      return {
        ...baseConfig,
        get: <T>(key: string, defaultValue?: T): T => {
          if (key === VSCODE_CONFIG.INCLUDE_WORKSPACE) {
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
    (TopicManager.onAgentCacheCleanup as any).subscribe = originalSubscribe;
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
    // Every argument the executor forwards to the service, so the options-object
    // hop can be asserted member by member (a dropped optional still compiles).
    const capturedArgs: any[][] = [];

    // Stub the ragQueryService so we can capture the extraAgentOptions passed into it
    const fakeResult = {
      query: "q",
      topicName: "Docs",
      topicMatched: "exact",
      results: [
        {
          text: "Result text",
          documentName: "doc.md",
          similarity: 0.9,
          retrievalStrategy: RetrievalStrategy.HYBRID,
          metadata: { chunkIndex: 0, position: "chars 0-0" },
        },
      ],
      agenticMetadata: {
        mode: "agentic" as const,
        steps: [],
        totalIterations: 1,
        queryComplexity: "simple",
        confidence: 0.9,
      },
    };

    tool.ragQueryService = {
      executeQuery: async (...args: any[]) => {
        capturedArgs.push(args);
        capturedOptions.push(args[1]);
        return fakeResult;
      },
      clearAgentCache: () => undefined,
      dispose: () => undefined,
    };

    return { tool, capturedOptions, capturedArgs };
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
    expect(capturedOptions[0]).to.equal(undefined);
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
    expect(capturedOptions[0]).to.be.a("string");
    expect(capturedOptions[0]).to.include("src/index.ts");
  });

  it("handles already-aborted query signals and awaits async query cleanup", async function () {
    const noLLMProvider: ILLMProvider = {
      selectModel: async () => null,
      isAvailable: async () => false,
    };
    const { tool } = await createConfiguredTool(noLLMProvider);
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    try {
      await tool.executeQuery({ topic: "Docs", query: "cancel me" }, controller.signal);
      expect.fail("expected cancellation");
    } catch (error) {
      expect((error as Error).message).to.include("already cancelled");
    }

    let disposed = false;
    tool.ragQueryService = {
      executeQuery: async (_params: any, _context: any, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) {
            abort();
          } else {
            signal.addEventListener("abort", abort, { once: true });
          }
        }),
      clearAgentCache: () => undefined,
      dispose: async () => {
        disposed = true;
      },
    };
    const active = tool.executeQuery({ topic: "Docs", query: "active query" });
    const shutdown = tool.disposeAsync();
    await Promise.allSettled([active, shutdown]);
    expect(disposed).to.equal(true);
  });

  it("returns the honest empty payload for a topic with no documents", async function () {
    const noLLMProvider: ILLMProvider = {
      selectModel: async () => null,
      isAvailable: async () => false,
    };
    const { tool } = await createConfiguredTool(noLLMProvider);
    tool.ragQueryService = {
      executeQuery: async () => {
        throw new TopicEmptyError("Empty");
      },
      clearAgentCache: () => undefined,
      dispose: async () => undefined,
    };

    const payload = await tool.executeQuery({ topic: "Empty", query: "anything" });

    expect(payload).to.include({ empty: true, topicMatched: "fallback", topicName: "Empty" });
    expect(payload.query).to.equal("anything");
    expect(payload.results).to.deep.equal([]);
    expect(payload.message).to.equal(new TopicEmptyError("Empty").message);
    // The old code fabricated agenticMetadata describing a retrieval run that
    // never happened. The canonical payload MCP returns has none.
    expect(payload).to.not.have.property("agenticMetadata");
  });

  it("forwards normalized params, the workspace context, and the caller's signal to the shared executor", async function () {
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
    const { tool, capturedArgs } = await createConfiguredTool(withLLMProvider);
    WorkspaceContextProvider.getContext = async () =>
      ({
        workspace: { name: "workspace" },
        activeFile: { path: "src/index.ts", language: "typescript", symbols: [] },
      }) as any;

    // Drive the private core directly so the signal we assert on by identity is
    // the one this hop is supposed to hand over. The public executeQuery wraps
    // the caller's signal in a fresh admission-control controller by design.
    const signal = new AbortController().signal;
    await tool.executeQueryCore(
      {
        topic: "  Docs  ",
        query: "  Explain the current codebase structure  ",
        topK: 3,
        retrievalStrategy: RetrievalStrategy.HYBRID,
      },
      signal,
    );

    expect(capturedArgs).to.have.lengthOf(1);
    const [params, workspaceContext, forwardedSignal] = capturedArgs[0];
    // Trimmed by the shared executor — a direct service call would forward the
    // padded strings verbatim.
    expect(params).to.deep.equal({
      topic: "Docs",
      query: "Explain the current codebase structure",
      topK: 3,
      retrievalStrategy: RetrievalStrategy.HYBRID,
    });
    expect(workspaceContext, "the editor context must survive the options object").to.be.a("string");
    expect(workspaceContext).to.include("src/index.ts");
    // By identity: two fresh AbortSignals are deep-equal, so a deep assertion
    // would accept a handler that manufactured its own.
    expect(forwardedSignal, "the caller's signal, by identity").to.equal(signal);
  });

  it("forwards an undefined workspace context when the gate is closed", async function () {
    const noLLMProvider: ILLMProvider = {
      selectModel: async () => null,
      isAvailable: async () => false,
    };
    const { tool, capturedArgs } = await createConfiguredTool(noLLMProvider);
    WorkspaceContextProvider.getContext = async () => {
      throw new Error("workspace context must not be collected when the gate is closed");
    };

    const signal = new AbortController().signal;
    await tool.executeQueryCore({ topic: "Docs", query: "What is RAG?" }, signal);

    expect(capturedArgs).to.have.lengthOf(1);
    const [params, workspaceContext, forwardedSignal] = capturedArgs[0];
    expect(params).to.deep.equal({ topic: "Docs", query: "What is RAG?" });
    expect(workspaceContext, "no context in, no context out").to.equal(undefined);
    expect(forwardedSignal, "the caller's signal, by identity").to.equal(signal);
  });
});
