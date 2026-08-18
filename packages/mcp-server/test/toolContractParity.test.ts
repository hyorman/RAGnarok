/**
 * The plan's guarantee, as far as this package can prove it: the MCP server's
 * Zod gates and the canonical JSON Schema contracts in @ragnarok/core describe
 * the same inputs, and the MCP host's tool payloads are the ones the shared
 * core executors produce.
 *
 * SCOPE, stated precisely because the file outlives the task report. At this
 * commit only the MCP host has been migrated onto the shared core module. The
 * VS Code host still carries its own local memory-input normalizer
 * (packages/vscode/src/memoryTools.ts) and still calls
 * RAGQueryService.executeQuery directly rather than executeQueryTool
 * (packages/vscode/src/ragTool.ts); it migrates in a later task. So what is
 * proven here is "MCP ≡ contract" and "MCP ≡ shared executors", plus the
 * host-independence of the shared executors themselves. "VS Code ≡ contract"
 * is NOT proven by this file and must not be read into it.
 *
 * Equivalence is scoped to DECLARED FIELDS ONLY — same requiredness, same type,
 * same min/max/enum bounds. Unknown-key handling is deliberately out of scope:
 * Zod strips unknown keys while JSON Schema permits them, which is a
 * protocol-layer difference, not a contract violation.
 *
 * Every bound below is read off the contract at runtime and then driven through
 * the Zod validator, so a bound that drifts in tools.ts turns a probe red even
 * though both files import TOOL_LIMITS.
 */

import { expect } from "chai";
import sinon from "sinon";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  MemoryServiceError,
  RAG_MEMORY_INPUT_SCHEMA,
  RAG_QUERY_INPUT_SCHEMA,
  RAG_TOPIC_READ_INPUT_SCHEMA,
  TOOL_LIMITS,
  TopicEmptyError,
  executeQueryTool,
  normalizeMemoryInput,
  type JsonSchemaObject,
  type JsonSchemaProperty,
  type MemoryServiceErrorCode,
} from "@ragnarok/core";
import { MCP_LIMITS, registerTools } from "../src/tools";
import { invokeMemoryTool } from "../src/memoryToolAdapter";

interface ZodLike {
  safeParse(value: unknown): { success: boolean };
}

type ToolHandler = (args: any, context: any) => Promise<any>;

interface CapturedTool {
  inputSchema: ZodLike;
  handler: ToolHandler;
}

/**
 * The schemas AND handlers the MCP SDK actually receives, read back off the
 * registration calls, so a registration site that stopped using the bounded
 * schema — or a handler that stopped using the shared executor — cannot pass
 * unnoticed.
 */
function registerAndCapture(ragQueryService: unknown = {}): Record<string, CapturedTool> {
  const captured: Record<string, CapturedTool> = {};
  const server = {
    registerTool(name: string, config: { inputSchema: ZodLike }, handler: ToolHandler) {
      captured[name] = { inputSchema: config.inputSchema, handler };
      return { name };
    },
  } as unknown as McpServer;
  registerTools(
    server,
    { getAllTopics: sinon.stub().returns([]), getVectorStore: sinon.stub().resolves(null) } as never,
    ragQueryService as never,
    { execute: sinon.stub(), reset: sinon.stub() } as never,
    undefined,
    { getCurrentBranch: sinon.stub().resolves(null) } as never,
    { workingDir: "/project" } as never,
  );
  for (const name of ["rag_query", "rag_memory", "rag_topic"]) {
    expect(captured[name], `${name} was not registered`).to.not.equal(undefined);
    expect(captured[name].handler, `${name} was registered without a handler`).to.be.a("function");
  }
  return captured;
}

/** Unwraps optional/default/nullable wrappers to reach the base Zod type. */
function unwrapZod(schema: any): any {
  let current = schema;
  while (current?.def?.innerType) {
    current = current.def.innerType;
  }
  return current;
}

/** The property names a Zod object schema actually declares. */
function zodKeys(schema: ZodLike, label: string): string[] {
  const shape = (schema as any).shape;
  expect(shape, `${label}: expected a Zod object with a shape`).to.not.equal(undefined);
  return Object.keys(shape).sort();
}

