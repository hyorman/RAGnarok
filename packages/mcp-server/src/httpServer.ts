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
  createMcpServer: () => McpServer,
  config: McpConfig,
): Promise<HttpTransportHandle> {
  const logger = new Logger("HTTP-Transport");

  // Create Express app with MCP SDK's built-in middleware
  const app = createMcpExpressApp({ host: config.httpHost });

  // Rate limiting — dynamic import since it's a transitive dep of the SDK
  try {
    const { default: rateLimit } = await import("express-rate-limit");
    app.use(
      rateLimit({
        windowMs: 60_000,
        max: 100,
        standardHeaders: true,
        legacyHeaders: false,
      }),
    );
    logger.debug("Rate limiting enabled (100 req/min)");
  } catch {
    logger.warn("express-rate-limit not available — skipping rate limiting");
  }

  // CORS
  try {
    const { default: cors } = await import("cors");
    app.use(cors({ origin: config.corsOrigin }));
    logger.debug(`CORS enabled (origin: ${config.corsOrigin})`);
  } catch {
    logger.warn("cors not available — skipping CORS middleware");
  }

  const serverVersion = getServerVersion();

  // Health endpoint
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      version: serverVersion,
      uptime: process.uptime(),
    });
  });

  // Optional API key authentication middleware
  const expectedToken = `Bearer ${config.apiKey}`;
  const authMiddleware = config.apiKey
    ? (req: any, res: any, next: any) => {
        const auth = req.headers.authorization || "";
        const authBuf = Buffer.from(auth);
        const expectedBuf = Buffer.from(expectedToken);
        if (authBuf.length !== expectedBuf.length || !timingSafeEqual(authBuf, expectedBuf)) {
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
        next();
      }
    : (_req: any, _res: any, next: any) => next();

  // Active sessions: mcp-session-id → transport (each with its own McpServer)
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  app.all("/mcp", authMiddleware, async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? sessions.get(sessionId) : undefined;

      if (!transport) {
        // Only an initialize request may open a new session.
        if (req.method !== "POST" || !isInitializeRequest(req.body)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: no valid session ID provided" },
            id: null,
          });
          return;
        }

        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, newTransport);
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

        await createMcpServer().connect(newTransport);
        transport = newTransport;
      }

      await transport.handleRequest(req, res, req.body);
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

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.httpHost, () => {
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

    for (const [sid, transport] of [...sessions]) {
      try {
        await transport.close();
      } catch (error) {
        logger.debug(`Error closing session ${sid}`, error);
      }
    }
    sessions.clear();

    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      // Don't wait forever on lingering keep-alive connections.
      httpServer.closeAllConnections?.();
    });
  };

  return { httpServer, shutdown };
}
