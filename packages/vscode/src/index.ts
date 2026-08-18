/**
 * @ragnarok/vscode barrel export
 *
 * Re-exports VS Code-specific classes for test consumers.
 * The extension host uses extension.ts directly via the "main" field in root package.json.
 */

export { RAGTool } from "./ragTool";
export { TopicTool, type TopicToolPayload } from "./topicTool";
export { vscodeToolRegistrationHost, type LanguageModelToolRegistrationHost } from "./toolRegistrationHost";
export { VscodeLmBackend } from "./vscodeLmBackend";
export { WorkspaceContextProvider } from "./workspaceContext";
export { COMMANDS, TOOLS, VSCODE_CONFIG } from "./constants";
export { resolveMemoryHostContext, type MemoryHostContextHost } from "./memoryHostContext";
export { registerMemoryTools, type RegisterMemoryToolsOptions } from "./memoryTools";
export {
  registerMemoryGraphCommand,
  type MemoryGraphCommandHost,
  type MemoryGraphWorkspaceFolder,
} from "./memoryGraphCommand";
export { MemoryGraphPanel, type MemoryGraphPanelFactory } from "./memoryGraphPanel";
export {
  ExtensionLifecycle,
  ExtensionShutdownError,
  ExtensionStoppingError,
  type ExtensionOperationRunner,
} from "./extensionLifecycle";
export { createDefaultMigrationUx, openTopicManagerWithMigration, type MigrationUxDependencies } from "./migrationUx";
export { TopicTreeDataProvider, TopicTreeItem, ConfigTreeDataProvider } from "./topicTreeView";
export {
  activateWithServiceFactory,
  createMemoryServices,
  type ActivationRuntimeFactory,
  type ActivationServiceFactory,
  type RagnarokExtensionApi,
} from "./extension";
