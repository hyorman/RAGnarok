/**
 * HTTP transport for RAGnarōk MCP Server
 *
 * Uses the MCP SDK's modern per-request HTTP handler with Express.
 * Supports:
 * - Optional API key authentication
 * - CORS
 * - Rate limiting
 * - Health endpoint
 * - Multiple concurrent MCP exchanges
 * - Graceful shutdown
 */

import { createHash, randomUUID, timingSafeEqual } from "crypto";
import * as fs from "fs";
import { createServer, Server } from "http";
import { createServer as createHttpsServer } from "https";
import { isIP } from "net";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { McpServer, createMcpHandler, type AuthInfo, type McpHttpHandler } from "@modelcontextprotocol/server";
import cors from "cors";
import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { Logger } from "@ragnarok/core";
import { McpConfig, getServerVersion } from "./config";
import { TransferError, TransferManager } from "./transferManager";
import { mcpAuditContext } from "./auditContext";

export interface HttpTransportHandle {
  httpServer: Server;
  closeAdmission(): void;
  rotateTokens(tokens: { reader?: string; curator?: string; admin?: string }, role?: AccessRole): Promise<void>;
  /** Stop admission, close modern exchanges, and stop the listener. Idempotent. */
  shutdown(absoluteDeadline?: number): Promise<void>;
}

export type AccessRole = "reader" | "curator" | "admin";

export interface HttpTransportOptions {
  readiness?: () => { ready: boolean; reasons?: string[] } | Promise<{ ready: boolean; reasons?: string[] }>;
  transferManager?: TransferManager;
}

export function resolveForwardedClientIp(
  directPeer: string,
  forwardedFor: string | undefined,
  trustedProxyIps: ReadonlySet<string>,
): string {
  const normalize = (value: string): string => value.replace(/^::ffff:/, "").replace(/^\[|\]$/g, "");
  const direct = normalize(directPeer);
  if (!trustedProxyIps.has(direct)) {
    return direct;
  }
  const forwarded = String(forwardedFor ?? "")
    .split(",")
    .map((value) => normalize(value.trim()))
    .filter((value) => isIP(value) !== 0);
  // Walk from the socket towards the originating client. Trusted hops are
  // discarded; the first untrusted hop is the client address used for quotas
  // and audit. This prevents a client-supplied leftmost XFF value from winning
  // when a correctly configured proxy appends its observed peer.
  for (let index = forwarded.length - 1; index >= 0; index--) {
    if (!trustedProxyIps.has(forwarded[index])) {
      return forwarded[index];
    }
  }
  return forwarded[0] ?? direct;
}

function mcpResponseFailed(payload: unknown): boolean {
  if (Array.isArray(payload)) {
    return payload.some(mcpResponseFailed);
  }
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const response = payload as { error?: unknown; result?: { isError?: unknown } };
  return response.error !== undefined || response.result?.isError === true;
}

function serializedMcpResponseFailed(serialized: string): boolean {
  const candidates = [
    serialized,
    ...serialized
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim()),
  ];
  return candidates.some((candidate) => {
    if (!candidate || candidate === "[DONE]") {
      return false;
    }
    try {
      return mcpResponseFailed(JSON.parse(candidate));
    } catch {
      return false;
    }
  });
}

/**
 * Browser Origin policy for the MCP endpoint.
 *
 * Requests without an Origin header are non-browser MCP/CLI traffic and are
 * allowed through to authentication. The safe default ("loopback") accepts
 * only pages served from a loopback host. A legacy "*" value is deliberately
 * treated as the same loopback-only policy instead of restoring a wildcard.
 */
