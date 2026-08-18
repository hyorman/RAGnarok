import { expect } from "chai";
import sinon from "sinon";
import { McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "../src/tools";
import type { MemoryOperationInput, MemoryService, MemoryStore, RAGQueryService, TopicManager } from "@ragnarok/core";

type ToolHandler = (...args: any[]) => Promise<any>;

function parseResponse(result: any): any {
  return JSON.parse(result.content[0].text);
}

function makeServerContext(signal = new AbortController().signal): any {
  return { mcpReq: { signal } };
}

function captureHandlers(options: {
  memoryService?: Pick<MemoryService, "execute" | "reset">;
  branchProvider?: Pick<MemoryStore, "getCurrentBranch">;
  workingDir?: string;
}): Record<string, ToolHandler> {
  const captured: Array<{ name: string; handler: ToolHandler }> = [];
  const server = {
    registerTool(name: string, _config: unknown, handler: ToolHandler) {
      captured.push({ name, handler });
      return { name };
    },
  } as unknown as McpServer;
  const topicManager = {
    getAllTopics: sinon.stub().returns([]),
    getVectorStore: sinon.stub().resolves(null),
  } as unknown as TopicManager;
  registerTools(
    server,
    topicManager,
    {} as RAGQueryService,
    options.memoryService as MemoryService | undefined,
    undefined,
    options.branchProvider,
    { workingDir: options.workingDir ?? "/workspace" } as any,
  );

  return Object.fromEntries(
    captured.map(({ name, handler }) => [name, (args: any, context = makeServerContext()) => handler(args, context)]),
  );
}

describe("MCP memory tools", () => {
  let memoryService: { execute: sinon.SinonStub; reset: sinon.SinonStub };
  let branchProvider: { getCurrentBranch: sinon.SinonStub };
  let handlers: Record<string, ToolHandler>;

  beforeEach(() => {
    memoryService = {
      execute: sinon.stub().callsFake(async (input: MemoryOperationInput) => ({ action: input.action })),
      reset: sinon.stub().resolves({ success: true }),
    };
    branchProvider = { getCurrentBranch: sinon.stub().resolves("feature/core-memory") };
    handlers = captureHandlers({ memoryService: memoryService as any, branchProvider, workingDir: "/project" });
  });

  afterEach(() => sinon.restore());

  it("registers reset with only the service while memory also requires the branch provider", () => {
    expect(handlers.rag_memory).to.be.a("function");
    expect(handlers.rag_reset_memory).to.be.a("function");
    expect(captureHandlers({ branchProvider }).rag_memory).to.equal(undefined);
    const serviceOnly = captureHandlers({ memoryService: memoryService as any });
    expect(serviceOnly.rag_reset_memory).to.be.a("function");
    expect(serviceOnly.rag_memory).to.equal(undefined);
  });

  const cases: Array<{ input: Record<string, unknown>; forwarded: MemoryOperationInput }> = [
    {
      input: {
        action: "store",
        content: "remember",
        scope: "branch",
        branch: "feature/x",
        tags: ["one"],
        ttlDays: 3,
        query: "ignored",
      },
      forwarded: {
        action: "store",
        content: "remember",
        scope: "branch",
        branch: "feature/x",
        tags: ["one"],
        ttlDays: 3,
      },
    },
    {
      input: {
        action: "recall",
        query: "known facts",
        topK: 8,
        includeEntities: true,
        includeAuto: true,
        reinforce: false,
        scope: "workspace",
        branch: "ignored-by-core",
        tags: ["ignored"],
      },
      forwarded: {
        action: "recall",
        query: "known facts",
        topK: 8,
        includeEntities: true,
        includeAuto: true,
        reinforce: false,
        scope: "workspace",
        branch: "ignored-by-core",
      },
    },
    {
      input: { action: "forget", id: "memory-1", olderThan: 4, expired: true, scope: "branch", branch: "dev" },
      forwarded: { action: "forget", id: "memory-1", olderThan: 4, expired: true, scope: "branch", branch: "dev" },
    },
    { input: { action: "stats", content: "ignored" }, forwarded: { action: "stats" } },
    {
      input: { action: "list", limit: 20, includeAuto: true, scope: "branch", branch: "dev", query: "ignored" },
      forwarded: { action: "list", limit: 20, includeAuto: true, scope: "branch", branch: "dev" },
    },
    {
      input: { action: "decay", scope: "branch", branch: "dev", limit: 1 },
      forwarded: { action: "decay", scope: "branch", branch: "dev" },
    },
    {
      input: { action: "history", id: "memory-1", branch: "ignored" },
      forwarded: { action: "history", id: "memory-1" },
    },
    {
      input: { action: "promote", branch: "dev", id: "memory-1", ids: ["memory-2"], scope: "workspace" },
      forwarded: { action: "promote", branch: "dev", id: "memory-1", ids: ["memory-2"] },
    },
    {
      input: { action: "links", scope: "workspace", branch: "dev", limit: 1 },
      forwarded: { action: "links", scope: "workspace", branch: "dev" },
    },
    {
      input: { action: "communities", scope: "branch", branch: "dev", includeEntities: true },
      forwarded: { action: "communities", scope: "branch", branch: "dev" },
    },
  ];

  for (const { input, forwarded } of cases) {
    it(`forwards one normalized ${input.action} input, resolved host context, and request signal`, async () => {
      const signal = new AbortController().signal;

      const result = await handlers.rag_memory(input, makeServerContext(signal));

      expect(
        memoryService.execute.calledOnceWithExactly(
          forwarded,
          {
            workingDir: "/project",
            branchContext: { state: "resolved", branch: "feature/core-memory" },
          },
          signal,
        ),
      ).to.equal(true);
      expect(parseResponse(result)).to.deep.equal({ action: input.action });
    });
  }

  it("supplies unavailable branch context when detection returns no branch", async () => {
    branchProvider.getCurrentBranch.resolves(null);
    const signal = new AbortController().signal;

    await handlers.rag_memory({ action: "stats" }, makeServerContext(signal));

    expect(
      memoryService.execute.calledOnceWithExactly(
        { action: "stats" },
        {
          workingDir: "/project",
          branchContext: { state: "unavailable" },
        },
        signal,
      ),
    ).to.equal(true);
  });

  it("returns core errors as the canonical payload inside the MCP error envelope", async () => {
    memoryService.execute.rejects(new Error("memory failed"));

    const result = await handlers.rag_memory({ action: "list" });

    expect(result.isError).to.equal(true);
    expect(parseResponse(result)).to.deep.equal({
      error: { code: "MEMORY_OPERATION_FAILED", message: "memory failed" },
    });
  });

  it("keeps the flat error body for rag_reset_memory", async () => {
    memoryService.reset.rejects(new Error("reset failed"));

    const result = await handlers.rag_reset_memory({ confirm: true });

    expect(result.isError).to.equal(true);
    expect(parseResponse(result)).to.deep.equal({ error: "reset failed" });
  });

  it("requires confirm true in the reset schema", () => {
    const captured: any[] = [];
    const server = {
      registerTool(name: string, config: any, handler: ToolHandler) {
        captured.push({ name, config, handler });
        return { name };
      },
    } as unknown as McpServer;
    registerTools(
      server,
      { getAllTopics: sinon.stub().returns([]) } as any,
      {} as any,
      memoryService as any,
      undefined,
      branchProvider as any,
    );
    const schema = captured.find(({ name }) => name === "rag_reset_memory").config.inputSchema;

    expect(schema.safeParse({ confirm: true }).success).to.equal(true);
    expect(schema.safeParse({ confirm: false }).success).to.equal(false);
    expect(schema.safeParse({}).success).to.equal(false);
  });

  it("delegates confirmed reset with the request signal", async () => {
    const signal = new AbortController().signal;

    const result = await handlers.rag_reset_memory({ confirm: true }, makeServerContext(signal));

    expect(memoryService.reset.calledOnceWithExactly(signal)).to.equal(true);
    expect(parseResponse(result)).to.deep.equal({ success: true });
  });
});
