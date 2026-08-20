import { lookup } from "dns/promises";
import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { BlockList, isIP } from "net";
import type { LookupFunction } from "net";
import { load as loadHtml } from "cheerio";
import { Document as LangChainDocument } from "@langchain/core/documents";
import { Logger } from "../logger";
import { DocumentLoader, LoaderOptions } from "./types";

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const blockedIpv6 = new BlockList();
blockedIpv6.addSubnet("::", 128, "ipv6");
blockedIpv6.addSubnet("::1", 128, "ipv6");
blockedIpv6.addSubnet("fc00::", 7, "ipv6");
blockedIpv6.addSubnet("fe80::", 10, "ipv6");
blockedIpv6.addSubnet("fec0::", 10, "ipv6");
blockedIpv6.addSubnet("ff00::", 8, "ipv6");

export class WebDocumentLoader implements DocumentLoader {
  private logger = new Logger("WebDocumentLoader");

  async load(inputUrl: string, options: LoaderOptions): Promise<LangChainDocument[]> {
    this.logger.debug("Loading web page", { url: inputUrl });
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let current = new URL(inputUrl);

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const addresses = await this.assertPublicUrl(current);
      const response = await this.fetchResponse(current, signal, addresses);
      try {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location) {
            throw new Error(`Redirect ${response.status} did not include a Location header`);
          }
          await response.body?.cancel();
          current = new URL(location, current);
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Authentication required (Status ${response.status})`);
        }
        if (!response.ok) {
          throw new Error(`Failed to fetch URL (Status ${response.status})`);
        }
        const observedUrl = response.url ? new URL(response.url, current) : current;
        await this.assertPublicUrl(observedUrl);
        if (/\/(?:login|signin|auth)(?:[/?#]|$)/i.test(observedUrl.pathname)) {
          throw new Error("Redirected to potential login page");
        }
        const declared = Number(response.headers.get("content-length") ?? 0);
        if (declared > MAX_RESPONSE_BYTES) {
          throw new Error("Web response exceeds the 10 MiB limit");
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MAX_RESPONSE_BYTES) {
          throw new Error("Web response exceeds the 10 MiB limit");
        }
        const html = new TextDecoder().decode(bytes);
        if (/type\s*=\s*["']password["']/i.test(html)) {
          throw new Error("Page contains password field");
        }
        const $ = loadHtml(html);
        $("script,style,noscript").remove();
        const selected = options.selector ? $(options.selector) : $("body");
        const text = selected.text().replace(/\s+/g, " ").trim();
        if (!text) {
          throw new Error("Web page contained no indexable text");
        }
        return [
          new LangChainDocument({
            pageContent: text,
            metadata: { source: current.toString(), title: $("title").first().text().trim() },
          }),
        ];
      } finally {
        if (response.body && !response.bodyUsed) {
          await response.body.cancel();
        }
      }
    }
    throw new Error(`Too many redirects (maximum ${MAX_REDIRECTS})`);
  }

  private async assertPublicUrl(url: URL): Promise<Array<{ address: string; family?: number }>> {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only HTTP(S) URLs are supported");
    }
    if (url.username || url.password) {
      throw new Error("URLs containing credentials are not allowed");
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      throw new Error("Private URLs are not allowed");
    }
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await this.resolveAddresses(hostname);
    if (addresses.length === 0 || addresses.some(({ address }) => this.isPrivateAddress(address))) {
      throw new Error("URL resolves to a private, loopback, or link-local address");
    }
    return addresses;
  }

  protected resolveAddresses(hostname: string): Promise<Array<{ address: string; family?: number }>> {
    return lookup(hostname, { all: true, verbatim: true });
  }

  private createPinnedLookup(addresses: Array<{ address: string; family?: number }>): LookupFunction {
    let cursor = 0;
    return (_hostname, options, callback) => {
      const requestedFamily = Number(options?.family ?? 0);
      const eligible = requestedFamily
        ? addresses.filter(({ address, family }) => (family ?? isIP(address)) === requestedFamily)
        : addresses;
      const selected = eligible[cursor++ % eligible.length];
      if (!selected) {
        callback(Object.assign(new Error("No validated address for requested family"), { code: "ENOTFOUND" }), "", 0);
        return;
      }
      callback(null, selected.address, selected.family ?? isIP(selected.address));
    };
  }

  /** Fetch through a DNS-pinned native request to close the DNS-rebinding TOCTOU gap. */
  protected fetchResponse(
    url: URL,
    signal: AbortSignal,
    addresses: Array<{ address: string; family?: number }>,
  ): Promise<Response> {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        url,
        {
          method: "GET",
          signal,
          lookup: this.createPinnedLookup(addresses),
          headers: { "User-Agent": "RAGnarok/0.4.0", Accept: "text/html,text/plain;q=0.9" },
        },
        (response) => {
          const declared = Number(response.headers["content-length"] ?? 0);
          if (declared > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("Web response exceeds the 10 MiB limit"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > MAX_RESPONSE_BYTES) {
              response.destroy(new Error("Web response exceeds the 10 MiB limit"));
              return;
            }
            chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("end", () => {
            const status = response.statusCode ?? 500;
            const body = status === 204 || status === 304 ? null : Buffer.concat(chunks);
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
                headers.append(name, item);
              }
            }
            resolve(
              new Response(body, {
                status,
                statusText: response.statusMessage,
                headers,
              }),
            );
          });
        },
      );
      req.once("error", reject);
      req.end();
    });
  }

  private isPrivateAddress(address: string): boolean {
    const normalized = address.toLowerCase();
    if (isIP(normalized) === 6 && blockedIpv6.check(normalized, "ipv6")) {
      return true;
    }
    const dottedMapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    const hexMapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    const mapped =
      dottedMapped ??
      (hexMapped
        ? [
            Number.parseInt(hexMapped[1], 16) >> 8,
            Number.parseInt(hexMapped[1], 16) & 0xff,
            Number.parseInt(hexMapped[2], 16) >> 8,
            Number.parseInt(hexMapped[2], 16) & 0xff,
          ].join(".")
        : undefined);
    const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : null);
    if (!ipv4) {
      return false;
    }
    const [a, b, c] = ipv4.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
}