function isAllowedRequestOrigin(origin: string, config: McpConfig): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLoopbackOrigin = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (config.corsOrigin === "loopback" || config.corsOrigin === "*") {
    return isLoopbackOrigin;
  }

  try {
    return parsed.origin === new URL(config.corsOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * Start the MCP server with HTTP transport.
 *
 * The SDK handler creates a fresh McpServer for every modern HTTP request.
 * Tool handlers share the underlying services, which are singletons owned by
 * the caller.
 *
 * @param createMcpServer - Factory producing a fully tool-registered McpServer
 * @param config - MCP server configuration
 * @returns Handle with the listening http.Server and a shutdown function
 */
export function startHttpTransport(
  createMcpServer: (role: AccessRole, principal?: string) => McpServer,
  config: McpConfig,
  options?: HttpTransportOptions,
): Promise<HttpTransportHandle>;
/** @deprecated Compatibility overload for the pre-role-facade reader/writer factory. */
export function startHttpTransport(
  createMcpServer: (role: "reader" | "writer", principal?: string) => McpServer,
  config: McpConfig,
  options?: HttpTransportOptions,
): Promise<HttpTransportHandle>;
export async function startHttpTransport(
  createMcpServer: (role: any, principal?: string) => McpServer,
  config: McpConfig,
  options: HttpTransportOptions = {},
): Promise<HttpTransportHandle> {
  const logger = new Logger("HTTP-Transport");
  const loopbackBind = ["127.0.0.1", "::1", "localhost"].includes(config.httpHost.toLowerCase());
  if ((config.deploymentMode === "shared" || !loopbackBind) && !config.allowedHosts?.length) {
    throw new Error("Shared or non-loopback HTTP requires at least one exact RAGNAROK_ALLOWED_HOSTS entry");
  }

  const app = express();
  const normalizeIp = (value: string): string => value.replace(/^::ffff:/, "").replace(/^\[|\]$/g, "");
  const trustedProxies = new Set((config.trustedProxies ?? []).map(normalizeIp));
  const directPeer = (req: any): string => normalizeIp(String(req.socket?.remoteAddress ?? ""));
  const isTrustedPeer = (req: any): boolean => trustedProxies.has(directPeer(req));
  const clientIp = (req: any): string => {
    const direct = directPeer(req);
    return resolveForwardedClientIp(direct, req.headers["x-forwarded-for"] as string | undefined, trustedProxies);
  };
  const boundedDiagnostic = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value.slice(0, 256) : undefined;
  if (trustedProxies.size > 0) {
    (app as any).set("trust proxy", (ip: string) => trustedProxies.has(normalizeIp(ip)));
  }

  const normalizeRequestHost = (raw: string): string => {
    const value = raw.trim().toLowerCase();
    if (!value || /[\\/@\s]/.test(value)) {
      return "";
    }
    if (value.startsWith("[")) {
      const closing = value.indexOf("]");
      return closing > 1 && (closing === value.length - 1 || value[closing + 1] === ":") ? value.slice(1, closing) : "";
    }
    const separators = [...value].filter((character) => character === ":").length;
    return separators > 1 ? value : value.split(":", 1)[0];
  };
  app.use((req, res, next) => {
    const forwardedHost = isTrustedPeer(req)
      ? String(req.headers["x-forwarded-host"] ?? "")
          .split(",")
          .at(-1)
          ?.trim()
      : "";
    const hostname = normalizeRequestHost(forwardedHost || String(req.headers.host ?? ""));
    const loopbackHosts = ["localhost", "127.0.0.1", "::1"];
    const allowed = new Set(
      (config.allowedHosts?.length
        ? config.allowedHosts
        : loopbackHosts.includes(config.httpHost.toLowerCase())
          ? [config.httpHost, ...loopbackHosts]
          : []
      ).map((host) => normalizeRequestHost(host)),
    );
    if (!hostname || !allowed.has(hostname)) {
      res.status(403).json({ error: { code: "HOST_NOT_ALLOWED", message: "Host header not allowed" } });
      return;
    }
    next();
  });

  const requiresVerifiedTls = config.deploymentMode === "shared" || !loopbackBind;
  app.use((req, res, next) => {
    if (!requiresVerifiedTls) {
      next();
      return;
    }
    const nativeTls = Boolean((req.socket as any).encrypted);
    const proxyTls = isTrustedPeer(req) && String(req.headers["x-forwarded-proto"] ?? "").toLowerCase() === "https";
    if (!nativeTls && !proxyTls) {
      res.status(400).json({ error: { code: "TLS_REQUIRED", message: "Verified HTTPS transport is required" } });
      return;
    }
    next();
  });

  // Reject untrusted browser origins before rate limiting, authentication,
  // request parsing, server construction, or session allocation. Merely
  // omitting an Access-Control-Allow-Origin header is insufficient: the
  // browser would block the response but the write could still execute.
  app.use(["/mcp", "/transfer"], (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !isAllowedRequestOrigin(origin, config)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    next();
  });

  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || isAllowedRequestOrigin(origin, config)),
    }),
  );
  logger.debug(`CORS enabled (origin policy: ${config.corsOrigin})`);

  const serverVersion = getServerVersion();
  let accepting = true;
  let activeRequests = 0;
  const drainWaiters: Array<() => void> = [];
  const notifyDrained = (): void => {
    if (activeRequests === 0) {
      for (const resolve of drainWaiters.splice(0)) {
        resolve();
      }
    }
  };

  // Health and readiness use a separate generous limiter and never consume a
  // user's MCP request quota.
  const healthLimiter = rateLimit({
    windowMs: 60_000,
    max: Math.max(120, config.rateLimitPerMinute * 10),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
  });
  app.use(["/health", "/ready"], healthLimiter);
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      version: serverVersion,
      uptime: process.uptime(),
    });
  });
  app.get("/ready", async (_req, res) => {
    const runtime = options.readiness ? await options.readiness() : { ready: true, reasons: [] };
    const ready = accepting && runtime.ready;
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      version: serverVersion,
      reasons: accepting ? (runtime.reasons ?? []) : ["draining"],
    });
  });

  app.use(
    ["/mcp", "/transfer"],
    rateLimit({
      windowMs: 60_000,
      max: config.rateLimitPerMinute,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
      handler: (req, res, _next, options) => {
        logger.warn("MCP rate limit exceeded", {
          clientIp: clientIp(req),
          method: boundedDiagnostic(req.headers["mcp-method"]),
          name: boundedDiagnostic(req.headers["mcp-name"]),
        });
        res.status(options.statusCode).json({
          error: { code: "RATE_LIMITED", message: "Too many requests" },
        });
      },
    }),
  );
  logger.debug(`User rate limiting enabled (${config.rateLimitPerMinute} MCP req/min)`);

  app.use("/mcp", (req, res, next) => {
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > (config.maxRequestBytes ?? 1_048_576)) {
      res.status(413).json({ error: { code: "REQUEST_TOO_LARGE", message: "Request exceeds configured limit" } });
      return;
    }
    next();
  });
  // Scope parsers so binary transfer PUT bodies stay as streams. Express'
  // limit applies to decoded Content-Length and chunked JSON bodies.
  app.use("/mcp", express.json({ limit: config.maxRequestBytes ?? 1_048_576 }));
  app.use("/transfer/uploads", express.json({ limit: 16 * 1024 }));

  let tokens = {
    reader: config.apiKey,
    curator: config.writeApiKey,
    admin: config.adminApiKey ?? "",
  };

  const secureEquals = (actual: string, expected: string): boolean => {
    const a = Buffer.from(actual);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const principalFor = (role: AccessRole, token: string): string =>
    `${role}:${createHash("sha256")
      .update(token || "local-owner")
      .digest("hex")
      .slice(0, 16)}`;
  const classifyAuthorization = (authorization: string): { role: AccessRole; principal: string } | null => {
    if (config.deploymentMode !== "shared" && !tokens.reader && !tokens.curator && !tokens.admin) {
      return { role: "admin", principal: principalFor("admin", "") };
    }
    if (tokens.admin && secureEquals(authorization, `Bearer ${tokens.admin}`)) {
      return { role: "admin", principal: principalFor("admin", tokens.admin) };
    }
    if (tokens.curator && secureEquals(authorization, `Bearer ${tokens.curator}`)) {
      return { role: "curator", principal: principalFor("curator", tokens.curator) };
    }
    if (tokens.reader && secureEquals(authorization, `Bearer ${tokens.reader}`)) {
      // Direct callers from the compatibility window may omit deploymentMode;
      // retain their historical read-token role. Explicit local mode treats
      // its single personal token as the owner/admin capability.
      const role: AccessRole =
        config.deploymentMode === undefined ? "reader" : config.deploymentMode === "shared" ? "reader" : "admin";
      return { role, principal: principalFor(role, tokens.reader) };
    }
    return null;
  };

  const mcpHandler: McpHttpHandler = createMcpHandler(
    ({ authInfo }) => {
      const role = authInfo?.extra?.role;
      if (!authInfo || (role !== "reader" && role !== "curator" && role !== "admin")) {
        throw new Error("Authenticated MCP request is missing a valid role");
      }
      const factoryRole = config.deploymentMode ? role : role === "reader" ? "reader" : "writer";
      return createMcpServer(factoryRole, authInfo.clientId);
    },
    {
      legacy: "reject",
      onerror: (error) => logger.error("MCP handler error", error),
    },
  );
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => logger.error("MCP Node adapter error", error),
  });

  const authenticateTransfer = (req: any): { role: AccessRole; principal: string } => {
    const result = classifyAuthorization(String(req.headers.authorization || ""));
    if (!result) {
      throw new TransferError("UNAUTHORIZED", "Unauthorized", 401);
    }
    return result;
  };
  const transferFailure = (res: any, error: unknown, correlationId: string): void => {
    const failure =
      error instanceof TransferError ? error : new TransferError("TRANSFER_FAILED", "Transfer failed", 500);
    if (!(error instanceof TransferError)) {
      logger.error(`Unexpected transfer failure (${correlationId})`, error);
    }
    if (!res.headersSent) {
      res.status(failure.status).json({
        error: { code: failure.code, message: failure.message },
        correlationId,
      });
    } else {
      res.destroy(error instanceof Error ? error : undefined);
    }
  };

  if (options.transferManager) {
    app.post("/transfer/uploads", async (req, res) => {
      const correlationId = String(req.headers["x-correlation-id"] || randomUUID()).slice(0, 128);
      res.setHeader("x-correlation-id", correlationId);
      let principal = "unauthenticated";
      let outcome = "failed";
      activeRequests++;
      try {
        if (!accepting) {
          throw new TransferError("SERVER_DRAINING", "Server is draining", 503);
        }
        const auth = authenticateTransfer(req);
        principal = auth.principal;
        const handle = await options.transferManager!.createUpload(principal, auth.role, req.body);
        outcome = "success";
        res.status(201).json(handle);
      } catch (error) {
        transferFailure(res, error, correlationId);
      } finally {
        activeRequests--;
        notifyDrained();
        logger.info("audit", { principal, action: "transfer.upload.create", object: "upload", outcome, correlationId });
      }
    });

    app.put("/transfer/uploads/:id", async (req, res) => {
      const correlationId = String(req.headers["x-correlation-id"] || randomUUID()).slice(0, 128);
      res.setHeader("x-correlation-id", correlationId);
      let principal = "unauthenticated";
      let outcome = "failed";
      activeRequests++;
      try {
        if (!accepting) {
          throw new TransferError("SERVER_DRAINING", "Server is draining", 503);
        }
        const auth = authenticateTransfer(req);
        principal = auth.principal;
        const result = await options.transferManager!.receiveUpload(principal, req.params.id, req);
        outcome = "success";
        res.status(200).json({ id: req.params.id, state: "ready", ...result });
      } catch (error) {
        transferFailure(res, error, correlationId);
      } finally {
        activeRequests--;
        notifyDrained();
        logger.info("audit", {
          principal,
          action: "transfer.upload.put",
          object: req.params.id,
          outcome,
          correlationId,
        });
      }
    });

    app.get("/transfer/downloads/:id", async (req, res) => {
      const correlationId = String(req.headers["x-correlation-id"] || randomUUID()).slice(0, 128);
      res.setHeader("x-correlation-id", correlationId);
      let principal = "unauthenticated";
      let outcome = "failed";
      activeRequests++;
      try {
        if (!accepting) {
          throw new TransferError("SERVER_DRAINING", "Server is draining", 503);
        }
        const auth = authenticateTransfer(req);
        principal = auth.principal;
        if (req.headers.range) {
          throw new TransferError("DOWNLOAD_NOT_RESUMABLE", "Range downloads are not supported", 416);
        }
        await options.transferManager!.serveDownload(principal, req.params.id, res);
        outcome = "success";
      } catch (error) {
        transferFailure(res, error, correlationId);
      } finally {
        activeRequests--;
        notifyDrained();
        logger.info("audit", {
          principal,
          action: "transfer.download",
          object: req.params.id,
          outcome,
          correlationId,
        });
      }
    });
  }

  app.all("/mcp", async (req, res) => {
    const correlationId = String(req.headers["x-correlation-id"] || randomUUID()).slice(0, 128);
    res.setHeader("x-correlation-id", correlationId);
    if (!accepting) {
      res.status(503).json({ error: { code: "SERVER_DRAINING", message: "Server is draining" }, correlationId });
      return;
    }
    activeRequests++;
    let auditPrincipal = "unauthenticated";
    let auditRole = "unauthenticated";
    let auditOutcome = "failed";
    let responseReportedFailure = false;
    let responsePreview = "";
    const observeResponseChunk = (chunk: unknown): void => {
      if (responsePreview.length >= (config.maxResponseBytes ?? 1_048_576)) {
        return;
      }
      if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
        responsePreview += chunk.toString().slice(0, (config.maxResponseBytes ?? 1_048_576) - responsePreview.length);
      }
    };
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      responseReportedFailure ||= mcpResponseFailed(body);
      return originalJson(body);
    }) as typeof res.json;
    const originalWrite = res.write.bind(res);
    res.write = ((chunk: unknown, ...args: unknown[]) => {
      observeResponseChunk(chunk);
      return (originalWrite as (...writeArgs: unknown[]) => unknown)(chunk, ...args);
    }) as typeof res.write;
    const originalEnd = res.end.bind(res);
    res.end = ((chunk?: unknown, ...args: unknown[]) => {
      observeResponseChunk(chunk);
      return (originalEnd as (...endArgs: unknown[]) => unknown)(chunk, ...args);
    }) as typeof res.end;
    const requestedMethod = boundedDiagnostic(req.body?.method) ?? boundedDiagnostic(req.headers["mcp-method"]);
    const requestedName = boundedDiagnostic(req.body?.params?.name) ?? boundedDiagnostic(req.headers["mcp-name"]);
    try {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        res.status(405).json({ error: "Method not allowed" });
        return;
      }
      const authorization = String(req.headers.authorization ?? "");
      const authenticated = classifyAuthorization(authorization);
      if (!authenticated) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="ragnarok"');
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      auditPrincipal = authenticated.principal;
      auditRole = authenticated.role;
      const authInfo: AuthInfo = {
        token: authorization.slice("Bearer ".length),
        clientId: authenticated.principal,
        scopes: [authenticated.role],
        extra: { role: authenticated.role },
      };
      (req as typeof req & { auth: AuthInfo }).auth = authInfo;
      const mcpAuditState = { toolFailed: false };
      await mcpAuditContext.run(mcpAuditState, () => nodeHandler(req, res, req.body));
      responseReportedFailure ||= mcpAuditState.toolFailed;
      auditOutcome =
        res.statusCode >= 400 || responseReportedFailure || serializedMcpResponseFailed(responsePreview)
          ? "failed"
          : "success";
    } catch (error) {
      logger.error("Failed to handle MCP request", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      let auditWritten = false;
      const writeAudit = (): void => {
        if (auditWritten) {
          return;
        }
        auditWritten = true;
        const observedOutcome =
          res.statusCode >= 400 || responseReportedFailure || serializedMcpResponseFailed(responsePreview)
            ? "failed"
            : auditOutcome;
        logger.info("audit", {
          principal: auditPrincipal,
          role: auditRole,
          method: requestedMethod ?? "unknown",
          name: requestedName,
          outcome: observedOutcome,
          correlationId,
        });
      };
      if (res.writableFinished) {
        writeAudit();
      } else {
        res.once("finish", writeAudit);
        res.once("close", writeAudit);
      }
      activeRequests--;
      notifyDrained();
    }
  });
  app.use((error: any, _req: any, res: any, _next: any) => {
    if (error?.type === "entity.too.large" || error?.status === 413) {
      res.status(413).json({ error: { code: "REQUEST_TOO_LARGE", message: "Request exceeds configured limit" } });
      return;
    }
    res.status(400).json({ error: { code: "INVALID_REQUEST_BODY", message: "Invalid request body" } });
  });

  // Start HTTP server
  const httpServer =
    config.tlsCertPath && config.tlsKeyPath
      ? createHttpsServer(
          {
            cert: fs.readFileSync(config.tlsCertPath),
            key: fs.readFileSync(config.tlsKeyPath),
            minVersion: "TLSv1.2",
          },
          app,
        )
      : createServer(app);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    httpServer.once("error", onError);
    httpServer.listen(config.port, config.httpHost, () => {
      httpServer.off("error", onError);
      const protocol = config.tlsCertPath ? "https" : "http";
      logger.info(`RAGnarōk MCP server running at ${protocol}://${config.httpHost}:${config.port}`);
      logger.info(`  MCP endpoint: ${protocol}://${config.httpHost}:${config.port}/mcp`);
      logger.info(`  Health check: ${protocol}://${config.httpHost}:${config.port}/health`);
      if (tokens.reader || tokens.curator || tokens.admin) {
        logger.info("  API key authentication: enabled");
      } else {
        logger.warn("  API key authentication: disabled (set RAGNAROK_API_KEY to enable)");
      }
      resolve();
    });
  });

  let shutdownStarted = false;
  const closeAdmission = (): void => {
    accepting = false;
  };
  const waitForDrain = async (): Promise<void> => {
    if (activeRequests === 0) {
      return;
    }
    await new Promise<void>((resolve) => drainWaiters.push(resolve));
  };
  const rotateTokens = async (
    next: { reader?: string; curator?: string; admin?: string },
    role?: AccessRole,
  ): Promise<void> => {
    tokens = { ...tokens, ...next };
    logger.info("audit", {
      principal: "local-operator",
      action: "token.rotate",
      object: role ?? "all",
      outcome: "success",
      correlationId: randomUUID(),
    });
  };
  const shutdown = async (absoluteDeadline?: number): Promise<void> => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    closeAdmission();
    logger.info("Shutting down HTTP transport");

    const serverClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
    const deadline = Number.isFinite(absoluteDeadline)
      ? absoluteDeadline!
      : Date.now() + (config.shutdownDrainMs ?? 10_000);
    const drainDeadline = new Promise<void>((resolve) =>
      setTimeout(resolve, Math.max(0, deadline - Date.now())).unref(),
    );
    await Promise.race([waitForDrain(), drainDeadline]);
    await mcpHandler.close();
    httpServer.closeAllConnections?.();
    await serverClosed;
  };

  return { httpServer, closeAdmission, rotateTokens, shutdown };
}
