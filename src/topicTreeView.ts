/**
 * Tree view for displaying RAG topics and documents
 * Refactored to use TopicManager and display agentic metadata
 */

import * as vscode from "vscode";
import { TopicManager, TopicStats } from "./managers/topicManager";
import { Topic, Document, RetrievalStrategy } from "./utils/types";
import { Logger } from "./utils/logger";
import { CONFIG, COMMANDS, TREE_CONFIG_KEY, CONTEXT } from "./utils/constants";
import { EmbeddingService } from "./embeddings/embeddingService";

const logger = new Logger("TopicTreeView");

export class TopicTreeDataProvider
  implements vscode.TreeDataProvider<TopicTreeItem>, vscode.Disposable
{
  private _onDidChangeTreeData: vscode.EventEmitter<
    TopicTreeItem | undefined | null | void
  > = new vscode.EventEmitter<TopicTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    TopicTreeItem | undefined | null | void
  > = this._onDidChangeTreeData.event;

  private topicManager: Promise<TopicManager>;
  private embeddingService: EmbeddingService;
  private modelChangeSubscription: vscode.Disposable;

  constructor() {
    this.topicManager = TopicManager.getInstance();
    this.embeddingService = EmbeddingService.getInstance();

    // Subscribe to model change events to auto-refresh the tree view
    this.modelChangeSubscription = EmbeddingService.onModelChanged.subscribe((newModel: string) => {
      logger.debug(`Model changed to "${newModel}", refreshing tree view`);
      this.refresh();
    });
  }

  dispose(): void {
    this.modelChangeSubscription.dispose();
    this._onDidChangeTreeData.dispose();
  }

  refresh(): void {
    logger.debug("Refreshing topic tree view");
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TopicTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TopicTreeItem): Promise<TopicTreeItem[]> {
    try {
      const topicManager = await this.topicManager;

      if (!element) {
        // Root level - show topics only (config is in its own separate view)
        const topics = await topicManager.getAllTopics();
        logger.debug(`Loaded ${topics.length} topics for tree view`);

        // Update VS Code context so viewsWelcome when-clause works correctly
        vscode.commands.executeCommand(
          COMMANDS.SET_CONTEXT,
          CONTEXT.HAS_TOPICS,
          topics.length > 0
        );

        return topics.map((topic: any) => new TopicTreeItem(topic, "topic"));
      } else if (element.type === "topic" && element.topic) {
        // Show statistics and documents for this topic
        const items: TopicTreeItem[] = [];

        // Add stats item
        const stats = await topicManager.getTopicStats(element.topic.id);
        if (stats) {
          items.push(new TopicTreeItem(stats, "topic-stats"));
        }

        // Add documents
        const documents = topicManager.getTopicDocuments(element.topic.id);
        if (documents.length > 0) {
          items.push(
            ...documents.map((doc: any) => new TopicTreeItem(doc, "document"))
          );
        }

        return items;
      } else if (element.type === "topic-stats" && element.data) {
        // Show detailed statistics
        return this.getStatisticsItems(element.data);
      }
      return [];
    } catch (error) {
      logger.error(`Failed to get tree children: ${error}`);
      return [];
    }
  }

  /**
   * Get detailed statistics items for a topic
   */
  private getStatisticsItems(stats: any): TopicTreeItem[] {
    const items: TopicTreeItem[] = [];

    // Document count
    items.push(
      new TopicTreeItem(
        { key: "document-count", value: stats.documentCount },
        "stat-item"
      )
    );

    // Chunk count
    items.push(
      new TopicTreeItem(
        { key: "chunk-count", value: stats.chunkCount },
        "stat-item"
      )
    );

    // Embedding model
    items.push(
      new TopicTreeItem(
        { key: "embedding-model", value: stats.embeddingModel },
        "stat-item"
      )
    );

    // Last updated
    const lastUpdated = new Date(stats.lastUpdated).toLocaleString();
    items.push(
      new TopicTreeItem(
        { key: "last-updated", value: lastUpdated },
        "stat-item"
      )
    );

    return items;
  }
}