/** The members a Zod enum property actually declares. */
function zodEnumMembers(schema: ZodLike, field: string, label: string): string[] {
  const inner = unwrapZod((schema as any).shape?.[field]);
  expect(inner?.options, `${label}: expected a Zod enum`).to.be.an("array");
  return [...inner.options].sort();
}

/** A value the contract declares valid for one property. */
function sampleValue(spec: JsonSchemaProperty, label: string): unknown {
  if (spec.enum) {
    expect(spec.enum.length, `${label}: enum must declare members`).to.be.greaterThan(0);
    return spec.enum[0];
  }
  switch (spec.type) {
    case "string":
      return "x".repeat(Math.max(spec.minLength ?? 1, 1));
    case "boolean":
      return true;
    case "integer":
    case "number":
      return spec.minimum ?? (spec.exclusiveMinimum === undefined ? 1 : spec.exclusiveMinimum + 1);
    case "array": {
      expect(spec.items, `${label}: array must declare items`).to.not.equal(undefined);
      return [sampleValue(spec.items as JsonSchemaProperty, `${label}[]`)];
    }
  }
}

function sampleObject(contract: JsonSchemaObject, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((field) => {
      const spec = contract.properties[field];
      expect(spec, `contract declares no property '${field}'`).to.not.equal(undefined);
      return [field, sampleValue(spec, field)];
    }),
  );
}

interface FieldCoverage {
  fields: number;
  strings: number;
  numerics: number;
  booleans: number;
  enums: number;
  arrays: number;
  /** How many bound/type probes actually ran, so a bound cannot vanish quietly. */
  probes: number;
}

/**
 * Drives every declared field of `contract` through `schema` and returns how
 * many fields each category actually exercised, so a caller can assert the
 * loop was not vacuous.
 */
