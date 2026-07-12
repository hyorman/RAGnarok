/**
 * Shared-deployment e2e over the real binary (`--http` + auth tokens):
 * - unauthenticated requests are rejected;
 * - memory tools are structurally absent for reader AND writer sessions;
 * - write tools are absent for readers, present for writers;
 * - every tool description carries the "[Team shared KB]" prefix and the
 *   server advertises shared-KB instructions;
 * - SIGTERM produces exit code 0 with no native-abort traces (MB-2, HTTP path).
 */
import { expect } from "chai";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioHarness, SERVER_ENTRY } from "./helpers/stdioHarness";

const READ_TOKEN = "e2e-read-token";
const WRITE_TOKEN = "e2e-write-token";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`);
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`/ready did not come up on port ${port} within ${timeoutMs}ms`);
}

function authedClient(port: number, token: string): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "http-e2e", version: "1.0.0" });
  return { client, transport };
}

describe("shared-mode HTTP E2E (real binary)", function () {
  this.timeout(120000);

  let storageDir: string;
  let workDir: string;
  let harness: StdioHarness | undefined;
  let port: number;

  before(async function () {
    if (!fs.existsSync(SERVER_ENTRY)) {
      console.error(`Skipping HTTP binary E2E: ${SERVER_ENTRY} not built`);
      this.skip();
    }
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-http-e2e-"));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-http-work-"));
    port = await getFreePort();
    harness = new StdioHarness(
      storageDir,
      workDir,
      {
        RAGNAROK_PORT: String(port),
        RAGNAROK_API_KEY: READ_TOKEN,
        RAGNAROK_WRITE_API_KEY: WRITE_TOKEN,
      },
      ["--http"],
    );
    await waitForReady(port, 60000);
  });

  after(async function () {
    if (harness && harness.proc.exitCode === null) {
      harness.proc.kill("SIGTERM");
      await harness.waitForExit(20000).catch(() => harness!.proc.kill("SIGKILL"));
    }
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("rejects unauthenticated requests", async function () {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).to.equal(401);
  });

  it("serves a memory-free, prefixed, role-scoped tool surface", async function () {
    const reader = authedClient(port, READ_TOKEN);
    await reader.client.connect(reader.transport);
    const readerTools = (await reader.client.listTools()).tools;
    const readerNames = readerTools.map((t) => t.name);

    expect(readerNames).to.include("rag_query");
    expect(readerNames, "memory tools must be absent in shared mode").to.not.include("rag_memory");
    expect(readerNames).to.not.include("rag_reset_memory");
    expect(readerNames, "write tools must be absent for readers").to.not.include("rag_create_topic");
    for (const tool of readerTools) {
      expect(tool.description ?? "", `description of ${tool.name}`).to.match(/^\[Team shared KB\] /);
    }
    const instructions = reader.client.getInstructions() ?? "";
    expect(instructions.toLowerCase()).to.include("team shared knowledge base");
    await reader.client.close();

    const writer = authedClient(port, WRITE_TOKEN);
    await writer.client.connect(writer.transport);
    const writerNames = (await writer.client.listTools()).tools.map((t) => t.name);
    expect(writerNames, "writers get write tools").to.include("rag_create_topic");
    expect(writerNames, "memory tools are absent for EVERY role in shared mode").to.not.include("rag_memory");
    expect(writerNames).to.not.include("rag_reset_memory");
    await writer.client.close();
  });

  it("exits 0 on SIGTERM with no native-abort traces (MB-2, HTTP path)", async function () {
    harness!.proc.kill("SIGTERM");
    const exitCode = await harness!.waitForExit(20000);
    expect(exitCode, `stderr: ${harness!.stderrText.slice(-500)}`).to.equal(0);
    expect(harness!.stderrText).to.not.match(/SIGABRT|mutex lock failed|libc\+\+abi/);
    harness = undefined;
  });
});
