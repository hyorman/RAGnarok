/**
 * HTTP transport for RAGnarōk MCP Server
 *
 * Uses the MCP SDK's StreamableHTTPServerTransport with Express
 * to serve MCP tools over HTTP/SSE. Supports:
 * - Optional API key authentication
 * - CORS
 * - Rate limiting
 * - Health endpoint
 * - Graceful shutdown
 */

import { randomUUID, timingSafeEqual } from "crypto";
import { createServer, Server } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Logger } from "@ragnarok/core";
import { McpConfig } from "./config";

/**
 * Start the MCP server with HTTP transport.
 *
 * @param server - Configured McpServer instance with tools registered
 * @param config - MCP server configuration
 * @returns Promise that resolves when the server is listening
 */
export async function startHttpTransport(server: McpServer, config: McpConfig): Promise<Server> {
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

  // Read version from package.json at startup
  let serverVersion = "unknown";
  try {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const pkgPath = resolve(__dirname, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    serverVersion = pkg.version;
  } catch {
    // Fallback if package.json is not resolvable
  }

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

  // Create streaming HTTP transport (stateful — supports multi-turn sessions)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  // Connect MCP server to the transport
  await server.connect(transport);
  logger.info("MCP server connected to HTTP transport");

  // Mount the MCP endpoint
  app.all("/mcp", authMiddleware, (req, res) => {
    transport.handleRequest(req, res, req.body);
  });

  // Start HTTP server
  const httpServer = createServer(app);

  return new Promise<Server>((resolve) => {
    httpServer.listen(config.port, config.httpHost, () => {
      logger.info(`RAGnarōk MCP server running at http://${config.httpHost}:${config.port}`);
      logger.info(`  MCP endpoint: http://${config.httpHost}:${config.port}/mcp`);
      logger.info(`  Health check: http://${config.httpHost}:${config.port}/health`);
      if (config.apiKey) {
        logger.info("  API key authentication: enabled");
      } else {
        logger.warn("  API key authentication: disabled (set RAGNAROK_API_KEY to enable)");
      }
      resolve(httpServer);
    });
  });
}