type ConfigData = { key: string; value: unknown };
type TreeItemData = Topic | Document | TopicStats | ConfigData | undefined;

export class TopicTreeItem extends vscode.TreeItem {
  constructor(
    public readonly data: TreeItemData,
    public readonly type:
      | "topic"
      | "document"
      | "config-status"
      | "config-item"
      | "topic-stats"
      | "stat-item"
  ) {
    super(
      TopicTreeItem.getLabel(data, type),
      TopicTreeItem.getCollapsibleState(type)
    );

    this.setupTreeItem(data, type);
  }

  private static getLabel(data: any, type: string): string {
    switch (type) {
      case "topic":
        return data.name;
      case "document":
        return `📄 ${data.name}`;
      case "config-status":
        return "⚙️ Configuration";
      case "config-item":
        return TopicTreeItem.formatConfigLabel(data);
      case "topic-stats":
        return "📊 Statistics";
      case "stat-item":
        return TopicTreeItem.formatStatLabel(data);
      default:
        return "Unknown";
    }
  }

  private static getCollapsibleState(
    type: string
  ): vscode.TreeItemCollapsibleState {
    switch (type) {
      case "topic":
      case "config-status":
      case "topic-stats":
        return vscode.TreeItemCollapsibleState.Collapsed;
      default:
        return vscode.TreeItemCollapsibleState.None;
    }
  }

  private static formatConfigLabel(configData: any): string {
    const { key, value } = configData;
    switch (key) {
      case TREE_CONFIG_KEY.RETRIEVAL_STRATEGY:
        return `💡 Retrieval Strategy: ${
          value === RetrievalStrategy.HYBRID
            ? "🔀 Hybrid"
            : value === RetrievalStrategy.VECTOR
            ? "🎯 Vector"
            : value === RetrievalStrategy.ENSEMBLE
            ? "🎭 Ensemble"
            : value === RetrievalStrategy.BM25
            ? "🔍 BM25"
            : "❓ Unknown"
        }`;
      case TREE_CONFIG_KEY.EMBEDDING_MODEL:
        return `🤖 Embedding Model: ${value}`;
      case TREE_CONFIG_KEY.EMBEDDING_BACKEND:
        return `🔌 Backend: ${value}`;
      case TREE_CONFIG_KEY.LLM_MODEL:
        return `🧠 LLM Model: ${value}`;
      case TREE_CONFIG_KEY.MAX_ITERATIONS:
        return `🔄 Max Iterations: ${value}`;
      case TREE_CONFIG_KEY.CONFIDENCE_THRESHOLD:
        return `🎯 Confidence: ${(value * 100).toFixed(0)}%`;
      case TREE_CONFIG_KEY.TOP_K:
        return `📊 Top K: ${value}`;
      case TREE_CONFIG_KEY.CHUNK_SIZE:
        return `📏 Chunk Size: ${value}`;
      case TREE_CONFIG_KEY.CHUNK_OVERLAP:
        return `↔️ Chunk Overlap: ${value}`;
      case TREE_CONFIG_KEY.INCLUDE_WORKSPACE_CONTEXT:
        return `🏢 Include Workspace Context: ${value ? "✅" : "❌"}`;
      default:
        return `${key}: ${value}`;
    }
  }

  private static formatStatLabel(statData: any): string {
    const { key, value } = statData;
    switch (key) {
      case "document-count":
        return `📄 Documents: ${value}`;
      case "chunk-count":
        return `📦 Chunks: ${value}`;
      case "embedding-model":
        return `🤖 Model: ${value}`;
      case "last-updated":
        return `🕒 Updated: ${value}`;
      default:
        return `${key}: ${value}`;
    }
  }

