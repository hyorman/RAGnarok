/**
 * VS Code implementation of IConfigProvider
 * Wraps vscode.workspace.getConfiguration()
 */

import * as vscode from "vscode";
import { IConfigProvider } from "@ragnarok/core";
import { VSCODE_CONFIG } from "../constants";

export class VsCodeConfigProvider implements IConfigProvider {
  get<T>(key: string, defaultValue: T): T {
    const config = vscode.workspace.getConfiguration(VSCODE_CONFIG.ROOT);
    return config.get<T>(key, defaultValue);
  }
}
