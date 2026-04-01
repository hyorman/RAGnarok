/**
 * VS Code implementation of IConfigProvider
 * Wraps vscode.workspace.getConfiguration()
 */

import * as vscode from "vscode";
import { IConfigProvider, CONFIG } from "@ragnarok/core";

export class VsCodeConfigProvider implements IConfigProvider {
  get<T>(key: string, defaultValue: T): T {
    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
    return config.get<T>(key, defaultValue);
  }
}