  private setupTreeItem(data: any, type: string): void {
    switch (type) {
      case "topic":
        const topic = data as Topic;
        const isCommon = topic.source === 'common';
        this.tooltip = topic.description || topic.name;
        this.description = isCommon
          ? `${topic.documentCount} document${topic.documentCount !== 1 ? "s" : ""} (read-only)`
          : `${topic.documentCount} document${topic.documentCount !== 1 ? "s" : ""}`;
        // Use different contextValue for common topics to hide modify actions in menus
        this.contextValue = isCommon ? "topic-common" : "topic";
        this.iconPath = new vscode.ThemeIcon(isCommon ? "folder-library" : "folder");
        break;

      case "document":
        const doc = data as Document;
        this.tooltip = `${doc.name} (${doc.fileType})`;
        this.description = `${doc.chunkCount} chunks`;
        this.contextValue = "document";
        this.iconPath = new vscode.ThemeIcon("file");
        break;

      case "config-status":
        this.tooltip = "View current RAG configuration";
        this.contextValue = "config-status";
        this.iconPath = new vscode.ThemeIcon("settings-gear");
        break;

      case "config-item":
        this.tooltip = `Click to change this setting`;
        this.contextValue = "config-item";

        // Make embedding-model item clickable → opens the HF or VS Code model picker
        if (data && data.key === TREE_CONFIG_KEY.EMBEDDING_MODEL) {
          const modelStr = String(data.value ?? '');
          if (modelStr.startsWith('vscodeLM:')) {
            this.command = {
              command: COMMANDS.SELECT_VSCODE_EMBEDDING_MODEL,
              title: 'Select VS Code Embedding Model',
            };
            this.contextValue = "config-embedding-vscode";
          } else {
            this.command = {
              command: COMMANDS.SELECT_HF_EMBEDDING_MODEL,
              title: 'Select HuggingFace Embedding Model',
            };
            this.contextValue = "config-embedding-hf";
          }
          this.tooltip = 'Click to change the embedding model';
        }

        // Make embedding-backend item clickable → opens inline QuickPick
        if (data && data.key === TREE_CONFIG_KEY.EMBEDDING_BACKEND) {
          this.command = {
            command: COMMANDS.EDIT_CONFIG_ITEM,
            title: 'Change Embedding Backend',
            arguments: [TREE_CONFIG_KEY.EMBEDDING_BACKEND],
          };
          this.contextValue = "config-embedding-backend";
          this.tooltip = 'Click to change the embedding backend';
        }

        // Make retrieval-strategy item clickable → opens inline QuickPick
        if (data && data.key === TREE_CONFIG_KEY.RETRIEVAL_STRATEGY) {
          this.command = {
            command: COMMANDS.EDIT_CONFIG_ITEM,
            title: 'Change Retrieval Strategy',
            arguments: [TREE_CONFIG_KEY.RETRIEVAL_STRATEGY],
          };
          this.contextValue = "config-retrieval-strategy";
          this.tooltip = 'Click to change the retrieval strategy';
        }

        if (data && data.key === TREE_CONFIG_KEY.INCLUDE_WORKSPACE_CONTEXT) {
          this.command = {
            command: COMMANDS.EDIT_CONFIG_ITEM,
            title: 'Toggle Workspace Context',
            arguments: [TREE_CONFIG_KEY.INCLUDE_WORKSPACE_CONTEXT],
          };
          this.contextValue = "config-include-workspace";
          this.tooltip = `Include Workspace Context: ${data.value ? 'Enabled' : 'Disabled'} — Click to toggle`;
        }

        // Make llm-model item clickable → opens the LLM model picker
        if (data && data.key === TREE_CONFIG_KEY.LLM_MODEL) {
          this.command = {
            command: COMMANDS.SELECT_LLM_MODEL,
            title: 'Select LLM Model',
          };
          this.contextValue = "config-llm-model";
          this.tooltip = `Current LLM: ${data.value} — Click to change`;
        }

        // Number inputs
        if (data && data.key === TREE_CONFIG_KEY.MAX_ITERATIONS) {
          this.command = {
            command: COMMANDS.EDIT_CONFIG_ITEM,
            title: 'Change Max Iterations',
            arguments: [TREE_CONFIG_KEY.MAX_ITERATIONS],
          };
          this.contextValue = "config-max-iterations";
          this.tooltip = `Max Iterations: ${data.value} — Click to change`;
        }

        if (data && data.key === TREE_CONFIG_KEY.CONFIDENCE_THRESHOLD) {
          this.command = {
            command: COMMANDS.EDIT_CONFIG_ITEM,
            title: 'Change Confidence Threshold',
            arguments: [TREE_CONFIG_KEY.CONFIDENCE_THRESHOLD],
          };
          this.contextValue = "config-confidence-threshold";
          this.tooltip = `Confidence Threshold: ${data.value} — Click to change`;
        }

        if (data && data.key === TREE_CONFIG_KEY.TOP_K) {
          this.command = {
            command: COMMANDS.EDIT_CONFIG_ITEM,
            title: 'Change Top K',
            arguments: [TREE_CONFIG_KEY.TOP_K],
          };
          this.contextValue = "config-top-k";
          this.tooltip = `Top K Results: ${data.value} — Click to change`;
        }

        if (data && data.key === TREE_CONFIG_KEY.CHUNK_SIZE) {
          this.command = {
            command: COMMANDS.EDIT_CONFIG_ITEM,
            title: 'Change Chunk Size',
            arguments: [TREE_CONFIG_KEY.CHUNK_SIZE],
          };
          this.contextValue = "config-chunk-size";
          this.tooltip = `Chunk Size: ${data.value} — Click to change`;
        }

        if (data && data.key === TREE_CONFIG_KEY.CHUNK_OVERLAP) {
          this.command = {
            command: COMMANDS.EDIT_CONFIG_ITEM,
            title: 'Change Chunk Overlap',
            arguments: [TREE_CONFIG_KEY.CHUNK_OVERLAP],
          };
          this.contextValue = "config-chunk-overlap";
          this.tooltip = `Chunk Overlap: ${data.value} — Click to change`;
        }

        break;

      case "topic-stats":
        this.tooltip = "Topic statistics and metadata";
        this.contextValue = "topic-stats";
        this.iconPath = new vscode.ThemeIcon("graph");
        break;

      case "stat-item":
        this.tooltip = `${data.key}: ${data.value}`;
        this.contextValue = "stat-item";
        this.iconPath = new vscode.ThemeIcon("symbol-numeric");
        break;
    }
  }