function assertDeclaredFieldParity(schema: ZodLike, contract: JsonSchemaObject, label: string): FieldCoverage {
  const coverage: FieldCoverage = { fields: 0, strings: 0, numerics: 0, booleans: 0, enums: 0, arrays: 0, probes: 0 };
  const required = new Set(contract.required ?? []);
  const base = sampleObject(contract, [...required]);
  const full = sampleObject(contract, Object.keys(contract.properties));
  const accepts = (patch: Record<string, unknown>): boolean => {
    coverage.probes += 1;
    return schema.safeParse({ ...base, ...patch }).success;
  };

  expect(schema.safeParse(base).success, `${label}: required-only sample must parse`).to.equal(true);
  expect(schema.safeParse(full).success, `${label}: fully populated sample must parse`).to.equal(true);

  for (const [field, spec] of Object.entries(contract.properties)) {
    coverage.fields += 1;

    const without: Record<string, unknown> = { ...full };
    delete without[field];
    expect(schema.safeParse(without).success, `${label}.${field}: requiredness`).to.equal(!required.has(field));

    if (spec.enum) {
      coverage.enums += 1;
      for (const member of spec.enum) {
        expect(accepts({ [field]: member }), `${label}.${field}: enum member '${member}'`).to.equal(true);
      }
      expect(accepts({ [field]: "__not_a_declared_member__" }), `${label}.${field}: enum outsider`).to.equal(false);
      continue;
    }

    switch (spec.type) {
      case "string": {
        coverage.strings += 1;
        expect(accepts({ [field]: 42 }), `${label}.${field}: non-string`).to.equal(false);
        if (spec.minLength !== undefined && spec.minLength >= 1) {
          expect(accepts({ [field]: "x".repeat(spec.minLength) }), `${label}.${field}: at minLength`).to.equal(true);
          expect(accepts({ [field]: "x".repeat(spec.minLength - 1) }), `${label}.${field}: under minLength`).to.equal(
            false,
          );
        }
        if (spec.maxLength !== undefined) {
          expect(accepts({ [field]: "x".repeat(spec.maxLength) }), `${label}.${field}: at maxLength`).to.equal(true);
          expect(accepts({ [field]: "x".repeat(spec.maxLength + 1) }), `${label}.${field}: over maxLength`).to.equal(
            false,
          );
        }
        break;
      }
      case "integer":
      case "number": {
        coverage.numerics += 1;
        expect(accepts({ [field]: "1" }), `${label}.${field}: non-number`).to.equal(false);
        if (spec.minimum !== undefined) {
          expect(accepts({ [field]: spec.minimum }), `${label}.${field}: at minimum`).to.equal(true);
          expect(accepts({ [field]: spec.minimum - 1 }), `${label}.${field}: under minimum`).to.equal(false);
        }
        if (spec.exclusiveMinimum !== undefined) {
          const step = spec.type === "integer" ? 1 : 0.5;
          expect(accepts({ [field]: spec.exclusiveMinimum }), `${label}.${field}: at exclusiveMinimum`).to.equal(false);
          expect(
            accepts({ [field]: spec.exclusiveMinimum + step }),
            `${label}.${field}: just over exclusiveMinimum`,
          ).to.equal(true);
        }
        if (spec.maximum !== undefined) {
          expect(accepts({ [field]: spec.maximum }), `${label}.${field}: at maximum`).to.equal(true);
          expect(accepts({ [field]: spec.maximum + 1 }), `${label}.${field}: over maximum`).to.equal(false);
        }
        // integer vs number is itself a declared type, so probe the fraction.
        const fractional = (spec.minimum ?? spec.exclusiveMinimum ?? 0) + 0.5;
        expect(accepts({ [field]: fractional }), `${label}.${field}: fractional value`).to.equal(
          spec.type === "number",
        );
        break;
      }
      case "boolean": {
        coverage.booleans += 1;
        expect(accepts({ [field]: true }), `${label}.${field}: true`).to.equal(true);
        expect(accepts({ [field]: false }), `${label}.${field}: false`).to.equal(true);
        expect(accepts({ [field]: "true" }), `${label}.${field}: non-boolean`).to.equal(false);
        break;
      }
      case "array": {
        coverage.arrays += 1;
        expect(spec.items, `${label}.${field}: array must declare items`).to.not.equal(undefined);
        const items = spec.items as JsonSchemaProperty;
        const item = sampleValue(items, `${label}.${field}[]`);
        expect(accepts({ [field]: "not-an-array" }), `${label}.${field}: non-array`).to.equal(false);
        if (spec.maxItems !== undefined) {
          expect(accepts({ [field]: Array(spec.maxItems).fill(item) }), `${label}.${field}: at maxItems`).to.equal(
            true,
          );
          expect(
            accepts({ [field]: Array(spec.maxItems + 1).fill(item) }),
            `${label}.${field}: over maxItems`,
          ).to.equal(false);
        }
        if (items.type === "string") {
          expect(accepts({ [field]: [42] }), `${label}.${field}: non-string item`).to.equal(false);
          if (items.minLength !== undefined && items.minLength >= 1) {
            expect(
              accepts({ [field]: ["x".repeat(items.minLength - 1)] }),
              `${label}.${field}[]: under minLength`,
            ).to.equal(false);
          }
          if (items.maxLength !== undefined) {
            expect(accepts({ [field]: ["x".repeat(items.maxLength)] }), `${label}.${field}[]: at maxLength`).to.equal(
              true,
            );
            expect(
              accepts({ [field]: ["x".repeat(items.maxLength + 1)] }),
              `${label}.${field}[]: over maxLength`,
            ).to.equal(false);
          }
        }
        break;
      }
    }
  }

  return coverage;
}

