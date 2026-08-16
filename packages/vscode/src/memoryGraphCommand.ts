import * as vscode from "vscode";
import { GitBranchDetector, type GraphVisualizationRequest, type GraphVisualizationService } from "@ragnarok/core";
import { COMMANDS } from "./constants";
import type { ExtensionOperationRunner } from "./extensionLifecycle";
import type { MemoryGraphPanel } from "./memoryGraphPanel";

export interface MemoryGraphWorkspaceFolder {
  readonly name: string;
  readonly uri: { readonly fsPath: string };
}

interface MemoryGraphScopeItem extends vscode.QuickPickItem {
  readonly request: GraphVisualizationRequest | "branch";
}

export interface MemoryGraphCommandHost {
  readonly workspaceFolders: readonly MemoryGraphWorkspaceFolder[] | undefined;
  registerCommand(command: string, callback: () => Promise<void>): vscode.Disposable;
  showWorkspaceFolderPick(): Promise<MemoryGraphWorkspaceFolder | undefined>;
  showScopeQuickPick(items: readonly MemoryGraphScopeItem[]): Promise<MemoryGraphScopeItem | undefined>;
  showErrorMessage(message: string): PromiseLike<unknown>;
  getCurrentBranch(workingDir: string): Promise<string | null>;
}

const vscodeMemoryGraphCommandHost: MemoryGraphCommandHost = {
  get workspaceFolders() {
    return vscode.workspace.workspaceFolders;
  },
  registerCommand: (command, callback) => vscode.commands.registerCommand(command, callback),
  showWorkspaceFolderPick: () =>
    Promise.resolve(vscode.window.showWorkspaceFolderPick({ placeHolder: "Select a workspace folder" })),
  showScopeQuickPick: (items) =>
    Promise.resolve(vscode.window.showQuickPick(items, { placeHolder: "Select the memory graph scope" })),
  showErrorMessage: (message) => vscode.window.showErrorMessage(message),
  getCurrentBranch: (workingDir) => new GitBranchDetector(workingDir).getCurrentBranch(),
};

export function registerMemoryGraphCommand(
  graphService: Pick<GraphVisualizationService, "generate">,
  panel: Pick<MemoryGraphPanel, "show">,
  operationRunner: ExtensionOperationRunner,
  host: MemoryGraphCommandHost = vscodeMemoryGraphCommandHost,
): vscode.Disposable {
  let latestGeneration = 0;
  return host.registerCommand(COMMANDS.SHOW_MEMORY_GRAPH, async () => {
    const generation = ++latestGeneration;
    try {
      const folders = host.workspaceFolders ?? [];
      let selectedFolder: MemoryGraphWorkspaceFolder | undefined;
      if (folders.length > 1) {
        selectedFolder = await host.showWorkspaceFolderPick();
        if (!selectedFolder) {
          return;
        }
      } else {
        selectedFolder = folders[0];
      }

      const branch = selectedFolder ? await host.getCurrentBranch(selectedFolder.uri.fsPath) : null;
      const scope = await host.showScopeQuickPick([
        { label: "Workspace", description: "All workspace memories", request: { scope: "workspace" } },
        {
          label: branch ? `Current branch (${branch})` : "Current branch",
          description: branch ? "Memories for the selected Git branch" : "No current Git branch detected",
          request: "branch",
        },
      ]);
      if (!scope) {
        return;
      }

      let request: GraphVisualizationRequest;
      if (scope.request === "branch") {
        if (!branch) {
          if (generation === latestGeneration) {
            await host.showErrorMessage("RAGnarok could not detect a current Git branch for the selected folder.");
          }
          return;
        }
        request = { scope: "branch", branch };
      } else {
        request = scope.request;
      }

      await operationRunner("show memory graph", async (signal) => {
        const document = await graphService.generate(request, signal);
        signal.throwIfAborted();
        if (generation === latestGeneration) {
          await panel.show(document);
        }
      });
    } catch (error) {
      if (generation === latestGeneration) {
        throw error;
      }
    }
  });
}
