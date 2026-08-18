/**
 * The plan's guarantee: the MCP server's Zod gates and the canonical JSON Schema
 * contracts in @ragnarok/core describe the same inputs, and the shared executors
 * produce one payload for both hosts.
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
} from "@ragnarok/core";
import { MCP_LIMITS, registerTools } from "../src/tools";
import { invokeMemoryTool } from "../src/memoryToolAdapter";

interface ZodLike {
  safeParse(value: unknown): { success: boolean };
}

/**
 * The schemas the MCP SDK actually validates against, read back off the
 * registration calls, so a registration site that stopped using the bounded
 * schema cannot pass unnoticed.
 */
function registeredInputSchemas(): Record<string, ZodLike> {
  const captured: Record<string, ZodLike> = {};
  const server = {
    registerTool(name: string, config: { inputSchema: ZodLike }) {
      captured[name] = config.inputSchema;
      return { name };
    },
  } as unknown as McpServer;
  registerTools(
    server,
    { getAllTopics: sinon.stub().returns([]), getVectorStore: sinon.stub().resolves(null) } as never,
    {} as never,
    { execute: sinon.stub(), reset: sinon.stub() } as never,
    undefined,
    { getCurrentBranch: sinon.stub().resolves(null) } as never,
    { workingDir: "/project" } as never,
  );
  for (const name of ["rag_query", "rag_memory", "rag_topic"]) {
    expect(captured[name], `${name} was not registered`).to.not.equal(undefined);
  }
  return captured;
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
  const schemas = registeredInputSchemas();

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

  it("normalizes a memory input identically for both hosts", function () {
    // Both hosts call the same core normalizer, so this pins the behavior that
    // used to differ: the MCP copy did not trim, the VS Code copy did.
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
    // Both hosts emit {error: {code, message}} verbatim for a MemoryServiceError.
    // Written as literals, not built with toolErrorPayload: an expectation that
    // shares its builder with the code under test can never go red.
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

  it("produces one empty-topic payload regardless of workspace context", async function () {
    const service = {
      executeQuery: async () => {
        throw new TopicEmptyError("Docs");
      },
    };

    const mcpPayload = await executeQueryTool({ topic: "Docs", query: "q" }, { ragQueryService: service as never });
    const vscodePayload = await executeQueryTool(
      { topic: "Docs", query: "q" },
      { ragQueryService: service as never, workspaceContext: "editor context" },
    );

    expect(mcpPayload).to.deep.equal(vscodePayload);
    expect(mcpPayload).to.not.have.property("agenticMetadata");
  });

  it("produces one success payload while still forwarding each host's own context", async function () {
    // The shared executor returns the service payload verbatim — neither host
    // decorates it — but the optional workspaceContext an options object would
    // hide must still reach the service, so assert the recorded arguments.
    const payload = { query: "q", topicName: "Docs", results: [{ content: "hit" }] };
    const executeQuery = sinon.stub().resolves(payload);
    const service = { executeQuery };
    const signal = new AbortController().signal;

    const mcpPayload = await executeQueryTool(
      { topic: "Docs", query: "q" },
      { ragQueryService: service as never },
      signal,
    );
    const vscodePayload = await executeQueryTool(
      { topic: "Docs", query: "q" },
      { ragQueryService: service as never, workspaceContext: "editor context" },
      signal,
    );

    expect(mcpPayload).to.deep.equal(vscodePayload);
    expect(mcpPayload).to.deep.equal(payload);
    expect(executeQuery.callCount).to.equal(2);
    expect(executeQuery.firstCall.args[1], "MCP supplies no workspace context").to.equal(undefined);
    expect(executeQuery.secondCall.args[1], "VS Code's editor context must survive").to.equal("editor context");
    expect(executeQuery.firstCall.args[2], "the request signal, by identity").to.equal(signal);
    expect(executeQuery.secondCall.args[2], "the request signal, by identity").to.equal(signal);
  });
});
