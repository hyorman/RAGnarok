/**
 * Workspace Context Provider
 * Captures relevant workspace context (selected code, open files, etc.) for LLM
 */

import * as vscode from "vscode";

export interface WorkspaceContext {
  // Selected code in editor
  selectedCode?: {
    code: string;
    fileName: string;
    language: string;
    lineRange: string;
  };

  // Active file context
  activeFile?: {
    fileName: string;
    language: string;
    imports?: string[];
    symbols?: string[]; // Functions, classes, etc.
  };

  // Workspace metadata
  workspace?: {
    name: string;
    rootPath: string;
    languagesUsed: string[];
  };

  // Related files (e.g., files mentioned in RAG results)
  relatedFiles?: Array<{
    path: string;
    excerpt?: string;
  }>;
}

export class WorkspaceContextProvider {
  /**
   * Get comprehensive workspace context
   */
  public static async getContext(options?: {
    includeSelection?: boolean;
    includeActiveFile?: boolean;
    includeWorkspace?: boolean;
    maxCodeLength?: number;
  }): Promise<WorkspaceContext> {
    const opts = {
      includeSelection: true,
      includeActiveFile: true,
      includeWorkspace: true,
      maxCodeLength: 1000,
      ...options,
    };

    const context: WorkspaceContext = {};

    // Get selected code
    if (opts.includeSelection) {
      const selection = this.getSelectedCode(opts.maxCodeLength);
      if (selection) {
        context.selectedCode = selection;
      }
    }

    // Get active file context
    if (opts.includeActiveFile) {
      const activeFile = await this.getActiveFileContext();
      if (activeFile) {
        context.activeFile = activeFile;
      }
    }

    // Get workspace metadata
    if (opts.includeWorkspace) {
      const workspace = this.getWorkspaceMetadata();
      if (workspace) {
        context.workspace = workspace;
      }
    }

    return context;
  }

  /**
   * Get selected code from active editor
   */
  private static getSelectedCode(maxLength: number): WorkspaceContext["selectedCode"] | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      return null;
    }

    const document = editor.document;
    const selection = editor.selection;
    let selectedText = document.getText(selection);

    // Truncate if too long
    if (selectedText.length > maxLength) {
      selectedText = selectedText.substring(0, maxLength) + "\n... (truncated)";
    }

    return {
      code: selectedText,
      fileName: this.getRelativePath(document.fileName),
      language: document.languageId,
      lineRange: `${selection.start.line + 1}-${selection.end.line + 1}`,
    };
  }

  /**
   * Get context from the active file
   */
  private static async getActiveFileContext(): Promise<WorkspaceContext["activeFile"] | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return null;
    }

    const document = editor.document;
    const fileName = this.getRelativePath(document.fileName);
    const language = document.languageId;

    // Extract imports (simple regex-based)
    const imports = this.extractImports(document);

    // Get symbols (functions, classes, etc.)
    const symbols = await this.extractSymbols(document);

    return {
      fileName,
      language,
      imports,
      symbols,
    };
  }

  /**
   * Extract import statements from document
   */
  private static extractImports(document: vscode.TextDocument): string[] {
    const imports: string[] = [];
    const text = document.getText();

    // Match various import patterns
    const patterns = [
      /import\s+.*?from\s+['"](.+?)['"]/g, // ES6: import ... from '...'
      /import\s+['"](.+?)['"]/g, // import '...'
      /require\(['"](.+?)['"]\)/g, // require('...')
      /from\s+(\S+)\s+import/g, // Python: from ... import
      /using\s+(\S+);/g, // C#: using ...;
      /package\s+(\S+)/g, // Go: package ...
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (match[1] && !match[1].startsWith(".")) {
          // Exclude relative imports for brevity
          imports.push(match[1]);
        }
      }
    }

    return [...new Set(imports)].slice(0, 10); // Unique, max 10
  }

  /**
   * Extract symbols (functions, classes) from document
   */
  private static async extractSymbols(document: vscode.TextDocument): Promise<string[]> {
    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        document.uri,
      );

      if (!symbols) {
        return [];
      }

      // Get top-level symbols (functions, classes, etc.)
      return symbols
        .filter(
          (s) =>
            s.kind === vscode.SymbolKind.Function ||
            s.kind === vscode.SymbolKind.Class ||
            s.kind === vscode.SymbolKind.Method ||
            s.kind === vscode.SymbolKind.Interface,
        )
        .map((s) => s.name)
        .slice(0, 15); // Max 15 symbols
    } catch (_error) {
      // Symbol provider might not be available for all languages
      return [];
    }
  }

  /**
   * Get workspace metadata
   */
  private static getWorkspaceMetadata(): WorkspaceContext["workspace"] | null {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return null;
    }

    // Get languages used (from open editors)
    const languagesUsed = [
      ...new Set(vscode.window.visibleTextEditors.map((e) => e.document.languageId).filter((l) => l)),
    ];

    return {
      name: workspaceFolder.name,
      rootPath: workspaceFolder.uri.fsPath,
      languagesUsed,
    };
  }

  /**
   * Get relative path from workspace root
   */
  private static getRelativePath(absolutePath: string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return absolutePath;
    }

    const relative = vscode.workspace.asRelativePath(absolutePath);
    return relative;
  }

  /**
   * Format workspace context as markdown for LLM
   */
  public static formatContextForLLM(context: WorkspaceContext): string {
    const parts: string[] = [];

    // Workspace info
    if (context.workspace) {
      parts.push(`**Workspace:** ${context.workspace.name}`);
      if (context.workspace.languagesUsed.length > 0) {
        parts.push(`**Languages:** ${context.workspace.languagesUsed.join(", ")}`);
      }
    }

    // Selected code
    if (context.selectedCode) {
      parts.push(`\n**Selected Code** (${context.selectedCode.fileName}, lines ${context.selectedCode.lineRange}):`);
      parts.push("```" + context.selectedCode.language);
      parts.push(context.selectedCode.code);
      parts.push("```");
    }

    // Active file context
    if (context.activeFile && !context.selectedCode) {
      // Only show if no selection (avoid redundancy)
      parts.push(`\n**Current File:** ${context.activeFile.fileName}`);

      if (context.activeFile.imports && context.activeFile.imports.length > 0) {
        parts.push(`**Imports:** ${context.activeFile.imports.slice(0, 5).join(", ")}`);
      }

      if (context.activeFile.symbols && context.activeFile.symbols.length > 0) {
        parts.push(`**Symbols:** ${context.activeFile.symbols.slice(0, 5).join(", ")}`);
      }
    }

    // Related files
    if (context.relatedFiles && context.relatedFiles.length > 0) {
      parts.push("\n**Related Files:**");
      context.relatedFiles.forEach((file) => {
        parts.push(`- ${file.path}`);
        if (file.excerpt) {
          parts.push(`  ${file.excerpt.substring(0, 100)}...`);
        }
      });
    }

    return parts.join("\n");
  }

  /**
   * Build contextual message for LLM with workspace context
   */
  public static buildContextMessage(
    workspaceContext: WorkspaceContext,
    additionalContext?: string,
  ): vscode.LanguageModelChatMessage {
    let content = "Current Workspace Context:\n\n";
    content += this.formatContextForLLM(workspaceContext);

    if (additionalContext) {
      content += "\n\n" + additionalContext;
    }

    return vscode.LanguageModelChatMessage.Assistant(content);
  }
}
