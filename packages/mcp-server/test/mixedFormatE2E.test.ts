/**
 * MB-1 release gate: mixed-format corpora must ingest regardless of order.
 *
 * 0.3.x inferred each topic's LanceDB schema from the FIRST file's chunk
 * metadata (markdown headings/loc vs plain text), so a txt-first topic
 * rejected md chunks and vice versa. Chunk columns are now normalized to a
 * fixed typed set; this spec locks that in over the real binary.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StdioHarness, SERVER_ENTRY } from "./helpers/stdioHarness";

function payload(message: { result?: any }): any {
  return JSON.parse(message.result?.content?.[0]?.text ?? "{}");
}

describe("mixed-format ingestion E2E (MB-1 gate)", function () {
  this.timeout(180000);

  let storageDir: string;
  let sourceDir: string;
  let harness: StdioHarness | undefined;
  let files: { txt: string; md: string; html: string };

  before(function () {
    if (!fs.existsSync(SERVER_ENTRY)) {
      console.error(`Skipping mixed-format E2E: ${SERVER_ENTRY} not built`);
      this.skip();
    }
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-mixed-e2e-"));
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-mixed-src-"));
    files = {
      txt: path.join(sourceDir, "plain-notes.txt"),
      md: path.join(sourceDir, "structured-guide.md"),
      html: path.join(sourceDir, "rendered-page.html"),
    };
    fs.writeFileSync(files.txt, "The backup rotation keeps seven nightly copper snapshots.\n", "utf8");
    fs.writeFileSync(
      files.md,
      "# Operations Guide\n\n## Alerting\n\nPager escalation goes through the silver relay first.\n",
      "utf8",
    );
    fs.writeFileSync(
      files.html,
      "<html><body><h1>Runbook</h1><p>Cache invalidation is performed by the golden broom job.</p></body></html>",
      "utf8",
    );
  });

  after(async function () {
    if (harness) {
      try {
        await harness.close();
      } catch {
        harness.proc.kill();
      }
    }
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(sourceDir, { recursive: true, force: true });
  });

  async function ingestInOrder(topic: string, order: string[], firstId: number): Promise<void> {
    const create = await harness!.callTool(firstId, "rag_create_topic", { name: topic });
    expect(create.result?.isError, JSON.stringify(create.result)).not.to.equal(true);
    // One call per file so ingestion order is deterministic.
    for (const [index, filePath] of order.entries()) {
      const ingest = await harness!.callTool(
        firstId + 1 + index,
        "rag_add_documents",
        { topic, filePaths: [filePath] },
        60000,
      );
      expect(ingest.result?.isError, `${topic} ← ${path.basename(filePath)}: ${JSON.stringify(ingest.result)}`).not.to.equal(true);
      expect(payload(ingest).documentsAdded, `${topic} ← ${path.basename(filePath)}`).to.equal(1);
    }
    const stats = payload(await harness!.callTool(firstId + 10, "rag_topic_stats", { topic }));
    expect(stats.documentCount, JSON.stringify(stats)).to.equal(3);
    expect(stats.chunkCount, JSON.stringify(stats)).to.be.greaterThan(0);
  }

  async function expectAnswer(topic: string, query: string, needle: string, id: number): Promise<void> {
    const response = await harness!.callTool(id, "rag_query", { topic, query, topK: 3 }, 60000);
    expect(response.result?.isError, `${topic}: ${JSON.stringify(response.result)}`).not.to.equal(true);
    const text = (response.result?.content?.[0]?.text ?? "").toLowerCase();
    expect(text, `${topic} / "${query}"`).to.include(needle);
  }

  it("ingests txt→md→html and html→md→txt identically", async function () {
    harness = new StdioHarness(storageDir, sourceDir);
    expect((await harness.initialize()).error).to.equal(undefined);

    await ingestInOrder("mixed-a", [files.txt, files.md, files.html], 10);
    await ingestInOrder("mixed-b", [files.html, files.md, files.txt], 30);

    // Every format must be retrievable from BOTH topics.
    await expectAnswer("mixed-a", "How many nightly snapshots are kept?", "copper", 50);
    await expectAnswer("mixed-a", "What does pager escalation go through?", "silver relay", 51);
    await expectAnswer("mixed-a", "What performs cache invalidation?", "golden broom", 52);
    await expectAnswer("mixed-b", "How many nightly snapshots are kept?", "copper", 53);
    await expectAnswer("mixed-b", "What performs cache invalidation?", "golden broom", 54);

    expect(harness.nonProtocolLines, "diagnostics leaked onto stdout").to.deep.equal([]);
    expect(await harness.close()).to.equal(0);
    harness = undefined;
  });
});
