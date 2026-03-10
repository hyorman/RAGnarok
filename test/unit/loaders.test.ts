/**
 * Unit tests for individual document loader modules.
 * Tests each loader in isolation from the factory.
 */

import { expect } from "chai";
import * as path from "path";
import { TextDocumentLoader, LangChainTextLoader } from "../../src/loaders/textLoader";
import { MarkdownDocumentLoader } from "../../src/loaders/markdownLoader";
import { HtmlDocumentLoader } from "../../src/loaders/htmlLoader";
import { PdfDocumentLoader } from "../../src/loaders/pdfLoader";
import type { LoaderOptions } from "../../src/loaders/types";

describe("Individual Loader Modules", function () {
  this.timeout(30000);

  const fixturesPath = path.join(__dirname, "../../../../test/fixtures");

  const makeOptions = (filePath: string, overrides?: Partial<LoaderOptions>): LoaderOptions => ({
    filePath,
    ...overrides,
  });

  // ---------------------------------------------------------------------------
  // LangChainTextLoader (base class)
  // ---------------------------------------------------------------------------

  describe("LangChainTextLoader", function () {
    it("should load file content as a single document", async function () {
      const filePath = path.join(fixturesPath, "sample-text.txt");
      const loader = new LangChainTextLoader(filePath);
      const docs = await loader.load();

      expect(docs).to.have.length(1);
      expect(docs[0].pageContent).to.include("Natural Language Processing");
      expect(docs[0].metadata.source).to.equal(filePath);
    });

    it("should throw for non-existent file", async function () {
      const loader = new LangChainTextLoader("/nonexistent/file.txt");
      try {
        await loader.load();
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.code).to.equal("ENOENT");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // TextDocumentLoader
  // ---------------------------------------------------------------------------

  describe("TextDocumentLoader", function () {
    let loader: TextDocumentLoader;
    before(function () { loader = new TextDocumentLoader(); });

    it("should load text file content", async function () {
      const filePath = path.join(fixturesPath, "sample-text.txt");
      const docs = await loader.load(filePath, makeOptions(filePath));

      expect(docs).to.have.length(1);
      expect(docs[0].pageContent).to.include("Natural Language Processing");
    });

    it("should throw descriptive error for missing files", async function () {
      const filePath = "/nonexistent/file.txt";
      try {
        await loader.load(filePath, makeOptions(filePath));
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Failed to load text");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // MarkdownDocumentLoader
  // ---------------------------------------------------------------------------

  describe("MarkdownDocumentLoader", function () {
    let loader: MarkdownDocumentLoader;
    before(function () { loader = new MarkdownDocumentLoader(); });

    it("should load markdown and set isMarkdown metadata", async function () {
      const filePath = path.join(fixturesPath, "sample.md");
      const docs = await loader.load(filePath, makeOptions(filePath));

      expect(docs).to.have.length(1);
      expect(docs[0].metadata.isMarkdown).to.be.true;
      expect(docs[0].metadata.preserveStructure).to.be.true;
    });

    it("should preserve markdown content", async function () {
      const filePath = path.join(fixturesPath, "sample.md");
      const docs = await loader.load(filePath, makeOptions(filePath));

      expect(docs[0].pageContent).to.include("Sample Markdown Document");
    });

    it("should throw descriptive error for missing files", async function () {
      const filePath = "/nonexistent/file.md";
      try {
        await loader.load(filePath, makeOptions(filePath));
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Failed to load Markdown");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // HtmlDocumentLoader
  // ---------------------------------------------------------------------------

  describe("HtmlDocumentLoader", function () {
    let loader: HtmlDocumentLoader;
    before(function () { loader = new HtmlDocumentLoader(); });

    it("should extract text and strip HTML tags", async function () {
      const filePath = path.join(fixturesPath, "sample.html");
      const docs = await loader.load(filePath, makeOptions(filePath));

      expect(docs).to.have.length(1);
      expect(docs[0].pageContent).to.include("Machine Learning Basics");
      expect(docs[0].pageContent).to.not.include("<h1>");
    });

    it("should extract title into metadata", async function () {
      const filePath = path.join(fixturesPath, "sample.html");
      const docs = await loader.load(filePath, makeOptions(filePath));

      expect(docs[0].metadata.title).to.equal("Sample HTML Document");
      expect(docs[0].metadata.isHTML).to.be.true;
    });

    it("should handle malformed HTML without crashing", async function () {
      const filePath = path.join(fixturesPath, "sample-malformed.html");
      const docs = await loader.load(filePath, makeOptions(filePath));

      expect(docs).to.have.length(1);
      expect(docs[0].pageContent).to.include("Unclosed heading");
    });

    it("should remove script content (case-insensitive)", async function () {
      const filePath = path.join(fixturesPath, "sample-malformed.html");
      const docs = await loader.load(filePath, makeOptions(filePath));

      expect(docs[0].pageContent).to.not.include("should be removed");
    });

    it("should remove style content", async function () {
      const filePath = path.join(fixturesPath, "sample-malformed.html");
      const docs = await loader.load(filePath, makeOptions(filePath));

      expect(docs[0].pageContent).to.not.include("font-size");
    });

    it("should throw descriptive error for missing files", async function () {
      const filePath = "/nonexistent/file.html";
      try {
        await loader.load(filePath, makeOptions(filePath));
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Failed to load HTML");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // PdfDocumentLoader
  // ---------------------------------------------------------------------------

  describe("PdfDocumentLoader", function () {
    let loader: PdfDocumentLoader;
    before(function () { loader = new PdfDocumentLoader(); });

    it("should load PDF content", async function () {
      const filePath = path.join(fixturesPath, "sample.pdf");
      const docs = await loader.load(filePath, makeOptions(filePath));

      expect(docs).to.have.length.greaterThan(0);
      expect(docs[0].pageContent).to.include("Hello PDF World");
    });

    it("should respect splitPages option", async function () {
      const filePath = path.join(fixturesPath, "sample.pdf");
      const docsNoSplit = await loader.load(
        filePath,
        makeOptions(filePath, { splitPages: false })
      );
      // Single-page PDF should have 1 document either way
      expect(docsNoSplit).to.have.length(1);
    });

    it("should throw descriptive error for corrupted file", async function () {
      // Use a text file as a "corrupted" PDF
      const filePath = path.join(fixturesPath, "sample-text.txt");
      try {
        await loader.load(filePath, makeOptions(filePath, { fileType: "pdf" }));
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Failed to load PDF");
      }
    });
  });
});