describe("tool contract parity", function () {
  const tools = registerAndCapture();
  const schemas = {
    rag_query: tools.rag_query.inputSchema,
    rag_memory: tools.rag_memory.inputSchema,
    rag_topic: tools.rag_topic.inputSchema,
  };

  it("declares exactly the contract's property set, in both directions", function () {
    // The per-field walk below iterates the CONTRACT, so a Zod-only property
    // would never be probed and the field count — being a count of contract
    // properties — could not catch it either. This closes that direction: the
    // two key sets must match exactly, so MCP cannot advertise a surface the
    // manifest generator will never emit.
    const cases = [
      { label: "rag_memory", schema: schemas.rag_memory, contract: RAG_MEMORY_INPUT_SCHEMA },
      { label: "rag_query", schema: schemas.rag_query, contract: RAG_QUERY_INPUT_SCHEMA },
    ];

    let compared = 0;
    for (const { label, schema, contract } of cases) {
      compared += 1;
      const contractKeys = Object.keys(contract.properties).sort();
      expect(contractKeys.length, `${label}: contract must declare properties`).to.be.greaterThan(0);
      expect(zodKeys(schema, label), `${label}: property set`).to.deep.equal(contractKeys);
    }
    expect(compared, "the key-set loop must not be vacuous").to.equal(2);
    // rag_topic is deliberately absent: its Zod is a discriminated union whose
    // four WRITE actions have no counterpart in the read-only contract, so a
    // key-set comparison there would be meaningless rather than merely scoped.
  });

  it("declares exactly the contract's enum members, in both directions", function () {
    // Same one-directional hole: the walk accepts every declared member and
    // rejects one literal outsider, which an 11th Zod-only member survives.
    const cases = [
      { label: "rag_memory.action", schema: schemas.rag_memory, field: "action", contract: RAG_MEMORY_INPUT_SCHEMA },
      { label: "rag_memory.scope", schema: schemas.rag_memory, field: "scope", contract: RAG_MEMORY_INPUT_SCHEMA },
      {
        label: "rag_query.retrievalStrategy",
        schema: schemas.rag_query,
        field: "retrievalStrategy",
        contract: RAG_QUERY_INPUT_SCHEMA,
      },
    ];

    let compared = 0;
    for (const { label, schema, field, contract } of cases) {
      compared += 1;
      const declared = [...(contract.properties[field].enum ?? [])].sort();
      expect(declared.length, `${label}: contract must declare enum members`).to.be.greaterThan(0);
      expect(zodEnumMembers(schema, field, label), `${label}: enum members`).to.deep.equal(declared);
    }
    expect(compared, "the enum-set loop must not be vacuous").to.equal(3);
  });

  it("agrees with the rag_memory contract on every declared field", function () {
    const coverage = assertDeclaredFieldParity(schemas.rag_memory, RAG_MEMORY_INPUT_SCHEMA, "rag_memory");

    // Exact counts, not a lower bound: a contract field that stops being probed
    // — or one added without a Zod counterpart — must fail here rather than
    // shrink the loop silently. `probes` counts the individual bound/type
    // checks, so a bound that disappears from the contract goes red too.
    expect(coverage).to.deep.equal({
      fields: 16,
      strings: 4,
      numerics: 4,
      booleans: 4,
      enums: 2,
      arrays: 2,
      probes: 84,
    });
  });

  it("agrees with the rag_query contract on every declared field", function () {
    const coverage = assertDeclaredFieldParity(schemas.rag_query, RAG_QUERY_INPUT_SCHEMA, "rag_query");

    expect(coverage).to.deep.equal({
      fields: 4,
      strings: 2,
      numerics: 1,
      booleans: 0,
      enums: 1,
      arrays: 0,
      probes: 20,
    });
  });

  it("keeps the query contract aligned with MCP_LIMITS", function () {
    // Two independently maintained constant tables, compared directly.
    expect(RAG_QUERY_INPUT_SCHEMA.properties.topic.maxLength).to.equal(MCP_LIMITS.topicName);
    expect(RAG_QUERY_INPUT_SCHEMA.properties.query.maxLength).to.equal(MCP_LIMITS.query);
    expect(TOOL_LIMITS.topicName).to.equal(MCP_LIMITS.topicName);
    expect(TOOL_LIMITS.query).to.equal(MCP_LIMITS.query);
  });

  it("agrees with the rag_topic read contract on both read actions and the topic bound", function () {
    // rag_topic's Zod is a discriminated union that also carries the write
    // actions, so the generic per-field walk does not apply. Scope: the two
    // READ actions the contract declares, and the topic bound they share.
    const schema = schemas.rag_topic;
    const topic = RAG_TOPIC_READ_INPUT_SCHEMA.properties.topic;
    expect(topic.maxLength, "contract must bound topic").to.not.equal(undefined);

    let actions = 0;
    for (const action of RAG_TOPIC_READ_INPUT_SCHEMA.properties.action.enum ?? []) {
      actions += 1;
      const input = action === "list" ? { action } : { action, topic: "x" };
      expect(schema.safeParse(input).success, `rag_topic action '${action}'`).to.equal(true);
    }
    expect(actions, "the read-action loop must not be vacuous").to.equal(2);

    expect(schema.safeParse({ action: "__not_a_declared_member__" }).success).to.equal(false);
    expect(schema.safeParse({ action: "stats", topic: "x".repeat(topic.maxLength!) }).success).to.equal(true);
    expect(schema.safeParse({ action: "stats", topic: "x".repeat(topic.maxLength! + 1) }).success).to.equal(false);
    expect(schema.safeParse({ action: "stats", topic: "" }).success).to.equal(false);
    // Not declared-field requiredness parity: the flat contract marks only
    // `action` required, but its `topic` description reserves the field for
    // 'stats' and executeTopicRead rejects a missing topic there at runtime.
    // MCP's union enforces the same rule one layer earlier.
    expect(schema.safeParse({ action: "stats" }).success).to.equal(false);
  });
});

