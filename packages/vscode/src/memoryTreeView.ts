/**
 * The Memory section of the RAGnarōk sidebar.
 *
 * This is the user-facing half of the ragResetMemory removal: an irreversible
 * memory wipe is no longer something a model may call, so a human triggers it
 * here behind a modal confirmation. The view also hosts refresh and the
 * existing memory-graph command.
 *
 * Counts can go stale after Copilot stores or forgets a memory through the
 * ragMemory tool. Refresh is the recovery, and reset refreshes on completion;
 * the tool handler is deliberately not coupled to this view for a count that is
 * not decision-critical.
 */
import * as vscode from "vscode";
import {
  Logger,
  sanitizeErrorMessage,
  type MemoryHostContext,
  type MemoryService,
  type MemoryStatsResult,
} from "@ragnarok/core";
import { COMMANDS, VIEWS } from "./constants";
import type { ExtensionOperationRunner } from "./extensionLifecycle";
import { resolveMemoryHostContext } from "./memoryHostContext";

const logger = new Logger("MemorySidebar");

/** Confirmation label; compared by strict equality, never by truthiness. */
const RESET_CONFIRMATION = "Reset Memory";

const RESET_PROMPT =
  "Reset RAGnarōk memory? This permanently deletes every stored memory, entity, and relationship for this extension. This action cannot be undone.";

export interface MemoryTreeContextHost {
  resolve(): MemoryHostContext | Promise<MemoryHostContext>;
}

/**
 * Message and command surfaces are injected: unit tests run inside the real
 * extension host, where `vscode` resolves to the live API, so a modal confirm
 * called directly would be unanswerable and unobservable.
 */
export interface MemoryCommandHost {
  registerCommand(command: string, callback: () => Promise<void> | void): vscode.Disposable;
  showWarningMessage(message: string, options: { modal: boolean }, action: string): Promise<string | undefined>;
  showInformationMessage(message: string): PromiseLike<unknown>;
  showErrorMessage(message: string): PromiseLike<unknown>;
}

export interface MemorySidebarHost extends MemoryCommandHost {
  createTreeView(
    viewId: string,
    options: { treeDataProvider: MemoryTreeDataProvider; showCollapseAll: boolean },
  ): vscode.Disposable;
  resolveContext(): Promise<MemoryHostContext>;
}

const vscodeMemorySidebarHost: MemorySidebarHost = {
  createTreeView: (viewId, options) => vscode.window.createTreeView(viewId, options),
  // Same resolution the ragMemory tool uses, so the tree counts the memories the
  // tool would read: active editor's folder, else the single workspace folder.
  resolveContext: () => resolveMemoryHostContext({ action: "stats" }),
  registerCommand: (command, callback) => vscode.commands.registerCommand(command, callback),
  showWarningMessage: (message, options, action) =>
    Promise.resolve(vscode.window.showWarningMessage(message, options, action)),
  showInformationMessage: (message) => vscode.window.showInformationMessage(message),
  showErrorMessage: (message) => vscode.window.showErrorMessage(message),
};

export class MemoryTreeItem extends vscode.TreeItem {
  constructor(label: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = "memory-stat";
  }
}

export class MemoryTreeDataProvider implements vscode.TreeDataProvider<MemoryTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly memoryService: Pick<MemoryService, "execute">,
    private readonly contextHost: MemoryTreeContextHost,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element: MemoryTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: MemoryTreeItem): Promise<MemoryTreeItem[]> {
    if (element) {
      return [];
    }
    let stats: MemoryStatsResult;
    try {
      const context = await this.contextHost.resolve();
      stats = await this.memoryService.execute({ action: "stats" }, context);
    } catch (error) {
      // A row rather than VS Code's generic tree-error state: the message is
      // actionable, the sidebar keeps its refresh button, and the error is
      // sanitized because tree labels are as visible as a notification.
      logger.error("Failed to read memory statistics", error);
      return [new MemoryTreeItem(`Memory statistics unavailable: ${sanitizeErrorMessage(error)}`, "warning")];
    }

    // No rows at all for a store that holds nothing, so VS Code renders the
    // ragMemory viewsWelcome content instead. Entities are counted too: a graph
    // can hold entities the memory count does not cover, and eight zero rows
    // would be a worse answer than the welcome text.
    if (stats.totalMemories === 0 && stats.totalEntities === 0) {
      return [];
    }

    return [
      new MemoryTreeItem(`Memories: ${stats.totalMemories}`, "archive"),
      new MemoryTreeItem(`Workspace: ${stats.byScope.workspace}`, "folder"),
      new MemoryTreeItem(`Branch: ${stats.byScope.branch}`, "git-branch"),
      new MemoryTreeItem(`Current branch: ${stats.workspace.detectedBranch ?? "not detected"}`, "source-control"),
      new MemoryTreeItem(`Branches: ${stats.branches.length}`, "list-tree"),
      new MemoryTreeItem(`Entities: ${stats.totalEntities}`, "symbol-class"),
      new MemoryTreeItem(`Relationships: ${stats.totalRelationships}`, "references"),
      // A store that has never been written keeps lastUpdated at 0
      // (memoryStore.ts:438), which as a date reads "1/1/1970".
      new MemoryTreeItem(
        `Updated: ${stats.lastUpdated === 0 ? "never" : new Date(stats.lastUpdated).toLocaleString()}`,
        "clock",
      ),
    ];
  }
}

/**
 * Reset is the destructive path that replaced the ragResetMemory tool. It uses
 * the modal-confirm shape from deleteTopic (commands.ts:363-375): a modal
 * warning, one verb-labelled action, and a strict equality check on the answer.
 */
export function registerMemoryCommands(
  memoryService: Pick<MemoryService, "reset">,
  provider: MemoryTreeDataProvider,
  run: ExtensionOperationRunner,
  host: MemoryCommandHost = vscodeMemorySidebarHost,
): vscode.Disposable {
  const reset = host.registerCommand(COMMANDS.RESET_MEMORY, async () => {
    const confirmation = await host.showWarningMessage(RESET_PROMPT, { modal: true }, RESET_CONFIRMATION);
    if (confirmation !== RESET_CONFIRMATION) {
      return;
    }
    try {
      logger.info("Resetting memory after user confirmation");
      await run("reset memory", (signal) => memoryService.reset(signal));
      provider.refresh();
      logger.info("Memory reset successfully");
      void host.showInformationMessage("RAGnarōk memory reset.");
    } catch (error) {
      logger.error("Failed to reset memory", error);
      void host.showErrorMessage(`Failed to reset memory: ${sanitizeErrorMessage(error)}`);
    }
  });

  const refresh = host.registerCommand(COMMANDS.REFRESH_MEMORY, () => provider.refresh());
  return vscode.Disposable.from(reset, refresh);
}

/**
 * Builds the whole Memory section — provider, view, and commands — as one
 * disposable so activation registers it in a single step and rollback tears it
 * down in a single step.
 */
export function registerMemorySidebar(
  memoryService: Pick<MemoryService, "execute" | "reset">,
  run: ExtensionOperationRunner,
  host: MemorySidebarHost = vscodeMemorySidebarHost,
): vscode.Disposable {
  const provider = new MemoryTreeDataProvider(memoryService, { resolve: () => host.resolveContext() });
  const view = host.createTreeView(VIEWS.RAG_MEMORY, {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  const commands = registerMemoryCommands(memoryService, provider, run, host);
  return vscode.Disposable.from(view, commands, provider);
}
