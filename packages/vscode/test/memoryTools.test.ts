import { expect } from "chai";
import sinon from "sinon";
import mockVscode from "../test-harness/setup";
import {
  MemoryServiceError,
  type MemoryOperationInput,
  type MemoryOperationResult,
  type MemoryService,
} from "@ragnarok/core";
import {
  registerMemoryTools,
  TOOLS,
  type ExtensionOperationRunner,
  type MemoryHostContextHost,
  type LanguageModelToolRegistrationHost,
} from "@ragnarok/vscode";

function token() {
  const listeners = new Set<() => void>();
  return {
    isCancellationRequested: false,
    onCancellationRequested(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    cancel() {
      this.isCancellationRequested = true;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function registrationHarness(
  result: MemoryOperationResult = { action: "forget", forgottenCount: 0 },
  runOperation: ExtensionOperationRunner = async (_label, operation) => operation(new AbortController().signal),
) {
  const tools = new Map<string, any>();
  const registrations: Array<{ disposed: boolean }> = [];
  const registrationHost: LanguageModelToolRegistrationHost = {
    registerTool(name, tool) {
      tools.set(name, tool);
      const state = { disposed: false };
      registrations.push(state);
      return { dispose: () => (state.disposed = true) };
    },
    createToolResult: (content) => new mockVscode.LanguageModelToolResult(content),
    createTextPart: (value) => new mockVscode.LanguageModelTextPart(value),
  };
  const memoryService = {
    execute: sinon.stub().resolves(result),
  };
  const contextHost: MemoryHostContextHost = {
    workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
    getWorkspaceFolder: () => undefined,
    getCurrentBranch: async () => "main",
  };
  const operationRunner = sinon.spy(runOperation) as sinon.SinonSpy & ExtensionOperationRunner;

  const registration = registerMemoryTools(
    memoryService as unknown as Pick<MemoryService, "execute">,
    operationRunner,
    {
      registrationHost,
      contextHost,
    },
  );
  return { tools, registrations, registration, memoryService, operationRunner };
}

function outputJson(result: any): unknown {
  return JSON.parse(result.content[0].value);
}

async function caughtError(operation: Promise<unknown>): Promise<Error> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).to.be.instanceOf(Error);
  return caught as Error;
}

describe("VS Code native memory tools", function () {
  afterEach(() => sinon.restore());

  // ragResetMemory is deliberately not a model-callable tool: destructive memory
  // reset is a human action in the sidebar, not something a model may decide.
  it("registers only ragMemory and disposes it through the returned registration", function () {
    const harness = registrationHarness();

    expect([...harness.tools.keys()]).to.deep.equal([TOOLS.RAG_MEMORY]);
    expect(Object.values(TOOLS)).to.not.include("ragResetMemory");
    harness.registration.dispose();
    expect(harness.registrations.map(({ disposed }) => disposed)).to.deep.equal([true]);
  });

  const cases: Array<{ input: Record<string, unknown>; forwarded: MemoryOperationInput }> = [
    {
      input: {
        action: "store",
        content: "remember",
        scope: "branch",
        branch: "dev",
        tags: ["x"],
        ttlDays: 3,
        query: "ignored",
      },
      forwarded: { action: "store", content: "remember", scope: "branch", branch: "dev", tags: ["x"], ttlDays: 3 },
    },
    {
      input: {
        action: "recall",
        query: "fact",
        topK: 8,
        includeEntities: true,
        includeAuto: true,
        reinforce: false,
        scope: "workspace",
        branch: "ignored",
        tags: ["ignored"],
      },
      forwarded: {
        action: "recall",
        query: "fact",
        topK: 8,
        includeEntities: true,
        includeAuto: true,
        reinforce: false,
        scope: "workspace",
        branch: "ignored",
      },
    },
    {
      input: { action: "forget", id: "one", olderThan: 2, expired: true, scope: "branch", branch: "dev" },
      forwarded: { action: "forget", id: "one", olderThan: 2, expired: true, scope: "branch", branch: "dev" },
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
    { input: { action: "history", id: "one", branch: "ignored" }, forwarded: { action: "history", id: "one" } },
    {
      input: { action: "promote", branch: "dev", id: "one", ids: ["two"], scope: "workspace" },
      forwarded: { action: "promote", branch: "dev", id: "one", ids: ["two"] },
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
    it(`normalizes ${input.action} input for the core service`, async function () {
      const harness = registrationHarness();
      const cancellation = token();

      await harness.tools.get(TOOLS.RAG_MEMORY).invoke({ input }, cancellation);

      expect(harness.memoryService.execute.calledOnce).to.equal(true);
      expect(harness.memoryService.execute.firstCall.args[0]).to.deep.equal(forwarded);
      const explicitBranch = "branch" in forwarded ? forwarded.branch : undefined;
      expect(harness.memoryService.execute.firstCall.args[1]).to.deep.equal({
        workingDir: explicitBranch ? "" : "/workspace",
        branchContext: { state: "resolved", branch: explicitBranch ?? "main" },
      });
      expect(harness.operationRunner.calledOnce).to.equal(true);
    });
  }

  const trimmedCases: Array<{ input: Record<string, unknown>; forwarded: MemoryOperationInput }> = [
    {
      input: {
        action: "store",
        content: "  remember this  ",
        branch: "  feature/padded  ",
        tags: ["  one  ", "two"],
      },
      forwarded: {
        action: "store",
        content: "remember this",
        branch: "feature/padded",
        tags: ["one", "two"],
      },
    },
    {
      input: { action: "recall", query: "  known facts  " },
      forwarded: { action: "recall", query: "known facts" },
    },
    {
      input: { action: "forget", id: "  memory-1  ", branch: "  dev  " },
      forwarded: { action: "forget", id: "memory-1", branch: "dev" },
    },
    {
      input: { action: "promote", branch: "  dev  ", id: "  memory-1  ", ids: ["  memory-2  ", "memory-3"] },
      forwarded: { action: "promote", branch: "dev", id: "memory-1", ids: ["memory-2", "memory-3"] },
    },
  ];

  for (const { input, forwarded } of trimmedCases) {
    it(`trims MCP-compatible ${input.action} string inputs before mapping to core`, async function () {
      const harness = registrationHarness();

      await harness.tools.get(TOOLS.RAG_MEMORY).invoke({ input }, token());

      expect(harness.memoryService.execute.calledOnce).to.equal(true);
      expect(harness.memoryService.execute.firstCall.args[0]).to.deep.equal(forwarded);
    });
  }

  const whitespaceCases: Array<{ field: string; input: Record<string, unknown> }> = [
    { field: "content", input: { action: "store", content: "   " } },
    { field: "query", input: { action: "recall", query: "   " } },
    { field: "id", input: { action: "forget", id: "   ", expired: true } },
    { field: "branch", input: { action: "list", branch: "   " } },
    { field: "tags", input: { action: "store", content: "valid", tags: ["   "] } },
    { field: "ids", input: { action: "promote", branch: "dev", ids: ["   "] } },
  ];

  for (const { field, input } of whitespaceCases) {
    it(`returns a structured invalid-input error for whitespace-only ${field}`, async function () {
      const harness = registrationHarness();

      const output = await harness.tools.get(TOOLS.RAG_MEMORY).invoke({ input }, token());

      const payload = outputJson(output) as { error: { code: string; message: string } };
      expect(payload.error.code).to.equal("MEMORY_INVALID_INPUT");
      expect(payload.error.message).to.include(field);
      expect(harness.memoryService.execute.called).to.equal(false);
    });
  }

  it("returns MemoryServiceError rejections as structured tool output", async function () {
    const harness = registrationHarness();
    harness.memoryService.execute.rejects(new MemoryServiceError("MEMORY_BRANCH_UNAVAILABLE", "no branch"));

    const output = await harness.tools
      .get(TOOLS.RAG_MEMORY)
      .invoke({ input: { action: "recall", query: "q", scope: "branch" } }, token());

    expect(outputJson(output)).to.deep.equal({
      error: { code: "MEMORY_BRANCH_UNAVAILABLE", message: "no branch" },
    });
  });

  // VS Code does not enforce the contributed inputSchema before invoking a tool,
  // so an action the manifest never declares can reach the shared normalizer.
  it("returns a structured invalid-input error for an unrecognized action", async function () {
    const harness = registrationHarness();

    const output = await harness.tools.get(TOOLS.RAG_MEMORY).invoke({ input: { action: "reset" } }, token());

    const payload = outputJson(output) as { error: { code: string; message: string } };
    expect(payload.error.code).to.equal("MEMORY_INVALID_INPUT");
    expect(payload.error.message).to.include("reset");
    expect(harness.memoryService.execute.called).to.equal(false);
  });

  it("still rejects unexpected non-service errors", async function () {
    const harness = registrationHarness();
    harness.memoryService.execute.rejects(new Error("disk gone"));

    const error = await caughtError(
      harness.tools.get(TOOLS.RAG_MEMORY).invoke({ input: { action: "stats" } }, token()),
    );

    expect(error.message).to.equal("disk gone");
  });

  it("bridges VS Code cancellation into the lifecycle operation signal", async function () {
    let invocationSignal: AbortSignal | undefined;
    let admitted!: () => void;
    const serviceAdmitted = new Promise<void>((resolve) => (admitted = resolve));
    const harness = registrationHarness();
    harness.memoryService.execute.callsFake(async (_input, _context, signal) => {
      invocationSignal = signal;
      admitted();
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const cancellation = token();
    const pending = harness.tools.get(TOOLS.RAG_MEMORY).invoke({ input: { action: "stats" } }, cancellation);

    await serviceAdmitted;
    cancellation.cancel();

    try {
      await pending;
      expect.fail("expected cancellation");
    } catch {
      expect(invocationSignal?.aborted).to.equal(true);
    }
  });

  it("rejects a pre-cancelled token before executing memory", async function () {
    const harness = registrationHarness();
    const cancellation = token();
    cancellation.cancel();

    const error = await caughtError(
      harness.tools.get(TOOLS.RAG_MEMORY).invoke({ input: { action: "stats" } }, cancellation),
    );

    expect(error.message).to.include("cancelled");
    expect(harness.memoryService.execute.called).to.equal(false);
  });

  it("forwards lifecycle-runner abort before executing memory", async function () {
    const lifecycleError = new Error("lifecycle stopped");
    const harness = registrationHarness(undefined, async (_label, operation) => {
      const controller = new AbortController();
      controller.abort(lifecycleError);
      return operation(controller.signal);
    });

    const error = await caughtError(
      harness.tools.get(TOOLS.RAG_MEMORY).invoke({ input: { action: "stats" } }, token()),
    );

    expect(error).to.equal(lifecycleError);
    expect(harness.memoryService.execute.called).to.equal(false);
  });

  it("executes once, reduces the completed result to the token budget, and returns pretty JSON", async function () {
    const result: MemoryOperationResult = {
      action: "list",
      memories: [
        {
          id: "one",
          content: "long memory content",
          scope: "workspace",
          tags: [],
          accessCount: 1,
          createdAt: "2026-08-13T00:00:00.000Z",
        },
      ],
      count: 1,
    };
    const harness = registrationHarness(result);
    const countTokens = sinon.spy(async (text: string) => JSON.parse(text).memories?.[0]?.content.length ?? 0);

    const output = await harness.tools
      .get(TOOLS.RAG_MEMORY)
      .invoke({ input: { action: "list" }, tokenizationOptions: { tokenBudget: 4, countTokens } }, token());

    expect(harness.memoryService.execute.calledOnce).to.equal(true);
    expect(countTokens.callCount).to.be.greaterThan(0);
    expect(output.content[0].value).to.equal(JSON.stringify(outputJson(output), null, 2));
    expect(outputJson(output)).to.deep.include({
      action: "list",
      count: 1,
      responseMeta: { truncated: true, returnedCount: 1, totalCount: 1, reason: "tokenBudget" },
    });
    expect((outputJson(output) as any).memories[0].content).to.equal("long");
  });

  it("does not swallow cancellation raised during token measurement", async function () {
    const result: MemoryOperationResult = {
      action: "store",
      memory: {
        id: "one",
        content: "remember",
        scope: "workspace",
        entityIds: [],
        tags: [],
        createdAt: "2026-08-13T00:00:00.000Z",
      },
    };
    const harness = registrationHarness(result);
    const cancellation = token();
    const pending = harness.tools.get(TOOLS.RAG_MEMORY).invoke(
      {
        input: { action: "store", content: "remember" },
        tokenizationOptions: {
          tokenBudget: 1,
          countTokens: async () => {
            cancellation.cancel();
            throw new Error("token counting cancelled");
          },
        },
      },
      cancellation,
    );

    try {
      await pending;
      expect.fail("expected cancellation");
    } catch (error) {
      expect((error as Error).message).to.include("cancelled");
    }
    expect(harness.memoryService.execute.calledOnce).to.equal(true);
  });
});
