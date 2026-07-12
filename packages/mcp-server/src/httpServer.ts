/**
 * HTTP transport for RAGnarōk MCP Server
 *
 * Uses the MCP SDK's StreamableHTTPServerTransport with Express
 * to serve MCP tools over HTTP/SSE. Supports:
 * - Optional API key authentication
 * - CORS
 * - Rate limiting
 * - Health endpoint
 * - Multiple concurrent client sessions
 * - Graceful shutdown
 */

import { randomUUID, timingSafeEqual } from "crypto";
import { createServer, Server } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { Logger } from "@ragnarok/core";
import { McpConfig, getServerVersion } from "./config";

export interface HttpTransportHandle {
  httpServer: Server;
  /** Close all client sessions and stop accepting connections. Idempotent. */
  shutdown(): Promise<void>;
}

/**
 * Start the MCP server with HTTP transport.
 *
 * A stateful StreamableHTTPServerTransport manages exactly ONE session, and
 * an McpServer instance binds to exactly one transport — so each client
 * session gets its own server+transport pair (created via `createMcpServer`),
 * keyed by the SDK-issued mcp-session-id. Tool handlers share the underlying
 * services, which are singletons owned by the caller.
 *
 * @param createMcpServer - Factory producing a fully tool-registered McpServer
 * @param config - MCP server configuration
 * @returns Handle with the listening http.Server and a shutdown function
 */
export async function startHttpTransport(
  createMcpServer: (role: "reader" | "writer") => McpServer,
  config: McpConfig,
): Promise<HttpTransportHandle> {
  const logger = new Logger("HTTP-Transport");

  // Create Express app with MCP SDK's built-in middleware
  const app = createMcpExpressApp({ host: config.httpHost });

  app.use(
    rateLimit({
      windowMs: 60_000,
      max: config.rateLimitPerMinute,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  logger.debug(`Rate limiting enabled (${config.rateLimitPerMinute} req/min)`);

  app.use(cors({ origin: config.corsOrigin }));
  logger.debug(`CORS enabled (origin: ${config.corsOrigin})`);

  const serverVersion = getServerVersion();

  // Health endpoint
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      version: serverVersion,
      uptime: process.uptime(),
    });
  });
  app.get("/ready", (_req, res) => res.json({ status: "ready", version: serverVersion }));

  type Session = {
    transport: StreamableHTTPServerTransport;
    server: McpServer;
    role: "reader" | "writer";
    authorization: string;
    lastSeen: number;
  };
  const sessions = new Map<string, Session>();

  const secureEquals = (actual: string, expected: string): boolean => {
    const a = Buffer.from(actual);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const classifyAuthorization = (authorization: string): "reader" | "writer" | null => {
    if (!config.apiKey && !config.writeApiKey) {
      return "writer";
    }
    if (config.writeApiKey && secureEquals(authorization, `Bearer ${config.writeApiKey}`)) {
      return "writer";
    }
    if (config.apiKey && secureEquals(authorization, `Bearer ${config.apiKey}`)) {
      return "reader";
    }
    return null;
  };

  app.all("/mcp", async (req, res) => {
    try {
      const authorization = String(req.headers.authorization || "");
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let session = sessionId ? sessions.get(sessionId) : undefined;

      if (session && !secureEquals(authorization, session.authorization)) {
        res.status(401).json({ error: "Session token role mismatch" });
        return;
      }

      if (!session) {
        // Authenticate before parsing/validating the request shape so
        // unauthorized callers cannot use response differences as an oracle.
        const role = classifyAuthorization(authorization);
        if (!role) {
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
        // Only an initialize request may open a new session.
        if (req.method !== "POST" || !isInitializeRequest(req.body)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: no valid session ID provided" },
            id: null,
          });
          return;
        }
        if (sessions.size >= config.maxSessions) {
          res.status(503).json({ error: "Maximum MCP session count reached" });
          return;
        }
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, {
              transport: newTransport,
              server: mcpServer,
              role,
              authorization,
              lastSeen: Date.now(),
            });
            logger.debug(`Session initialized: ${sid}`);
          },
        });
        // DELETE /mcp (session termination) and transport errors both end
        // here — drop the session so its resources can be collected.
        newTransport.onclose = () => {
          if (newTransport.sessionId) {
            sessions.delete(newTransport.sessionId);
            logger.debug(`Session closed: ${newTransport.sessionId}`);
          }
        };

        const mcpServer = createMcpServer(role);
        await mcpServer.connect(newTransport);
        session = { transport: newTransport, server: mcpServer, role, authorization, lastSeen: Date.now() };
      }

      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("Failed to handle MCP request", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Start HTTP server
  const httpServer = createServer(app);
  const expiryTimer = setInterval(
    () => {
      const cutoff = Date.now() - config.sessionIdleTtlMs;
      for (const [sid, session] of sessions) {
        if (session.lastSeen < cutoff) {
          sessions.delete(sid);
          void (async () => {
            await session.transport.close();
            await session.server.close();
          })().catch((error) => logger.debug(`Error expiring session ${sid}`, error));
        }
      }
    },
    Math.min(config.sessionIdleTtlMs, 60_000),
  );
  expiryTimer.unref();

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    httpServer.once("error", onError);
    httpServer.listen(config.port, config.httpHost, () => {
      httpServer.off("error", onError);
      logger.info(`RAGnarōk MCP server running at http://${config.httpHost}:${config.port}`);
      logger.info(`  MCP endpoint: http://${config.httpHost}:${config.port}/mcp`);
      logger.info(`  Health check: http://${config.httpHost}:${config.port}/health`);
      if (config.apiKey) {
        logger.info("  API key authentication: enabled");
      } else {
        logger.warn("  API key authentication: disabled (set RAGNAROK_API_KEY to enable)");
      }
      resolve();
    });
  });

  let shutdownStarted = false;
  const shutdown = async (): Promise<void> => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    logger.info(`Shutting down HTTP transport (${sessions.size} active session(s))`);

    clearInterval(expiryTimer);
    const serverClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
    httpServer.closeAllConnections?.();
    for (const [sid, session] of [...sessions]) {
      try {
        await session.transport.close();
        await session.server.close();
      } catch (error) {
        logger.debug(`Error closing session ${sid}`, error);
      }
    }
    sessions.clear();
    await serverClosed;
  };

  return { httpServer, shutdown };
}
