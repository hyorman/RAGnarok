/**
 * VS Code implementation of INotifier
 * Wraps vscode.window.show*Message() and withProgress()
 */

import * as vscode from "vscode";
import { INotifier } from "@ragnarok/core";

export class VsCodeNotifier implements INotifier {
  showInfo(message: string): void {
    vscode.window.showInformationMessage(message);
  }

  showWarning(message: string): void {
    vscode.window.showWarningMessage(message);
  }

  showError(message: string): void {
    vscode.window.showErrorMessage(message);
  }

  async withProgress<T>(title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: false,
      },
      async (progress) => {
        return task((message) => {
          progress.report({ message });
        });
      },
    );
  }
}
