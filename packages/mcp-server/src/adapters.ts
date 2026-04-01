/**
 * Adapter implementations for MCP server runtime
 * Maps @ragnarok/core interfaces to console/environment-based implementations
 */

import { IConfigProvider, ILogger, ILoggerFactory, INotifier, CONFIG } from "@ragnarok/core";
import { McpConfig } from "./config";

/**
 * Config provider backed by environment variables / McpConfig
 */
export class EnvConfigProvider implements IConfigProvider {
  constructor(private mcpConfig: McpConfig) {}

  get<T>(key: string, defaultValue: T): T {
    const mapping: Record<string, unknown> = {
      [CONFIG.TOP_K]: this.mcpConfig.topK,
      [CONFIG.CHUNK_SIZE]: this.mcpConfig.chunkSize,
      [CONFIG.CHUNK_OVERLAP]: this.mcpConfig.chunkOverlap,
      [CONFIG.RETRIEVAL_STRATEGY]: this.mcpConfig.retrievalStrategy,
      [CONFIG.MAX_ITERATIONS]: this.mcpConfig.maxIterations,
      [CONFIG.CONFIDENCE_THRESHOLD]: this.mcpConfig.confidenceThreshold,
      [CONFIG.LOG_LEVEL]: this.mcpConfig.logLevel,
      [CONFIG.EMBEDDING_BACKEND]: this.mcpConfig.embeddingProvider !== "huggingface" ? "remote" : "huggingface",
      [CONFIG.LOCAL_MODEL_PATH]: "",
      [CONFIG.EMBEDDING_VSCODE_MODEL_ID]: "",
      [CONFIG.LLM_MODEL]: this.mcpConfig.llmModel,
      [CONFIG.INCLUDE_WORKSPACE]: false,
      [CONFIG.GAP_SCORE_THRESHOLD]: 0.3,
      [CONFIG.COMMON_DATABASE_PATH]: "",
    };

    if (key in mapping) {
      return mapping[key] as T;
    }
    return defaultValue;
  }
}

/**
 * Console-based logger for MCP server
 */
class ConsoleLogger implements ILogger {
  constructor(private context: string) {}

  debug(message: string, ...args: any[]): void {
    console.debug(`[DEBUG] [${this.context}] ${message}`, ...args);
  }

  info(message: string, ...args: any[]): void {
    console.log(`[INFO] [${this.context}] ${message}`, ...args);
  }

  warn(message: string, ...args: any[]): void {
    console.warn(`[WARN] [${this.context}] ${message}`, ...args);
  }

  error(message: string, error?: Error | unknown): void {
    console.error(`[ERROR] [${this.context}] ${message}`, error ?? "");
  }
}

export class ConsoleLoggerFactory implements ILoggerFactory {
  createLogger(context: string): ILogger {
    return new ConsoleLogger(context);
  }
}

/**
 * Console-based notifier for MCP server
 */
export class ConsoleNotifier implements INotifier {
  showInfo(message: string): void {
    console.log(`[INFO] ${message}`);
  }

  showWarning(message: string): void {
    console.warn(`[WARN] ${message}`);
  }

  showError(message: string): void {
    console.error(`[ERROR] ${message}`);
  }

  async withProgress<T>(title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> {
    console.log(`[PROGRESS] ${title}`);
    return task((message) => {
      console.log(`[PROGRESS] ${title}: ${message}`);
    });
  }
}