describe("runtime payload parity", function () {
  afterEach(() => sinon.restore());

  it("normalizes a memory input through the shared core normalizer", function () {
    // The MCP host now calls this core normalizer instead of its own copy, so
    // this pins the behavior that used to differ: the old MCP copy did not
    // trim. The VS Code host still has a local copy (see the file header) and
    // adopts this one in a later task; this test does not speak for it.
    const raw = { action: "recall" as const, query: "  why  ", topK: 3, branch: " main " };

    expect(normalizeMemoryInput(raw)).to.deep.equal({
      action: "recall",
      query: "why",
      topK: 3,
      branch: "main",
    });
  });

  it("hands the memory service exactly what the shared normalizer produced", function () {
    // The host must add nothing of its own between the raw input and the
    // service: whatever the shared normalizer returns is what runs.
    const execute = sinon.stub().resolves({ action: "recall" });
    const signal = new AbortController().signal;
    const raw = { action: "recall" as const, query: "  why  ", topK: 3, branch: " main " };

    return invokeMemoryTool(
      { ...raw },
      { mcpReq: { signal } } as never,
      { execute } as never,
      { getCurrentBranch: sinon.stub().resolves("main") } as never,
      { workingDir: "/project" } as never,
    ).then(() => {
      expect(execute.calledOnce, "the service must run once").to.equal(true);
      expect(execute.firstCall.args[0]).to.deep.equal(normalizeMemoryInput({ ...raw }));
      // By identity: two fresh AbortSignals are deep-equal, so only reference
      // equality witnesses that the request's own signal was forwarded.
      expect(execute.firstCall.args[2]).to.equal(signal);
    });
  });

  it("reports every MemoryServiceError code in the one canonical payload", async function () {
    // MCP emits {error: {code, message}} verbatim for a MemoryServiceError —
    // the same shape packages/vscode/src/memoryTools.ts builds in
    // serviceErrorResult. Written as literals, not built with toolErrorPayload:
    // an expectation that shares its builder with the code under test can never
    // go red.
    //
    // Non-MemoryServiceError failures are deliberately NOT compared here: MCP
    // maps them to MEMORY_OPERATION_FAILED while the VS Code tool rethrows so
    // its language-model surface reports a tool failure. That divergence is
    // adjudicated, because MCP has no rethrow channel.
    const codes = [
      "MEMORY_INVALID_INPUT",
      "MEMORY_BRANCH_UNAVAILABLE",
      "MEMORY_BRANCH_AMBIGUOUS",
      "MEMORY_UNSUPPORTED_SCOPE",
      "MEMORY_OPERATION_FAILED",
      "MEMORY_RESET_FAILED",
      "GRAPH_VISUALIZATION_FAILED",
    ] as const;

    // Compile-time exhaustiveness: the runtime list above cannot see a code
    // added to the union, so an 8th member turns this type into `false` and the
    // assignment stops compiling.
    type MissingCode = Exclude<MemoryServiceErrorCode, (typeof codes)[number]>;
    const everyCodeCovered: [MissingCode] extends [never] ? true : false = true;
    expect(everyCodeCovered, "the code list must cover MemoryServiceErrorCode").to.equal(true);

    let checked = 0;
    for (const code of codes) {
      checked += 1;
      const execute = sinon.stub().rejects(new MemoryServiceError(code, `failed: ${code}`));

      const result = await invokeMemoryTool(
        { action: "list" },
        { mcpReq: { signal: new AbortController().signal } } as never,
        { execute } as never,
        { getCurrentBranch: sinon.stub().resolves(null) } as never,
        { workingDir: "/project" } as never,
      );

      expect(result.isError, code).to.equal(true);
      expect(JSON.parse(result.content[0].text), code).to.deep.equal({
        error: { code, message: `failed: ${code}` },
      });
    }
    expect(checked, "the code loop must not be vacuous").to.equal(7);
  });

  it("keeps the shared executor's empty-topic payload invariant to workspaceContext", async function () {
    // A property of the shared executor, not of either host: supplying editor
    // context cannot change the empty payload. MCP's own handler is driven
    // separately below; VS Code's path does not reach executeQueryTool yet.
    const service = {
      executeQuery: async () => {
        throw new TopicEmptyError("Docs");
      },
    };

    const withoutContext = await executeQueryTool({ topic: "Docs", query: "q" }, { ragQueryService: service as never });
    const withContext = await executeQueryTool(
      { topic: "Docs", query: "q" },
      { ragQueryService: service as never, workspaceContext: "editor context" },
    );

    expect(withoutContext).to.deep.equal(withContext);
    expect(withoutContext).to.not.have.property("agenticMetadata");
  });

  it("keeps the shared executor's success payload invariant while still forwarding workspaceContext", async function () {
    // The executor returns the service payload verbatim and adds no decoration
    // of its own — but the optional workspaceContext an options object would
    // hide from the compiler must still reach the service, so assert the
    // recorded arguments.
    const payload = { query: "q", topicName: "Docs", results: [{ content: "hit" }] };
    const executeQuery = sinon.stub().resolves(payload);
    const service = { executeQuery };
    const signal = new AbortController().signal;

    const withoutContext = await executeQueryTool(
      { topic: "Docs", query: "q" },
      { ragQueryService: service as never },
      signal,
    );
    const withContext = await executeQueryTool(
      { topic: "Docs", query: "q" },
      { ragQueryService: service as never, workspaceContext: "editor context" },
      signal,
    );

    expect(withoutContext).to.deep.equal(withContext);
    expect(withoutContext).to.deep.equal(payload);
    expect(executeQuery.callCount).to.equal(2);
    expect(executeQuery.firstCall.args[1], "no context in, no context out").to.equal(undefined);
    expect(executeQuery.secondCall.args[1], "editor context must survive the options object").to.equal(
      "editor context",
    );
    expect(executeQuery.firstCall.args[2], "the request signal, by identity").to.equal(signal);
    expect(executeQuery.secondCall.args[2], "the request signal, by identity").to.equal(signal);
  });

  it("routes MCP's registered rag_query handler through the shared executor with no workspace context", async function () {
    // Drives the handler the MCP SDK actually calls, not the executor directly:
    // editor state is VS Code's alone, so MCP must supply no workspaceContext,
    // and the payload the client sees must be the executor's verbatim.
    const payload = { query: "q", topicName: "Docs", results: [{ content: "hit" }] };
    const executeQuery = sinon.stub().resolves(payload);
    const signal = new AbortController().signal;

    const result = await registerAndCapture({ executeQuery }).rag_query.handler(
      { topic: "Docs", query: "q" },
      { mcpReq: { signal } },
    );

    expect(executeQuery.calledOnce, "the query service must run once").to.equal(true);
    expect(executeQuery.firstCall.args[0]).to.deep.equal({ topic: "Docs", query: "q" });
    expect(executeQuery.firstCall.args[1], "MCP must supply no workspace context").to.equal(undefined);
    expect(executeQuery.firstCall.args[2], "the request signal, by identity").to.equal(signal);
    expect(result.isError, "a successful query is not an error").to.equal(undefined);
    expect(JSON.parse(result.content[0].text)).to.deep.equal(payload);
    expect(result.structuredContent).to.deep.equal(payload);
  });

  it("returns the shared empty-topic payload through MCP's registered rag_query handler", async function () {
    // The empty-topic case is no longer handled in tools.ts; the shared
    // executor owns it, so the MCP client must see exactly the core payload.
    const executeQuery = sinon.stub().rejects(new TopicEmptyError("Docs"));

    const result = await registerAndCapture({ executeQuery }).rag_query.handler(
      { topic: "Docs", query: "q" },
      { mcpReq: { signal: new AbortController().signal } },
    );

    expect(result.isError, "an empty topic is not a tool failure").to.equal(undefined);
    const body = JSON.parse(result.content[0].text);
    expect(body).to.deep.equal({
      query: "q",
      topicName: "Docs",
      topicMatched: "fallback",
      results: [],
      empty: true,
      message: 'Topic "Docs" exists but has no documents. Add documents to the topic before querying.',
    });
    expect(body).to.not.have.property("agenticMetadata");
  });
});
