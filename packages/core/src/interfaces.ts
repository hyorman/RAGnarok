/**
 * Portable interfaces for RAGnarōk core
 * These abstract away VS Code-specific APIs so the core can run anywhere
 */

/**
 * Configuration provider - replaces vscode.workspace.getConfiguration()
 */
export interface IConfigProvider {
  get<T>(key: string, defaultValue: T): T;
}

/**
 * Log levels matching the existing Logger enum
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/**
 * Logger interface - replaces vscode.window.createOutputChannel()
 */
export interface ILogger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, error?: Error | unknown): void;
}

/**
 * Factory for creating loggers with context
 */
export interface ILoggerFactory {
  createLogger(context: string): ILogger;
}

/**
 * UI notification provider - replaces vscode.window.show*Message() + withProgress()
 */
export interface INotifier {
  showInfo(message: string): void;
  showWarning(message: string): void;
  showError(message: string): void;
  withProgress<T>(title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T>;
}

/**
 * LLM message format - replaces vscode.LanguageModelChatMessage
 */
export interface ILLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * LLM model interface - replaces vscode.LanguageModelChat
 */
export interface ILLMModel {
  id: string;
  family: string;
  sendRequest(messages: ILLMMessage[], signal?: AbortSignal): Promise<AsyncIterable<string>>;
}

/**
 * LLM provider interface - replaces vscode.lm.selectChatModels()
 */
export interface ILLMProvider {
  selectModel(options?: { family?: string; vendor?: string }): Promise<ILLMModel | null>;
  isAvailable(): Promise<boolean>;
}