  get topic(): Topic | undefined {
    return this.type === "topic" ? (this.data as Topic) : undefined;
  }

  get document(): Document | undefined {
    return this.type === "document" ? (this.data as Document) : undefined;
  }
}

/**
 * Separate tree data provider for the Configuration view (ragConfig panel).
 * Always has items, so the Topics view can use viewsWelcome for its empty state.
 */
export class ConfigTreeDataProvider
  implements vscode.TreeDataProvider<TopicTreeItem>, vscode.Disposable
{
  private _onDidChangeTreeData: vscode.EventEmitter<
    TopicTreeItem | undefined | null | void
  > = new vscode.EventEmitter<TopicTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    TopicTreeItem | undefined | null | void
  > = this._onDidChangeTreeData.event;

  private embeddingService: EmbeddingService;
  private modelChangeSubscription: vscode.Disposable;

  constructor() {
    this.embeddingService = EmbeddingService.getInstance();
    this.modelChangeSubscription = EmbeddingService.onModelChanged.subscribe(
      (newModel: string) => {
        logger.debug(`Model changed to "${newModel}", refreshing config view`);
        this.refresh();
      }
    );
  }

  dispose(): void {
    this.modelChangeSubscription.dispose();
    this._onDidChangeTreeData.dispose();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TopicTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TopicTreeItem): Promise<TopicTreeItem[]> {
    try {
      if (!element) {
        // Root: config items directly — no extra collapsible wrapper needed
        return this.getConfigurationItems();
      }
      return [];
    } catch (error) {
      logger.error(`Failed to get config tree children: ${error}`);
      return [];
    }
  }

  private async getConfigurationItems(): Promise<TopicTreeItem[]> {
    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
    const items: TopicTreeItem[] = [];

    const currentModel = this.embeddingService.getCurrentModel();
    items.push(
      new TopicTreeItem(
        { key: TREE_CONFIG_KEY.EMBEDDING_MODEL, value: currentModel },
        "config-item"
      )
    );

    const backend = config.get<string>(CONFIG.EMBEDDING_BACKEND, "auto");
    const activeBackend =
      this.embeddingService.getActiveBackendType?.() ?? backend;
    items.push(
      new TopicTreeItem(
        {
          key: TREE_CONFIG_KEY.EMBEDDING_BACKEND,
          value: `${backend}${activeBackend !== backend ? ` → ${activeBackend}` : ""}`,
        },
        "config-item"
      )
    );

    const strategy = config.get<string>(CONFIG.RETRIEVAL_STRATEGY, "hybrid");
    items.push(
      new TopicTreeItem(
        { key: TREE_CONFIG_KEY.RETRIEVAL_STRATEGY, value: strategy },
        "config-item"
      )
    );

    const topK = config.get<number>(CONFIG.TOP_K, 5);
    items.push(
      new TopicTreeItem({ key: TREE_CONFIG_KEY.TOP_K, value: topK }, "config-item")
    );

    const chunkSize = config.get<number>(CONFIG.CHUNK_SIZE, 1000);
    items.push(
      new TopicTreeItem(
        { key: TREE_CONFIG_KEY.CHUNK_SIZE, value: chunkSize },
        "config-item"
      )
    );

    const chunkOverlap = config.get<number>(CONFIG.CHUNK_OVERLAP, 200);
    items.push(
      new TopicTreeItem(
        { key: TREE_CONFIG_KEY.CHUNK_OVERLAP, value: chunkOverlap },
        "config-item"
      )
    );

    const llmModel = config.get<string>(CONFIG.LLM_MODEL, "gpt-4o-mini");
    items.push(
      new TopicTreeItem(
        { key: TREE_CONFIG_KEY.LLM_MODEL, value: llmModel },
        "config-item"
      )
    );

    const includeWorkspace = config.get<boolean>(
      CONFIG.INCLUDE_WORKSPACE,
      true
    );
    items.push(
      new TopicTreeItem(
        { key: TREE_CONFIG_KEY.INCLUDE_WORKSPACE_CONTEXT, value: includeWorkspace },
        "config-item"
      )
    );

    const maxIterations = config.get<number>(CONFIG.MAX_ITERATIONS, 3);
    items.push(
      new TopicTreeItem(
        { key: TREE_CONFIG_KEY.MAX_ITERATIONS, value: maxIterations },
        "config-item"
      )
    );

    const threshold = config.get<number>(
      CONFIG.CONFIDENCE_THRESHOLD,
      0.7
    );
    items.push(
      new TopicTreeItem(
        { key: TREE_CONFIG_KEY.CONFIDENCE_THRESHOLD, value: threshold },
        "config-item"
      )
    );

    return items;
  }

  /**
   * List available VS Code LM embedding models and let the user pick one.
   */
  async selectVscodeEmbeddingModel(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lm = vscode.lm as any;

      if (!lm || typeof lm.computeEmbeddings !== 'function') {
        vscode.window.showWarningMessage(
          'VS Code LM Embeddings API is not available. ' +
          'Make sure you are running VS Code with the proposed API enabled and a provider (e.g. GitHub Copilot) installed.'
        );
        return;
      }

      const models: string[] | undefined = lm.embeddingModels;

      if (!models || models.length === 0) {
        vscode.window.showWarningMessage(
          'No embedding models are currently registered. ' +
          'Install a provider extension (e.g. GitHub Copilot) that registers embedding models.'
        );
        return;
      }

      const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
      const currentModelId = config.get<string>(CONFIG.EMBEDDING_VSCODE_MODEL_ID, '');

      const items: vscode.QuickPickItem[] = [
        {
          label: '$(sparkle) Auto (first available)',
          description: 'Clear the model ID setting — auto-select at runtime',
          detail: currentModelId === '' ? '$(check) Currently active' : undefined,
        },
        ...models.map((id: string) => ({
          label: id,
          description: id === currentModelId ? '$(check) Currently selected' : undefined,
        })),
      ];

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a VS Code LM embedding model',
        title: 'Available VS Code LM Embedding Models',
      });

      if (!picked) {
        return;
      }

      const newModelId = picked.label.startsWith('$(sparkle)') ? '' : picked.label;

      await config.update(
        CONFIG.EMBEDDING_VSCODE_MODEL_ID,
        newModelId || undefined,
        vscode.ConfigurationTarget.Workspace
      );

      const displayName = newModelId || 'Auto (first available)';
      vscode.window.showInformationMessage(
        `VS Code embedding model set to: ${displayName}`
      );
      logger.info(`VS Code embedding model set to: ${displayName}`);
    } catch (error) {
      logger.error(`Failed to select VS Code embedding model: ${error}`);
      vscode.window.showErrorMessage(`Failed to select VS Code embedding model: ${error}`);
    }
  }

  /**
   * List available HuggingFace embedding models and let the user pick one,
   * or enter a custom HuggingFace Hub model ID.
   */
  async selectHfEmbeddingModel(): Promise<void> {
    try {
      const models = await this.embeddingService.listAvailableModels();
      const currentModel = this.embeddingService.getCurrentModel();

      const items: vscode.QuickPickItem[] = [];

      const downloaded = models.filter(m => m.downloaded);
      const notDownloaded = models.filter(m => !m.downloaded);

      if (downloaded.length > 0) {
        items.push({ label: 'Downloaded / Local', kind: vscode.QuickPickItemKind.Separator });
        for (const m of downloaded) {
          items.push({
            label: m.name,
            description: m.name === currentModel ? '$(check) Active' : `(${m.source})`,
            detail: 'Ready to use — no download needed',
          });
        }
      }

      if (notDownloaded.length > 0) {
        items.push({ label: 'Available for Download', kind: vscode.QuickPickItemKind.Separator });
        for (const m of notDownloaded) {
          const isXenova = m.name.startsWith('Xenova/');
          const detail = isXenova
            ? 'Pre-converted ONNX — reliable, will download on first use'
            : m.name.startsWith('sentence-transformers/')
              ? 'May auto-convert via Transformers.js v3 — download on first use'
              : 'Will be downloaded on first use';
          items.push({
            label: m.name,
            description: m.name === currentModel ? '$(check) Active' : `(${m.source})`,
            detail,
          });
        }
      }

      items.push({ label: 'Custom', kind: vscode.QuickPickItemKind.Separator });
      items.push({
        label: '$(pencil) Enter custom model ID…',
        description: 'any HuggingFace Hub model with ONNX support',
        detail: 'Model must have ONNX files (onnx/model.onnx) — Xenova/ namespace recommended',
        alwaysShow: true,
      });

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: currentModel ? `Current: ${currentModel}` : 'Select a HuggingFace embedding model',
        title: 'HuggingFace Embedding Models',
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (!picked) {
        return;
      }

      let selectedModel: string;

      if (picked.label.startsWith('$(pencil)')) {
        const customId = await vscode.window.showInputBox({
          prompt: 'Enter a HuggingFace Hub model ID (e.g. Xenova/all-MiniLM-L6-v2)',
          placeHolder: 'namespace/model-name',
          validateInput: (value) => {
            if (!value || !value.trim()) {
              return 'Model ID cannot be empty';
            }
            if (!value.includes('/')) {
              return 'Model ID should include namespace (e.g. Xenova/model-name)';
            }
            return null;
          },
        });
        if (!customId) {
          return;
        }
        selectedModel = customId.trim();
      } else {
        selectedModel = picked.label;
      }

      if (selectedModel === currentModel) {
        vscode.window.showInformationMessage(`"${selectedModel}" is already the active model.`);
        return;
      }

      // Delegate to the SET_EMBEDDING_MODEL command which handles initialization + re-indexing
      await vscode.commands.executeCommand(COMMANDS.SET_EMBEDDING_MODEL, selectedModel);
    } catch (error) {
      logger.error(`Failed to select HuggingFace embedding model: ${error}`);
      vscode.window.showErrorMessage(`Failed to select HuggingFace embedding model: ${error}`);
    }
  }

  /**
   * Discover available Copilot LLM models at runtime and let the user pick one.
   */
  async selectLLMModel(): Promise<void> {
    try {
      if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
        vscode.window.showWarningMessage(
          'VS Code Language Model API is not available. Make sure you have GitHub Copilot installed and VS Code 1.90+.'
        );
        return;
      }

      const allModels = await vscode.lm.selectChatModels({});
      if (!allModels || allModels.length === 0) {
        vscode.window.showWarningMessage(
          'No LLM models are currently available. Ensure GitHub Copilot is signed in and active.'
        );
        return;
      }

      const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
      const currentFamily = config.get<string>(CONFIG.LLM_MODEL, 'gpt-4o-mini');

      const familyMap = new Map<string, { vendor: string; maxTokens: number; count: number }>();
      for (const m of allModels) {
        const existing = familyMap.get(m.family);
        if (!existing || m.maxInputTokens > existing.maxTokens) {
          familyMap.set(m.family, {
            vendor: m.vendor,
            maxTokens: m.maxInputTokens,
            count: (existing?.count ?? 0) + 1,
          });
        } else {
          familyMap.set(m.family, { ...existing, count: existing.count + 1 });
        }
      }

      const pickerItems: vscode.QuickPickItem[] = [];

      for (const [family, info] of familyMap) {
        pickerItems.push({
          label: family,
          description: family === currentFamily
            ? '$(check) Active'
            : `${info.vendor} · ${info.maxTokens.toLocaleString()} max tokens`,
          detail: family === currentFamily
            ? `$(check) Currently selected · ${info.vendor} · ${info.maxTokens.toLocaleString()} max tokens`
            : undefined,
        });
      }

      pickerItems.sort((a, b) => {
        if (a.label === currentFamily) { return -1; }
        if (b.label === currentFamily) { return 1; }
        return a.label.localeCompare(b.label);
      });

      const picked = await vscode.window.showQuickPick(pickerItems, {
        placeHolder: `Current: ${currentFamily}`,
        title: `Available LLM Models (${allModels.length} found)`,
        matchOnDescription: true,
      });

      if (!picked) {
        return;
      }

      if (picked.label === currentFamily) {
        vscode.window.showInformationMessage(`"${currentFamily}" is already the active LLM model.`);
        return;
      }

      await config.update(
        CONFIG.LLM_MODEL,
        picked.label,
        vscode.ConfigurationTarget.Workspace
      );

      vscode.window.showInformationMessage(`LLM model set to: ${picked.label}`);
      logger.info(`LLM model set to: ${picked.label}`);
      this.refresh();
    } catch (error) {
      logger.error(`Failed to select LLM model: ${error}`);
      vscode.window.showErrorMessage(`Failed to select LLM model: ${error}`);
    }
  }

  /**
   * Generic inline editor for any configuration item.
   * Handles booleans (toggle), enums (QuickPick), and numbers (InputBox).
   */
  async editConfigItem(configKey: string): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);

    const configMap: Record<string, {
      settingKey: string;
      type: 'boolean' | 'enum' | 'number';
      options?: string[];
      optionLabels?: Record<string, string>;
      min?: number;
      max?: number;
      step?: number;
      label: string;
    }> = {
      [TREE_CONFIG_KEY.EMBEDDING_BACKEND]: {
        settingKey: CONFIG.EMBEDDING_BACKEND,
        type: 'enum',
        options: ['auto', 'vscodeLM', 'huggingface'],
        optionLabels: {
          'auto': 'Auto — try VS Code LM first, fall back to HuggingFace',
          'vscodeLM': 'VS Code LM — requires an embedding provider (e.g. Copilot)',
          'huggingface': 'HuggingFace — local Transformers.js (offline)',
        },
        label: 'Embedding Backend',
      },
      [TREE_CONFIG_KEY.RETRIEVAL_STRATEGY]: {
        settingKey: CONFIG.RETRIEVAL_STRATEGY,
        type: 'enum',
        options: ['hybrid', 'vector', 'ensemble', 'bm25'],
        optionLabels: {
          'hybrid': 'Hybrid — 70% semantic + 30% keyword (recommended)',
          'vector': 'Vector — pure semantic similarity',
          'ensemble': 'Ensemble — RRF fusion (slower, more accurate)',
          'bm25': 'BM25 — pure keyword search (no embeddings)',
        },
        label: 'Retrieval Strategy',
      },
      [TREE_CONFIG_KEY.INCLUDE_WORKSPACE_CONTEXT]: {
        settingKey: CONFIG.INCLUDE_WORKSPACE,
        type: 'boolean',
        label: 'Include Workspace Context',
      },
      [TREE_CONFIG_KEY.MAX_ITERATIONS]: {
        settingKey: CONFIG.MAX_ITERATIONS,
        type: 'number',
        min: 1,
        max: 10,
        step: 1,
        label: 'Max Iterations',
      },
      [TREE_CONFIG_KEY.CONFIDENCE_THRESHOLD]: {
        settingKey: CONFIG.CONFIDENCE_THRESHOLD,
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        label: 'Confidence Threshold',
      },
      [TREE_CONFIG_KEY.TOP_K]: {
        settingKey: CONFIG.TOP_K,
        type: 'number',
        min: 1,
        max: 20,
        step: 1,
        label: 'Top K Results',
      },
      [TREE_CONFIG_KEY.CHUNK_SIZE]: {
        settingKey: CONFIG.CHUNK_SIZE,
        type: 'number',
        min: 100,
        max: 2000,
        step: 50,
        label: 'Chunk Size',
      },
      [TREE_CONFIG_KEY.CHUNK_OVERLAP]: {
        settingKey: CONFIG.CHUNK_OVERLAP,
        type: 'number',
        min: 0,
        max: 500,
        step: 10,
        label: 'Chunk Overlap',
      },
    };

    const entry = configMap[configKey];
    if (!entry) {
      logger.warn(`editConfigItem: unknown config key "${configKey}"`);
      return;
    }

    try {
      if (entry.type === 'boolean') {
        const current = config.get<boolean>(entry.settingKey, false);
        await config.update(entry.settingKey, !current, vscode.ConfigurationTarget.Workspace);
        const state = !current ? 'enabled' : 'disabled';
        vscode.window.showInformationMessage(`${entry.label}: ${state}`);
        logger.info(`${entry.label} toggled to ${state}`);

      } else if (entry.type === 'enum' && entry.options) {
        const current = config.get<string>(entry.settingKey, entry.options[0]);
        const enumItems: vscode.QuickPickItem[] = entry.options.map(opt => ({
          label: opt,
          description: opt === current ? '(current)' : undefined,
          detail: entry.optionLabels?.[opt],
        }));

        const picked = await vscode.window.showQuickPick(enumItems, {
          title: `Select ${entry.label}`,
          placeHolder: `Current: ${current}`,
        });
        if (!picked) { return; }
        if (picked.label === current) {
          vscode.window.showInformationMessage(`${entry.label} is already "${current}".`);
          return;
        }
        await config.update(entry.settingKey, picked.label, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage(`${entry.label} set to: ${picked.label}`);
        logger.info(`${entry.label} set to: ${picked.label}`);

      } else if (entry.type === 'number') {
        const current = config.get<number>(entry.settingKey, 0);
        const input = await vscode.window.showInputBox({
          title: `Set ${entry.label}`,
          prompt: `Enter a value between ${entry.min ?? 0} and ${entry.max ?? '∞'}`,
          value: String(current),
          validateInput: (val) => {
            const num = Number(val);
            if (isNaN(num)) { return 'Must be a number'; }
            if (entry.min !== undefined && num < entry.min) { return `Minimum is ${entry.min}`; }
            if (entry.max !== undefined && num > entry.max) { return `Maximum is ${entry.max}`; }
            return undefined;
          },
        });
        if (input === undefined) { return; }
        const numVal = Number(input);
        await config.update(entry.settingKey, numVal, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage(`${entry.label} set to: ${numVal}`);
        logger.info(`${entry.label} set to: ${numVal}`);
      }

      this.refresh();
    } catch (error) {
      logger.error(`Failed to edit ${entry.label}: ${error}`);
      vscode.window.showErrorMessage(`Failed to edit ${entry.label}: ${error}`);
    }
  }
}
