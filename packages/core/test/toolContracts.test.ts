import { expect } from "chai";
import {
  RAG_QUERY_INPUT_SCHEMA,
  RAG_MEMORY_INPUT_SCHEMA,
  RAG_TOPIC_READ_INPUT_SCHEMA,
  TOOL_LIMITS,
  toolErrorPayload,
  isToolErrorPayload,
} from "../src/tools/index";
import { TOP_K_MAX } from "../src/constants";

describe("tool contracts", function () {
  it("pins the literal limit values both hosts are generated from", function () {
    expect(TOOL_LIMITS).to.deep.equal({
      topicName: 200,
      query: 20_000,
      queryTopK: 20,
      memoryQuery: 10_000,
      memoryContent: 50_000,
      memoryId: 1_000,
      branch: 255,
      tag: 100,
      tags: 20,
      ids: 500,
      memoryTopK: 50,
      memoryDays: 3650,
      memoryListLimit: 500,
    });
  });

  it("reads every numeric bound of the query and memory schemas from TOOL_LIMITS", function () {
    const memory = RAG_MEMORY_INPUT_SCHEMA.properties;
    expect(RAG_QUERY_INPUT_SCHEMA.properties.topK.maximum).to.equal(TOOL_LIMITS.queryTopK);
    expect(memory.topK.maximum).to.equal(TOOL_LIMITS.memoryTopK);
    expect(memory.olderThan.maximum).to.equal(TOOL_LIMITS.memoryDays);
    expect(memory.ttlDays.maximum).to.equal(TOOL_LIMITS.memoryDays);
    expect(memory.limit.maximum).to.equal(TOOL_LIMITS.memoryListLimit);
  });

  it("bounds rag_query's topK by the one ceiling every host enforces", function () {
    expect(TOOL_LIMITS.queryTopK).to.equal(TOP_K_MAX);
    expect(RAG_QUERY_INPUT_SCHEMA.properties.topK.maximum).to.equal(TOP_K_MAX);
  });

  it("bounds rag_query inputs", function () {
    expect(RAG_QUERY_INPUT_SCHEMA.required).to.deep.equal(["topic", "query"]);
    expect(RAG_QUERY_INPUT_SCHEMA.properties.topic.maxLength).to.equal(TOOL_LIMITS.topicName);
    expect(RAG_QUERY_INPUT_SCHEMA.properties.query.maxLength).to.equal(TOOL_LIMITS.query);
    expect(RAG_QUERY_INPUT_SCHEMA.properties.topK.minimum).to.equal(1);
    expect(RAG_QUERY_INPUT_SCHEMA.properties.topK.maximum).to.equal(20);
    expect(RAG_QUERY_INPUT_SCHEMA.properties.retrievalStrategy.enum).to.deep.equal(["vector", "hybrid", "bm25"]);
  });

  it("does not claim a fixed topK default", function () {
    expect(RAG_QUERY_INPUT_SCHEMA.properties.topK.description ?? "").to.not.match(/default:\s*10/i);
  });

  it("advertises the ten memory actions with the service bounds", function () {
    expect(RAG_MEMORY_INPUT_SCHEMA.required).to.deep.equal(["action"]);
    expect(RAG_MEMORY_INPUT_SCHEMA.properties.action.enum).to.deep.equal([
      "store",
      "recall",
      "forget",
      "stats",
      "list",
      "decay",
      "history",
      "promote",
      "links",
      "communities",
    ]);
    expect(RAG_MEMORY_INPUT_SCHEMA.properties.content.maxLength).to.equal(50_000);
    expect(RAG_MEMORY_INPUT_SCHEMA.properties.query.maxLength).to.equal(10_000);
    expect(RAG_MEMORY_INPUT_SCHEMA.properties.id.maxLength).to.equal(1_000);
    expect(RAG_MEMORY_INPUT_SCHEMA.properties.topK.maximum).to.equal(50);
    expect(RAG_MEMORY_INPUT_SCHEMA.properties.limit.maximum).to.equal(500);
    expect(RAG_MEMORY_INPUT_SCHEMA.properties.ids.maxItems).to.equal(500);
    expect(RAG_MEMORY_INPUT_SCHEMA.properties.ids.items?.maxLength).to.equal(1_000);
  });

  it("restricts the topic read contract to list and stats", function () {
    expect(RAG_TOPIC_READ_INPUT_SCHEMA.properties.action.enum).to.deep.equal(["list", "stats"]);
    expect(RAG_TOPIC_READ_INPUT_SCHEMA.required).to.deep.equal(["action"]);
    expect(Object.keys(RAG_TOPIC_READ_INPUT_SCHEMA.properties)).to.deep.equal(["action", "topic"]);
  });

  it("builds and recognises the canonical error payload", function () {
    const payload = toolErrorPayload("TOPIC_NOT_FOUND", "no such topic");
    expect(payload).to.deep.equal({ error: { code: "TOPIC_NOT_FOUND", message: "no such topic" } });
    expect(isToolErrorPayload(payload)).to.equal(true);
    expect(isToolErrorPayload({ results: [] })).to.equal(false);
  });

  it("rejects an error payload whose message is missing or not a string", function () {
    // Narrowing on code alone would hand callers an undefined at a string-typed site.
    expect(isToolErrorPayload({ error: { code: "TOPIC_NOT_FOUND" } })).to.equal(false);
    expect(isToolErrorPayload({ error: { code: "TOPIC_NOT_FOUND", message: 42 } })).to.equal(false);
    expect(isToolErrorPayload({ error: { message: "no such topic" } })).to.equal(false);
  });
});
