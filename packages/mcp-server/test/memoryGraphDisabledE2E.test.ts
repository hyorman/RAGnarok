/**
 * With no LLM configured the memory graph can never populate, and the server
 * must say so. `createLLMProvider` substitutes a NullProvider rather than
 * returning null, so only the composition root knows the difference — a unit
 * test that injects an extractor cannot see this. Drive the real binary.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StdioHarness, SERVER_ENTRY, withStdioHarness } from "./helpers/stdioHarness";

function payload(message: { result?: any }): any {
  return JSON.parse(message.result?.content?.[0]?.text ?? "{}");
}

describe("memory graph disabled without an LLM (E2E)", function () {
  this.timeout(120000);

  let storageDir: string;
  let workDir: string;

  before(function () {
    if (!fs.existsSync(SERVER_ENTRY)) {
      console.error(`Skipping memory graph E2E: ${SERVER_ENTRY} not built`);
      this.skip();
    }
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-memory-graph-e2e-"));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-memory-graph-work-"));
  });

  after(function () {
    if (storageDir) {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
    if (workDir) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("reports entity extraction as disabled, not merely empty, when no LLM is configured", async function () {
    await withStdioHarness(
      () =>
        new StdioHarness(storageDir, workDir, {
          RAGNAROK_LLM_PROVIDER: "none",
          RAGNAROK_RERANKER_ENABLED: "false",
        }),
      async (harness) => {
        expect((await harness.discover()).error).to.equal(undefined);

        const communities = await harness.callTool(2, "rag_memory", { action: "communities" });
        expect(communities.result?.isError, JSON.stringify(communities.result)).not.to.equal(true);
        const body = payload(communities);
        expect(
          body.entityExtractionEnabled,
          `an unusable LLM provider must not report an enabled graph: ${JSON.stringify(body)}`,
        ).to.equal(false);
        expect(body.count).to.equal(0);
        expect(String(body.hint ?? ""), JSON.stringify(body)).to.contain("RAGNAROK_LLM_PROVIDER");
      },
      "memory graph disabled E2E",
    );
  });
});
