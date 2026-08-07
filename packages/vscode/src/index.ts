/**
 * @ragnarok/vscode barrel export
 *
 * Re-exports VS Code-specific classes for test consumers.
 * The extension host uses extension.ts directly via the "main" field in root package.json.
 */

export { RAGTool } from "./ragTool";
export { VscodeLmBackend } from "./vscodeLmBackend";
export { WorkspaceContextProvider } from "./workspaceContext";
export { VSCODE_CONFIG } from "./constants";
export {
  ExtensionLifecycle,
  ExtensionShutdownError,
  ExtensionStoppingError,
  type ExtensionOperationRunner,
} from "./extensionLifecycle";
export { createDefaultMigrationUx, openTopicManagerWithMigration, type MigrationUxDependencies } from "./migrationUx";
export { TopicTreeDataProvider, TopicTreeItem, ConfigTreeDataProvider } from "./topicTreeView";
export { activateWithServiceFactory, type ActivationServiceFactory, type RagnarokExtensionApi } from "./extension";
