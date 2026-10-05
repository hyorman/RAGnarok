import { expect } from "chai";
import { z } from "zod";
import { extractJsonObject, requestLlmJson } from "../src/agents/llmJson";
import type { ILLMModel } from "../src/interfaces";

const replying = (...chunks: string[]): ILLMModel =>
  ({
    id: "fake",
    family: "fake",
    async sendRequest() {
      return (async function* () {
        yield* chunks;
      })();
    },
  }) as unknown as ILLMModel;

/** Never replies; rejects with the signal's abort reason, as a real provider SDK does. */
const hanging: ILLMModel = {
  id: "slow",
  family: "slow",
  async sendRequest(_messages: unknown, signal?: AbortSignal) {
    await new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
    return (async function* () {})();
  },
} as unknown as ILLMModel;

describe("LLM JSON helper", function () {
  it("reads a fenced block", function () {
    expect(extractJsonObject('Sure:\n```json\n{"a":1}\n```\nDone')).to.deep.equal({ a: 1 });
  });

  it("reads an object surrounded by prose", function () {
    expect(extractJsonObject('Here you go {"a":{"b":2}} hope it helps')).to.deep.equal({ a: { b: 2 } });
  });

  it("unwraps an object the model put in a one-element array", function () {
    expect(extractJsonObject('[{"a":1}]')).to.deep.equal({ a: 1 });
    expect(extractJsonObject('```json\n[\n  {"a":{"b":2}}\n]\n```')).to.deep.equal({ a: { b: 2 } });
  });

  it("leaves any other array as it is", function () {
    expect(extractJsonObject('[{"a":1},{"b":2}]')).to.deep.equal([{ a: 1 }, { b: 2 }]);
    expect(extractJsonObject("[1]")).to.deep.equal([1]);
    expect(extractJsonObject("[]")).to.deep.equal([]);
    // Only a lone plain object is unwrapped: not a nested array, and not null.
    expect(extractJsonObject('[[{"a":1}]]')).to.deep.equal([[{ a: 1 }]]);
    expect(extractJsonObject("[null]")).to.deep.equal([null]);
  });

  it("throws when there is no object", function () {
    expect(() => extractJsonObject("no json here")).to.throw(/No JSON object/);
  });

  it("collects the stream and validates it against the schema", async function () {
    const schema = z.object({ subQueries: z.array(z.string()) });
    expect(await requestLlmJson(replying('{"subQue', 'ries":["x"]}'), "p", { timeoutMs: 1000, schema })).to.deep.equal({
      subQueries: ["x"],
    });
    let error: unknown;
    await requestLlmJson(replying('{"subQueries":"x"}'), "p", { timeoutMs: 1000, schema }).catch((e) => (error = e));
    expect(error).to.be.instanceOf(Error);
  });

  it("gives up at the timeout with a timeout error", async function () {
    let timedOut: unknown;
    await requestLlmJson(hanging, "p", { timeoutMs: 20, schema: z.object({}) }).catch((e) => (timedOut = e));
    expect(timedOut).to.be.instanceOf(Error);
    expect((timedOut as Error).message).to.equal("LLM request timed out");
  });

  it("gives up when the caller aborts, with the caller's reason and not a timeout", async function () {
    const schema = z.object({});
    const reason = new Error("user cancelled");
    const caller = new AbortController();
    const pending = requestLlmJson(hanging, "p", { timeoutMs: 10_000, schema, signal: caller.signal });
    caller.abort(reason);
    let aborted: unknown;
    await pending.catch((e) => (aborted = e));
    expect(aborted).to.equal(reason);

    const plain = new AbortController();
    const plainPending = requestLlmJson(hanging, "p", { timeoutMs: 10_000, schema, signal: plain.signal });
    plain.abort();
    let plainAborted: unknown;
    await plainPending.catch((e) => (plainAborted = e));
    expect(plainAborted).to.have.property("name", "AbortError");
    expect((plainAborted as Error).message).to.not.equal("LLM request timed out");
  });

  it("passes an already-aborted caller signal on to the model", async function () {
    const caller = new AbortController();
    caller.abort();
    let seen: AbortSignal | undefined;
    const spying = {
      id: "spy",
      family: "spy",
      async sendRequest(_messages: unknown, signal?: AbortSignal) {
        seen = signal;
        return (async function* () {
          yield "{}";
        })();
      },
    } as unknown as ILLMModel;
    await requestLlmJson(spying, "p", { timeoutMs: 1000, schema: z.object({}), signal: caller.signal });
    expect(seen?.aborted).to.equal(true);
  });
});
