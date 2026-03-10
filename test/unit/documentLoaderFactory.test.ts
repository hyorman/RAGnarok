/**
 * Unit Tests for DocumentLoaderFactory
 * Tests document loading for all supported file types, static utilities,
 * file type detection, directory traversal, and error handling.
 */

import { expect } from "chai";
import * as path from "path";
import * as fs from "fs";
import {
  DocumentLoaderFactory,
  SupportedFileType,
} from "../../src/loaders/documentLoaderFactory";

describe("DocumentLoaderFactory", function () {
  this.timeout(30000);

  let factory: DocumentLoaderFactory;

  // Compiled tests live in out/test/test/unit, so resolve fixtures relative to workspace root
  const fixturesPath = path.join(__dirname, "../../../../test/fixtures");

  before(function () {
    factory = new DocumentLoaderFactory();

    // Verify fixtures exist
    if (!fs.existsSync(fixturesPath)) {
      throw new Error(`Fixtures directory not found: ${fixturesPath}`);
    }
  });

  // ---------------------------------------------------------------------------
  // Static utility methods
  // ---------------------------------------------------------------------------

  describe("getSupportedExtensions", function () {
    it("should return an array of supported extensions", function () {
      const extensions = DocumentLoaderFactory.getSupportedExtensions();
      expect(extensions).to.be.an("array").that.is.not.empty;
      expect(extensions).to.include(".pdf");
      expect(extensions).to.include(".md");
      expect(extensions).to.include(".markdown");
      expect(extensions).to.include(".html");
      expect(extensions).to.include(".htm");
      expect(extensions).to.include(".txt");
    });
  });

  describe("isSupported", function () {
    it("should return true for supported file extensions", function () {
      expect(DocumentLoaderFactory.isSupported("notes.md")).to.be.true;
      expect(DocumentLoaderFactory.isSupported("page.html")).to.be.true;
      expect(DocumentLoaderFactory.isSupported("readme.txt")).to.be.true;
      expect(DocumentLoaderFactory.isSupported("document.pdf")).to.be.true;
      expect(DocumentLoaderFactory.isSupported("index.htm")).to.be.true;
      expect(DocumentLoaderFactory.isSupported("guide.markdown")).to.be.true;
    });

    it("should return false for unsupported file extensions", function () {
      expect(DocumentLoaderFactory.isSupported("image.png")).to.be.false;
      expect(DocumentLoaderFactory.isSupported("data.csv")).to.be.false;
      expect(DocumentLoaderFactory.isSupported("style.css")).to.be.false;
      expect(DocumentLoaderFactory.isSupported("app.js")).to.be.false;
    });

    it("should return true for web URLs", function () {
      expect(DocumentLoaderFactory.isSupported("https://example.com/page"))
        .to.be.true;
      expect(DocumentLoaderFactory.isSupported("http://docs.site.org/guide"))
        .to.be.true;
    });
  });

  describe("isWebUrl", function () {
    it("should return true for http URLs", function () {
      expect(DocumentLoaderFactory.isWebUrl("http://example.com")).to.be.true;
    });

    it("should return true for https URLs", function () {
      expect(DocumentLoaderFactory.isWebUrl("https://example.com/page")).to.be
        .true;
    });

    it("should return false for file paths", function () {
      expect(DocumentLoaderFactory.isWebUrl("/usr/local/file.txt")).to.be.false;
      expect(DocumentLoaderFactory.isWebUrl("C:\\Users\\file.txt")).to.be.false;
      expect(DocumentLoaderFactory.isWebUrl("relative/path.md")).to.be.false;
    });

    it("should return false for invalid URLs", function () {
      expect(DocumentLoaderFactory.isWebUrl("")).to.be.false;
      expect(DocumentLoaderFactory.isWebUrl("not-a-url")).to.be.false;
    });

    it("should return false for non-http protocols", function () {
      expect(DocumentLoaderFactory.isWebUrl("ftp://files.example.com")).to.be
        .false;
      expect(DocumentLoaderFactory.isWebUrl("file:///local/path")).to.be.false;
    });
  });

  // ---------------------------------------------------------------------------
  // Text file loading
  // ---------------------------------------------------------------------------

  describe("loadDocument - text", function () {
    it("should load a text file", async function () {
      const filePath = path.join(fixturesPath, "sample-text.txt");
      const result = await factory.loadDocument({ filePath });

      expect(result.fileType).to.equal("text");
      expect(result.fileName).to.equal("sample-text.txt");
      expect(result.documents).to.be.an("array").with.length.greaterThan(0);
      expect(result.documents[0].pageContent).to.include(
        "Natural Language Processing"
      );
      expect(result.fileSize).to.be.greaterThan(0);
      expect(result.loadTime).to.be.a("number");
    });

    it("should add common metadata to loaded documents", async function () {
      const filePath = path.join(fixturesPath, "sample-text.txt");
      const result = await factory.loadDocument({ filePath });
      const meta = result.documents[0].metadata;

      expect(meta.fileName).to.equal("sample-text.txt");
      expect(meta.filePath).to.equal(filePath);
      expect(meta.fileType).to.equal("text");
      expect(meta.fileSize).to.be.a("number");
      expect(meta.loadedAt).to.be.a("number");
    });

    it("should include additional metadata when provided", async function () {
      const filePath = path.join(fixturesPath, "sample-text.txt");
      const result = await factory.loadDocument({
        filePath,
        additionalMetadata: { topicId: "test-topic" },
      });

      expect(result.documents[0].metadata.topicId).to.equal("test-topic");
    });
  });

  // ---------------------------------------------------------------------------
  // Markdown file loading
  // ---------------------------------------------------------------------------

  describe("loadDocument - markdown", function () {
    it("should load a markdown file", async function () {
      const filePath = path.join(fixturesPath, "sample.md");
      const result = await factory.loadDocument({ filePath });

      expect(result.fileType).to.equal("markdown");
      expect(result.fileName).to.equal("sample.md");
      expect(result.documents).to.have.length.greaterThan(0);
      expect(result.documents[0].pageContent).to.include(
        "Sample Markdown Document"
      );
    });

    it("should set markdown-specific metadata", async function () {
      const filePath = path.join(fixturesPath, "sample.md");
      const result = await factory.loadDocument({ filePath });

      expect(result.documents[0].metadata.isMarkdown).to.be.true;
      expect(result.documents[0].metadata.preserveStructure).to.be.true;
    });
  });

  // ---------------------------------------------------------------------------
  // HTML file loading
  // ---------------------------------------------------------------------------

  describe("loadDocument - html", function () {
    it("should load an HTML file and extract text", async function () {
      const filePath = path.join(fixturesPath, "sample.html");
      const result = await factory.loadDocument({ filePath });

      expect(result.fileType).to.equal("html");
      expect(result.fileName).to.equal("sample.html");
      expect(result.documents).to.have.length.greaterThan(0);
      // Content should contain text, not HTML tags
      expect(result.documents[0].pageContent).to.include(
        "Machine Learning Basics"
      );
      expect(result.documents[0].pageContent).to.not.include("<h1>");
    });

    it("should set html-specific metadata", async function () {
      const filePath = path.join(fixturesPath, "sample.html");
      const result = await factory.loadDocument({ filePath });

      expect(result.documents[0].metadata.isHTML).to.be.true;
      expect(result.documents[0].metadata.title).to.equal(
        "Sample HTML Document"
      );
    });

    it("should strip script and style tags", async function () {
      const filePath = path.join(fixturesPath, "sample.html");
      const result = await factory.loadDocument({ filePath });
      const content = result.documents[0].pageContent;

      expect(content).to.not.include("<script");
      expect(content).to.not.include("<style");
    });
  });

  // ---------------------------------------------------------------------------
  // File type detection via explicit fileType override
  // ---------------------------------------------------------------------------

  describe("loadDocument - fileType override", function () {
    it("should use explicit fileType over auto-detection", async function () {
      const filePath = path.join(fixturesPath, "sample.md");
      // Force loading as plain text instead of markdown
      const result = await factory.loadDocument({
        filePath,
        fileType: "text",
      });

      expect(result.fileType).to.equal("text");
      // Should still load successfully but without markdown metadata
      expect(result.documents).to.have.length.greaterThan(0);
      expect(result.documents[0].metadata.isMarkdown).to.be.undefined;
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe("loadDocument - errors", function () {
    it("should throw for non-existent file", async function () {
      const filePath = path.join(fixturesPath, "does-not-exist.txt");
      try {
        await factory.loadDocument({ filePath });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("File not found or not readable");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Batch loading (loadDocuments)
  // ---------------------------------------------------------------------------

  describe("loadDocuments", function () {
    it("should load multiple files at once", async function () {
      const paths = [
        path.join(fixturesPath, "sample-text.txt"),
        path.join(fixturesPath, "sample.md"),
        path.join(fixturesPath, "sample.html"),
      ];
      const results = await factory.loadDocuments(paths);

      expect(results).to.have.length(3);
      expect(results.map((r) => r.fileType)).to.include.members([
        "text",
        "markdown",
        "html",
      ]);
    });

    it("should continue loading when some files fail", async function () {
      const paths = [
        path.join(fixturesPath, "sample-text.txt"),
        path.join(fixturesPath, "does-not-exist.txt"),
        path.join(fixturesPath, "sample.md"),
      ];
      const results = await factory.loadDocuments(paths);

      // Should have 2 successful results, the invalid one is skipped
      expect(results).to.have.length(2);
    });

    it("should return empty array for empty input", async function () {
      const results = await factory.loadDocuments([]);
      expect(results).to.be.an("array").with.length(0);
    });

    it("should accept LoaderOptions objects", async function () {
      const results = await factory.loadDocuments([
        { filePath: path.join(fixturesPath, "sample.md") },
        { filePath: path.join(fixturesPath, "sample.html") },
      ]);

      expect(results).to.have.length(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Directory loading
  // ---------------------------------------------------------------------------

  describe("loadDocuments - directory expansion", function () {
    it("should expand a directory to its files", async function () {
      const results = await factory.loadDocuments([
        { filePath: fixturesPath, recursiveDirectory: false },
      ]);

      // Should load all supported files from the fixtures directory
      expect(results.length).to.be.greaterThan(0);
      const fileNames = results.map((r) => r.fileName);
      expect(fileNames).to.include("sample-text.txt");
      expect(fileNames).to.include("sample.md");
      expect(fileNames).to.include("sample.html");
    });

    it("should return empty for directory with no supported files", async function () {
      const unsupportedDir = path.join(fixturesPath, "unsupported-only");
      const results = await factory.loadDocuments([
        { filePath: unsupportedDir, recursiveDirectory: false },
      ]);
      expect(results).to.have.length(0);
    });

    it("should handle empty directories", async function () {
      const emptyDir = path.join(fixturesPath, "empty-dir");
      const results = await factory.loadDocuments([
        { filePath: emptyDir, recursiveDirectory: false },
      ]);
      expect(results).to.have.length(0);
    });

    it("should load recursively from nested directories", async function () {
      const nestedDir = path.join(fixturesPath, "nested");
      const results = await factory.loadDocuments([
        { filePath: nestedDir, recursiveDirectory: true },
      ]);

      const fileNames = results.map((r) => r.fileName);
      expect(fileNames).to.include("shallow.md");
      expect(fileNames).to.include("deep.txt");
    });

    it("should not recurse when recursiveDirectory is false", async function () {
      const nestedDir = path.join(fixturesPath, "nested");
      const results = await factory.loadDocuments([
        { filePath: nestedDir, recursiveDirectory: false },
      ]);

      // nested/ has no files at root level, only subdirs
      expect(results).to.have.length(0);
    });

    it("should filter by includeExtensions", async function () {
      const results = await factory.loadDocuments([
        {
          filePath: fixturesPath,
          recursiveDirectory: false,
          includeExtensions: [".md"],
        },
      ]);

      // Should only load .md files
      for (const r of results) {
        expect(r.fileName).to.match(/\.md$/);
      }
      expect(results.length).to.be.greaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // PDF loading
  // ---------------------------------------------------------------------------

  describe("loadDocument - pdf", function () {
    it("should load a PDF file", async function () {
      const filePath = path.join(fixturesPath, "sample.pdf");
      const result = await factory.loadDocument({ filePath });

      expect(result.fileType).to.equal("pdf");
      expect(result.fileName).to.equal("sample.pdf");
      expect(result.documents).to.have.length.greaterThan(0);
      expect(result.documents[0].pageContent).to.include("Hello PDF World");
    });

    it("should add common metadata to PDF documents", async function () {
      const filePath = path.join(fixturesPath, "sample.pdf");
      const result = await factory.loadDocument({ filePath });
      const meta = result.documents[0].metadata;

      expect(meta.fileName).to.equal("sample.pdf");
      expect(meta.fileType).to.equal("pdf");
      expect(meta.fileSize).to.be.greaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // HTML edge cases
  // ---------------------------------------------------------------------------

  describe("loadDocument - html edge cases", function () {
    it("should handle malformed HTML", async function () {
      const filePath = path.join(fixturesPath, "sample-malformed.html");
      const result = await factory.loadDocument({ filePath });

      expect(result.documents).to.have.length(1);
      const content = result.documents[0].pageContent;
      // Should still extract text despite malformed tags
      expect(content).to.include("Unclosed heading");
      expect(content).to.include("Content after comment");
    });

    it("should strip mixed-case script tags", async function () {
      const filePath = path.join(fixturesPath, "sample-malformed.html");
      const result = await factory.loadDocument({ filePath });
      const content = result.documents[0].pageContent;

      expect(content).to.not.include("should be removed");
    });

    it("should extract title from malformed HTML", async function () {
      const filePath = path.join(fixturesPath, "sample-malformed.html");
      const result = await factory.loadDocument({ filePath });

      expect(result.documents[0].metadata.title).to.equal(
        "Malformed HTML Test"
      );
    });

    it("should strip style tag content", async function () {
      const filePath = path.join(fixturesPath, "sample-malformed.html");
      const result = await factory.loadDocument({ filePath });
      const content = result.documents[0].pageContent;

      expect(content).to.not.include("font-size");
      expect(content).to.not.include("color: red");
    });
  });

  // ---------------------------------------------------------------------------
  // File path edge cases
  // ---------------------------------------------------------------------------

  describe("loadDocument - path edge cases", function () {
    it("should load files with spaces in name", async function () {
      const filePath = path.join(fixturesPath, "file with spaces.txt");
      const result = await factory.loadDocument({ filePath });

      expect(result.fileName).to.equal("file with spaces.txt");
      expect(result.documents).to.have.length.greaterThan(0);
    });

    it("should load files with multiple dots in name", async function () {
      const filePath = path.join(fixturesPath, "file.backup.md");
      const result = await factory.loadDocument({ filePath });

      expect(result.fileName).to.equal("file.backup.md");
      expect(result.fileType).to.equal("markdown");
    });
  });

  // ---------------------------------------------------------------------------
  // detectFileType via URL patterns
  // ---------------------------------------------------------------------------

  describe("file type detection via URL", function () {
    it("should detect web URLs as web type", async function () {
      // We can't actually load a URL without network, but we can
      // verify isSupported and isWebUrl work for URL patterns
      expect(DocumentLoaderFactory.isWebUrl("https://example.com")).to.be.true;
      expect(DocumentLoaderFactory.isSupported("https://example.com/page")).to.be
        .true;
    });
  });

  // ---------------------------------------------------------------------------
  // loadResult structure validation
  // ---------------------------------------------------------------------------

  describe("loadDocument - result structure", function () {
    it("should always include loadTime as a positive number", async function () {
      const filePath = path.join(fixturesPath, "sample-text.txt");
      const result = await factory.loadDocument({ filePath });

      expect(result.loadTime).to.be.a("number");
      expect(result.loadTime).to.be.at.least(0);
    });

    it("should always include fileSize for local files", async function () {
      const filePath = path.join(fixturesPath, "sample-text.txt");
      const result = await factory.loadDocument({ filePath });

      const actualSize = fs.statSync(filePath).size;
      expect(result.fileSize).to.equal(actualSize);
    });

    it("should always include loadedAt timestamp in metadata", async function () {
      const before = Date.now();
      const filePath = path.join(fixturesPath, "sample-text.txt");
      const result = await factory.loadDocument({ filePath });
      const after = Date.now();

      const loadedAt = result.documents[0].metadata.loadedAt;
      expect(loadedAt).to.be.at.least(before);
      expect(loadedAt).to.be.at.most(after);
    });
  });
});
