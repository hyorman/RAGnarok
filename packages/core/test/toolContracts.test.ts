import { expect } from "chai";
import {
  RAG_QUERY_INPUT_SCHEMA,
  RAG_MEMORY_INPUT_SCHEMA,
  RAG_TOPIC_READ_INPUT_SCHEMA,
  TOOL_LIMITS,
  toolErrorPayload,
  isToolErrorPayload,
} from "../src/tools/index";

describe("tool contracts", function () {
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
});
