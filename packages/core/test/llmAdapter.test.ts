import { expect } from "chai";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import { LLMProviderChatModel } from "../src/agents/llmAdapter";
import { ILLMProvider, ILLMMessage } from "../src/interfaces";

// ── Helpers ──────────────────────────────────────────────────────────

function createMockLLMProvider(chunks: string[]): ILLMProvider {
  return {
    selectModel: async () => ({
      id: "mock-model",
      family: "mock",
      sendRequest: async (_messages: ILLMMessage[], _signal?: AbortSignal) => {
        async function* generate() {
          for (const chunk of chunks) {
            yield chunk;
          }
        }
        return generate();
      },
    }),
    isAvailable: async () => true,
  };
}

// Captures the ILLMMessage[] passed to sendRequest
function createCapturingProvider(chunks: string[]): { provider: ILLMProvider; captured: ILLMMessage[][] } {
  const captured: ILLMMessage[][] = [];
  const provider: ILLMProvider = {
    selectModel: async () => ({
      id: "mock-model",
      family: "mock",
      sendRequest: async (messages: ILLMMessage[], _signal?: AbortSignal) => {
        captured.push(messages);
        async function* generate() {
          for (const chunk of chunks) {
            yield chunk;
          }
        }
        return generate();
      },
    }),
    isAvailable: async () => true,
  };
  return { provider, captured };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("LLMProviderChatModel", function () {
  it("maps HumanMessage to ILLMMessage { role: 'user' }", async function () {
    const { provider, captured } = createCapturingProvider(["ok"]);
    const model = new LLMProviderChatModel(provider);
    await model.invoke([new HumanMessage("hello")]);

    expect(captured).to.have.lengthOf(1);
    expect(captured[0][0]).to.deep.equal({ role: "user", content: "hello" });
  });

  it("maps SystemMessage to { role: 'system' }", async function () {
    const { provider, captured } = createCapturingProvider(["ok"]);
    const model = new LLMProviderChatModel(provider);
    await model.invoke([new SystemMessage("be helpful")]);

    expect(captured[0][0]).to.deep.equal({ role: "system", content: "be helpful" });
  });

  it("maps AIMessage to { role: 'assistant' }", async function () {
    const { provider, captured } = createCapturingProvider(["ok"]);
    const model = new LLMProviderChatModel(provider);
    await model.invoke([new AIMessage("I am AI")]);

    expect(captured[0][0]).to.deep.equal({ role: "assistant", content: "I am AI" });
  });

  it("collects streaming response fragments into single text", async function () {
    const provider = createMockLLMProvider(["Hello ", "World", "!"]);
    const model = new LLMProviderChatModel(provider);
    const result = await model.invoke([new HumanMessage("hi")]);

    expect(result.content).to.equal("Hello World!");
  });

  it("returns ChatResult with AIMessage generation", async function () {
    const provider = createMockLLMProvider(["response"]);
    const model = new LLMProviderChatModel(provider);
    const result = await model.invoke([new HumanMessage("test")]);

    expect(result).to.be.instanceOf(AIMessage);
    expect(result.content).to.equal("response");
  });

  it("throws when no model available (selectModel returns null)", async function () {
    const provider: ILLMProvider = {
      selectModel: async () => null,
      isAvailable: async () => false,
    };
    const model = new LLMProviderChatModel(provider);

    try {
      await model.invoke([new HumanMessage("test")]);
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect((err as Error).message).to.include("no model available");
    }
  });

  it("_llmType returns correct string", function () {
    const provider = createMockLLMProvider(["ok"]);
    const model = new LLMProviderChatModel(provider);
    expect(model._llmType()).to.equal("ragnarok-llm-adapter");
  });
});
