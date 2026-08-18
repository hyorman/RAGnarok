/**
 * The seam every language-model tool in this extension registers through.
 *
 * `vscode.lm` is only present in a Copilot-enabled host, and unit tests running
 * inside the real extension host resolve `vscode` to the live API rather than to
 * the test harness mock, so registration has to be injectable to be observable.
 */
import * as vscode from "vscode";

export interface LanguageModelToolRegistrationHost {
  registerTool<T>(name: string, tool: vscode.LanguageModelTool<T>): vscode.Disposable;
  createToolResult(content: Array<vscode.LanguageModelTextPart | unknown>): vscode.LanguageModelToolResult;
  createTextPart(value: string): vscode.LanguageModelTextPart;
}

export const vscodeToolRegistrationHost: LanguageModelToolRegistrationHost = {
  registerTool: <T>(name: string, tool: vscode.LanguageModelTool<T>) => vscode.lm.registerTool(name, tool),
  createToolResult: (content) => new vscode.LanguageModelToolResult(content),
  createTextPart: (value) => new vscode.LanguageModelTextPart(value),
};
