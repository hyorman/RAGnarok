import * as vscode from "vscode";
import { GitBranchDetector, type MemoryHostContext, type MemoryOperationInput } from "@ragnarok/core";

interface MemoryWorkspaceFolder {
  readonly uri: { readonly fsPath: string };
}

export interface MemoryHostContextHost {
  readonly workspaceFolders: readonly MemoryWorkspaceFolder[] | undefined;
  readonly activeDocumentUri?: { readonly fsPath: string };
  getWorkspaceFolder(uri: { readonly fsPath: string }): MemoryWorkspaceFolder | undefined;
  getCurrentBranch(workingDir: string): Promise<string | null>;
}

const vscodeMemoryHostContextHost: MemoryHostContextHost = {
  get workspaceFolders() {
    return vscode.workspace.workspaceFolders;
  },
  get activeDocumentUri() {
    return vscode.window.activeTextEditor?.document.uri;
  },
  getWorkspaceFolder: (uri) => vscode.workspace.getWorkspaceFolder(uri as vscode.Uri),
  getCurrentBranch: (workingDir) => new GitBranchDetector(workingDir).getCurrentBranch(),
};

export async function resolveMemoryHostContext(
  input: MemoryOperationInput,
  host: MemoryHostContextHost = vscodeMemoryHostContextHost,
): Promise<MemoryHostContext> {
  const explicitBranch = "branch" in input ? input.branch : undefined;
  if (explicitBranch) {
    return {
      workingDir: "",
      branchContext: { state: "resolved", branch: explicitBranch },
    };
  }

  const activeFolder = host.activeDocumentUri ? host.getWorkspaceFolder(host.activeDocumentUri) : undefined;
  const folders = host.workspaceFolders ?? [];
  const folder = activeFolder ?? (folders.length === 1 ? folders[0] : undefined);

  if (!folder) {
    return {
      workingDir: "",
      branchContext: { state: folders.length > 1 ? "ambiguous" : "unavailable" },
    };
  }

  const workingDir = folder.uri.fsPath;
  const branch = await host.getCurrentBranch(workingDir);
  return {
    workingDir,
    branchContext: branch ? { state: "resolved", branch } : { state: "unavailable" },
  };
}
