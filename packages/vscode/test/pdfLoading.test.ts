import { expect } from "chai";
import * as path from "path";
import { PdfDocumentLoader } from "@ragnarok/core";

/**
 * PDF parsing breaks in ways only the extension host reproduces: pdfjs decides it
 * is in a browser because Electron sets process.type, and this host exposes
 * navigator as a getter with no setter, so pdfjs's own polyfill throws. Neither
 * shows up in the core suite, which runs on plain Node.
 */
describe("PDF loading in the extension host", function () {
  this.timeout(120_000);

  it("parses a PDF where pdfjs would otherwise take its browser code path", async function () {
    const isNodeJS = !(
      process.versions.electron &&
      (process as { type?: string }).type &&
      (process as { type?: string }).type !== "browser"
    );
    expect(isNodeJS, "host should be the Electron case this guards").to.equal(false);

    const fixture = path.resolve(__dirname, "../../../../packages/core/test/fixtures/sample.pdf");
    const docs = await new PdfDocumentLoader().load(fixture, { filePath: fixture });

    expect(docs[0].pageContent).to.include("Hello PDF World");
  });
});
