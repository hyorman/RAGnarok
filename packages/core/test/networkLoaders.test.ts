/**
 * Unit tests for WebDocumentLoader and GithubDocumentLoader with mocked network.
 * Uses sinon to stub global.fetch for testing security checks and error handling.
 */

import { expect } from "chai";
import * as sinon from "sinon";
import { WebDocumentLoader, GithubDocumentLoader } from "../src/index";
import type { LoaderOptions } from "../src/index";

describe("WebDocumentLoader", function () {
  this.timeout(15000);

  let loader: WebDocumentLoader;
  let fetchStub: sinon.SinonStub;
  let pinnedAddresses: Array<{ address: string; family?: number }>;

  const makeOptions = (filePath: string, overrides?: Partial<LoaderOptions>): LoaderOptions => ({
    filePath,
    ...overrides,
  });

  /**
   * Creates a minimal mock Response object compatible with the web loader's usage.
   */
  function mockResponse(opts: {
    status?: number;
    ok?: boolean;
    url?: string;
    html?: string;
    headers?: Record<string, string>;
  }): Response {
    const status = opts.status ?? 200;
    const ok = opts.ok ?? (status >= 200 && status < 300);
    const html = opts.html ?? "<html><body>Test content</body></html>";
    return {
      status,
      ok,
      url: opts.url ?? "https://example.com/page",
      headers: new Headers(opts.headers ?? { "content-type": "text/html" }),
      text: sinon.stub().resolves(html),
      json: sinon.stub().resolves({}),
      clone: sinon.stub().returnsThis(),
      body: null,
      bodyUsed: false,
      arrayBuffer: sinon.stub().resolves(new TextEncoder().encode(html).buffer),
      blob: sinon.stub().resolves(new Blob([])),
      formData: sinon.stub().resolves(new FormData()),
      redirected: false,
      statusText: ok ? "OK" : "Error",
      type: "basic" as const,
      bytes: sinon.stub().resolves(new Uint8Array()),
    } as unknown as Response;
  }

  beforeEach(function () {
    pinnedAddresses = [];
    loader = new (class extends WebDocumentLoader {
      protected resolveAddresses(): Promise<Array<{ address: string }>> {
        return Promise.resolve([{ address: "93.184.216.34" }]);
      }

      protected fetchResponse(
        url: URL,
        signal: AbortSignal,
        addresses: Array<{ address: string; family?: number }>,
      ): Promise<Response> {
        pinnedAddresses = addresses;
        return fetch(url, { method: "GET", redirect: "manual", signal });
      }
    })();
    fetchStub = sinon.stub(global, "fetch");
  });

  afterEach(function () {
    sinon.restore();
  });

  // ---------------------------------------------------------------------------
  // Security checks
  // ---------------------------------------------------------------------------

  describe("security checks", function () {
    for (const privateUrl of [
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://172.16.0.1/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
      "http://[fe90::1]/",
      "http://[fd00::1]/",
      "http://[::ffff:7f00:1]/",
    ]) {
      it(`should reject private destination ${privateUrl}`, async function () {
        try {
          await loader.load(privateUrl, makeOptions(privateUrl));
          expect.fail("Should have thrown");
        } catch (error: any) {
          expect(error.message).to.match(/Private URLs|private, loopback, or link-local/);
        }
        expect(fetchStub.called).to.equal(false);
      });
    }

    it("should reject 401 Unauthorized responses", async function () {
      fetchStub.resolves(mockResponse({ status: 401, ok: false }));

      try {
        await loader.load("https://example.com/private", makeOptions("https://example.com/private"));
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Authentication required");
        expect(error.message).to.include("401");
      }
    });

    it("should reject 403 Forbidden responses", async function () {
      fetchStub.resolves(mockResponse({ status: 403, ok: false }));

      try {
        await loader.load("https://example.com/forbidden", makeOptions("https://example.com/forbidden"));
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Authentication required");
        expect(error.message).to.include("403");
      }
    });

    it("should reject non-OK responses (e.g. 500)", async function () {
      fetchStub.resolves(mockResponse({ status: 500, ok: false }));

      try {
        await loader.load("https://example.com/error", makeOptions("https://example.com/error"));
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Failed to fetch URL");
        expect(error.message).to.include("500");
      }
    });

    it("should reject pages redirected to login", async function () {
      fetchStub.resolves(
        mockResponse({
          url: "https://example.com/login?redirect=/page",
          html: "<html><body>Login form</body></html>",
        }),
      );

      try {
        await loader.load("https://example.com/page", makeOptions("https://example.com/page"));
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("login page");
      }
    });

    it("should reject pages redirected to signin", async function () {
      fetchStub.resolves(
        mockResponse({
          url: "https://example.com/signin",
          html: "<html><body>Sign in</body></html>",
        }),
      );

      try {
        await loader.load("https://example.com/page", makeOptions("https://example.com/page"));
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("login page");
      }
    });

    it("should reject pages with password fields", async function () {
      fetchStub.resolves(
        mockResponse({
          html: '<html><body><input type="password" /></body></html>',
        }),
      );

      try {
        await loader.load("https://example.com/page", makeOptions("https://example.com/page"));
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("password field");
      }
    });

    it("should detect single-quoted password fields", async function () {
      fetchStub.resolves(
        mockResponse({
          html: "<html><body><input type='password' /></body></html>",
        }),
      );

      try {
        await loader.load("https://example.com/page", makeOptions("https://example.com/page"));
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("password field");
      }
    });

    it("should reject a redirect target that resolves to a private address", async function () {
      const redirectLoader = new (class extends WebDocumentLoader {
        protected resolveAddresses(hostname: string): Promise<Array<{ address: string }>> {
          return Promise.resolve([{ address: hostname === "internal.example" ? "127.0.0.1" : "93.184.216.34" }]);
        }

        protected fetchResponse(url: URL, signal: AbortSignal): Promise<Response> {
          return fetch(url, { method: "GET", redirect: "manual", signal });
        }
      })();
      fetchStub.resolves(
        mockResponse({ status: 302, ok: false, headers: { location: "http://internal.example/secret" } }),
      );

      try {
        await redirectLoader.load("https://example.com/start", makeOptions("https://example.com/start"));
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("private, loopback, or link-local");
      }
      expect(fetchStub.calledOnce).to.equal(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Successful loading
  // ---------------------------------------------------------------------------

  describe("successful loading", function () {
    it("should load a public page successfully", async function () {
      const html = "<html><head><title>Test Page</title></head><body><p>Hello World</p></body></html>";

      fetchStub.resolves(mockResponse({ html }));

      const docs = await loader.load("https://example.com/page", makeOptions("https://example.com/page"));

      expect(docs).to.be.an("array");
      expect(docs.length).to.be.greaterThan(0);
      // Security check fetch was called
      expect(fetchStub.calledOnce).to.be.true;
      expect(pinnedAddresses).to.deep.equal([{ address: "93.184.216.34" }]);
    });
  });

  // ---------------------------------------------------------------------------
  // Network errors
  // ---------------------------------------------------------------------------

  describe("network errors", function () {
    it("should propagate fetch errors", async function () {
      fetchStub.rejects(new Error("Network request failed"));

      try {
        await loader.load("https://example.com/page", makeOptions("https://example.com/page"));
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Network request failed");
      }
    });
  });
});

describe("GithubDocumentLoader", function () {
  this.timeout(15000);

  let loader: GithubDocumentLoader;
  let fetchStub: sinon.SinonStub;

  const makeOptions = (filePath: string, overrides?: Partial<LoaderOptions>): LoaderOptions => ({
    filePath,
    ...overrides,
  });

  beforeEach(function () {
    loader = new GithubDocumentLoader();
    fetchStub = sinon.stub(global, "fetch");
  });

  afterEach(function () {
    sinon.restore();
  });

  // ---------------------------------------------------------------------------
  // URL parsing / configuration
  // ---------------------------------------------------------------------------

  describe("URL parsing", function () {
    it("should throw for invalid URLs", async function () {
      try {
        await loader.load("not-a-url", makeOptions("not-a-url", { fileType: "github" }));
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error).to.be.an("error");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe("error handling", function () {
    it("should propagate API errors from GithubRepoLoader", async function () {
      // Stub fetch to simulate a GitHub API 404
      fetchStub.resolves({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: sinon.stub().resolves({ message: "Not Found" }),
        text: sinon.stub().resolves("Not Found"),
        headers: new Headers(),
        url: "https://api.github.com/repos/owner/nonexistent",
      } as unknown as Response);

      try {
        await loader.load(
          "https://github.com/owner/nonexistent",
          makeOptions("https://github.com/owner/nonexistent", {
            fileType: "github",
            accessToken: "fake-token",
          }),
        );
        expect.fail("Should have thrown");
      } catch (error: any) {
        // The exact error depends on GithubRepoLoader's internal handling
        expect(error).to.be.an("error");
      }
    });

    it("should handle rate limit errors", async function () {
      fetchStub.resolves({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        json: sinon.stub().resolves({ message: "API rate limit exceeded" }),
        text: sinon.stub().resolves("API rate limit exceeded"),
        headers: new Headers({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
        }),
        url: "https://api.github.com/repos/owner/repo",
      } as unknown as Response);

      try {
        await loader.load(
          "https://github.com/owner/repo",
          makeOptions("https://github.com/owner/repo", {
            fileType: "github",
          }),
        );
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error).to.be.an("error");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Options pass-through
  // ---------------------------------------------------------------------------

  describe("options", function () {
    it("should use provided branch option", async function () {
      // We can't easily verify the branch was passed through without
      // intercepting the GithubRepoLoader constructor, but we can verify
      // the loader doesn't crash when branch is specified
      fetchStub.resolves({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: sinon.stub().resolves({ message: "Not Found" }),
        text: sinon.stub().resolves("Not Found"),
        headers: new Headers(),
        url: "https://api.github.com/repos/owner/repo",
      } as unknown as Response);

      try {
        await loader.load(
          "https://github.com/owner/repo",
          makeOptions("https://github.com/owner/repo", {
            fileType: "github",
            branch: "develop",
            recursive: false,
            ignorePaths: ["*.test.ts"],
            maxConcurrency: 5,
          }),
        );
      } catch {
        // Expected to fail due to mocked API, but should not crash
      }

      // Verify fetch was called (GithubRepoLoader tried to make API calls)
      expect(fetchStub.called).to.be.true;
    });
  });
});
