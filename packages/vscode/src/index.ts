/**
 * @ragnarok/vscode barrel export
 *
 * Re-exports VS Code-specific classes for test consumers.
 * The extension host uses extension.ts directly via the "main" field in root package.json.
 */

export { RAGTool } from "./ragTool";
export { VscodeLmBackend } from "./vscodeLmBackend";
export { WorkspaceContextProvider } from "./workspaceContext";
