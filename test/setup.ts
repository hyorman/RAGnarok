/**
 * Test setup file - mocks VS Code API for unit tests
 * This file is loaded before running any tests
 */

import { DEFAULTS } from '../src/utils/constants';

// Create a comprehensive VS Code API mock
const ragConfig = {
  embeddingModel: DEFAULTS.EMBEDDING_MODEL,
  topK: 5,
  chunkSize: 512,
  chunkOverlap: 50,
  logLevel: 'info',
  retrievalStrategy: 'hybrid',
  maxIterations: 3,
  confidenceThreshold: 0.7,
  llmModel: 'gpt-4o',
  includeWorkspaceContext: false,
};

const globalConfig = {
  ...ragConfig,
  pdfStructureDetection: 'heuristic',
};

const mockVscode = {
  workspace: {
    getConfiguration: (section?: string) => ({
      get: <T>(key: string, defaultValue?: T): T => {
        if (section) {
          const sectionConfig = section === 'ragnarok' ? ragConfig : globalConfig;
          const scopedValue = (sectionConfig as any)[key];
          if (scopedValue !== undefined) {
            return scopedValue;
          }
        }

        const globalValue = (globalConfig as any)[key];
        if (globalValue !== undefined) {
          return globalValue;
        }

        return defaultValue as T;
      },
      update: async () => undefined,
      inspect: () => undefined,
      has: () => true,
    }),
    workspaceFolders: [],
    onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
  },

  window: {
    showInformationMessage: async (message: string) => {
      console.log(`[INFO] ${message}`);
      return undefined;
    },
    showWarningMessage: async (message: string) => {
      console.log(`[WARN] ${message}`);
      return undefined;
    },
    showErrorMessage: async (message: string) => {
      console.log(`[ERROR] ${message}`);
      return undefined;
    },
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    withProgress: async (options: any, task: any) => {
      const progress = {
        report: (value: any) => {
          if (value.message) {
            console.log(`[PROGRESS] ${value.message}`);
          }
        },
      };
      return await task(progress, { isCancellationRequested: false });
    },
    createOutputChannel: (name: string) => ({
      append: (value: string) => {},
      appendLine: (value: string) => {},
      clear: () => {},
      show: () => {},
      hide: () => {},
      dispose: () => {},
      name,
      replace: (value: string) => {},
    }),
  },

  lm: {
    selectChatModels: async (options?: any) => {
      // Mock LM model selection (returns empty for unit tests)
      return [];
    },
  },

  Uri: class {
    static file(path: string) {
      return {
        fsPath: path,
        path,
        scheme: 'file',
        toString: () => path,
      };
    }

    static parse(uri: string) {
      return {
        fsPath: uri,
        path: uri,
        scheme: 'file',
        toString: () => uri,
      };
    }
  },

  EventEmitter: class {
    fire() {}
    event = () => ({ dispose: () => {} });
    dispose() {}
  },

  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2,
  },

  TreeItem: class {
    constructor(public label: string, public collapsibleState?: any) {}
  },

  ThemeIcon: class {
    constructor(public id: string) {}
  },

  CancellationTokenSource: class {
    private _listeners: Array<() => void> = [];
    token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        this._listeners.push(listener);
        return { dispose: () => {} };
      },
    };
    cancel() {
      this.token.isCancellationRequested = true;
      for (const listener of this._listeners) {
        listener();
      }
    }
    dispose() {}
  },

  ProgressLocation: {
    Notification: 15,
    Window: 10,
    SourceControl: 1,
  },

  ViewColumn: {
    Active: -1,
    Beside: -2,
    One: 1,
    Two: 2,
    Three: 3,
  },

  ExtensionContext: class {
    subscriptions: any[] = [];
    globalState = {
      get: () => undefined,
      update: async () => undefined,
      keys: () => [],
    };
    workspaceState = {
      get: () => undefined,
      update: async () => undefined,
      keys: () => [],
    };
    extensionPath = '/mock/extension/path';
    storagePath = '/mock/storage/path';
    globalStoragePath = '/mock/global/storage/path';
    logPath = '/mock/log/path';
    extensionUri = { fsPath: '/mock/extension/path' };
    storageUri = { fsPath: '/mock/storage/path' };
    globalStorageUri = { fsPath: '/mock/global/storage/path' };
    logUri = { fsPath: '/mock/log/path' };
  },
};

// Inject mock into global scope before any imports
(global as any).vscode = mockVscode;

// Export for tests that need direct access
export default mockVscode;
