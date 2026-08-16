import { expect } from "chai";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerGraphUiResource } from "../src/uiResource";

describe("graph UI resource", function () {
  it("registers and reads the exact MCP Apps MIME type", async function () {
    let registration:
      | {
          uri: string;
          config: { mimeType?: string };
          read: () => { contents: Array<{ uri: string; mimeType?: string; text?: string }> };
        }
      | undefined;
    const server = {
      registerResource(
        _name: string,
        uri: string,
        config: { mimeType?: string },
        read: () => { contents: Array<{ uri: string; mimeType?: string; text?: string }> },
      ) {
        registration = { uri, config, read };
      },
    } as unknown as McpServer;

    registerGraphUiResource(server);

    expect(registration).not.to.equal(undefined);
    const resource = registration!;
    const read = await resource.read();
    expect(resource.uri).to.equal("ui://ragnarok/graph");
    expect(resource.config.mimeType).to.equal("text/html;profile=mcp-app");
    expect(read.contents[0].mimeType).to.equal("text/html;profile=mcp-app");
    expect(read.contents[0].text).to.be.a("string").and.not.equal("");
  });
});
