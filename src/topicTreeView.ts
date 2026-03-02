/**
 * Tree view for displaying RAG topics and documents
 * Refactored to use TopicManager and display agentic metadata
 */

import * as vscode from "vscode";
import { TopicManager } from "./managers/topicManager";
import { Topic, Document, RetrievalStrategy } from "./utils/types";
import { Logger } from "./utils/logger";
import { CONFIG, COMMANDS, TREE_CONFIG_KEY } from "./utils/constants";
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
        // Root level - show configuration status + topics
        const items: TopicTreeItem[] = [];

        // Add configuration status item
        items.push(new TopicTreeItem(null, "config-status"));

        // Add topics
        const topics = await topicManager.getAllTopics();
        logger.debug(`Loaded ${topics.length} topics for tree view`);

        items.push(
          ...topics.map((topic: any) => new TopicTreeItem(topic, "topic"))
        );
        return items;
      } else if (element.type === "config-status") {
        // Show configuration items
        return this.getConfigurationItems();
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
   * Get configuration status items
   */
  private async getConfigurationItems(): Promise<TopicTreeItem[]> {
    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
    const items: TopicTreeItem[] = [];

    // Embedding model (actual model currently loaded)
    const currentModel = this.embeddingService.getCurrentModel();
    items.push(
      new TopicTreeItem(
        { key: TREE_CONFIG_KEY.EMBEDDING_MODEL, value: currentModel },
        "config-item"
      )
    );

    // Embedding backend
    const backend = config.get<string>(CONFIG.EMBEDDING_BACKEND, 'auto');
    const activeBackend = this.embeddingService.getActiveBackendType?.() ?? backend;
    items.push(
      new TopicTreeItem(
        { key: TREE_CONFIG_KEY.EMBEDDING_BACKEND, value: `${backend}${activeBackend !== backend ? ` → ${activeBackend}` : ''}` },
        "config-item"
      )
    );

    // Retrieval strategy (applies to all modes)
    const strategy = config.get<string>(CONFIG.RETRIEVAL_STRATEGY, "hybrid");
    items.push(
      new TopicTreeItem(
        { key: TREE_CONFIG_KEY.RETRIEVAL_STRATEGY, value: strategy },
        "config-item"
      )
    );

    // Top K
    const topK = config.get<number>(CONFIG.TOP_K, 5);
    items.push(
      new TopicTreeItem(
        { key: TREE_CONFIG_KEY.TOP_K, value: topK },
        "config-item"
      )
    );

    // Chunk size
    const chunkSize = config.get<number>(CONFIG.CHUNK_SIZE, 512);
    items.push(
      new TopicTreeItem(
        { key: TREE_CONFIG_KEY.CHUNK_SIZE, value: chunkSize },
        "config-item"
      )
    );

    // Chunk overlap
    const chunkOverlap = config.get<number>(CONFIG.CHUNK_OVERLAP, 50);
    items.push(
      new TopicTreeItem(
        { key: TREE_CONFIG_KEY.CHUNK_OVERLAP, value: chunkOverlap },
        "config-item"
      )
    );

    // Log level
    const logLevel = config.get<string>(CONFIG.LOG_LEVEL, 'info');
    items.push(
      new TopicTreeItem(
        { key: TREE_CONFIG_KEY.LOG_LEVEL, value: logLevel },
        "config-item"
      )
    );

    // Agentic mode status
    const useAgenticMode = config.get<boolean>(CONFIG.USE_AGENTIC_MODE, false);
    items.push(
      new TopicTreeItem(
        { key: TREE_CONFIG_KEY.AGENTIC_MODE, value: useAgenticMode },
        "config-item"
      )
    );

    // LLM usage
    if (useAgenticMode) {
      const useLLM = config.get<boolean>(CONFIG.AGENTIC_USE_LLM, true);
      items.push(
        new TopicTreeItem({ key: TREE_CONFIG_KEY.USE_LLM, value: useLLM }, "config-item")
      );

      // LLM model family (show when LLM is enabled)
      if (useLLM) {
        const llmModel = config.get<string>(CONFIG.AGENTIC_LLM_MODEL, 'gpt-4o-mini');
        items.push(
          new TopicTreeItem(
            { key: TREE_CONFIG_KEY.LLM_MODEL, value: llmModel },
            "config-item"
          )
        );

        // Include workspace context
        const includeWorkspace = config.get<boolean>(CONFIG.AGENTIC_INCLUDE_WORKSPACE, true);
        items.push(
          new TopicTreeItem(
            { key: TREE_CONFIG_KEY.INCLUDE_WORKSPACE_CONTEXT, value: includeWorkspace },
            "config-item"
          )
        );
      }

      // Iterative refinement
      const iterativeRefinement = config.get<boolean>(CONFIG.AGENTIC_ITERATIVE_REFINEMENT, true);
      items.push(
        new TopicTreeItem(
          { key: TREE_CONFIG_KEY.ITERATIVE_REFINEMENT, value: iterativeRefinement },
          "config-item"
        )
      );

      // Max iterations
      const maxIterations = config.get<number>(
        CONFIG.AGENTIC_MAX_ITERATIONS,
        3
      );
      items.push(
        new TopicTreeItem(
          { key: TREE_CONFIG_KEY.MAX_ITERATIONS, value: maxIterations },
          "config-item"
        )
      );

      // Confidence threshold
      const threshold = config.get<number>(
        CONFIG.AGENTIC_CONFIDENCE_THRESHOLD,
        0.7
      );
      items.push(
        new TopicTreeItem(
          { key: TREE_CONFIG_KEY.CONFIDENCE_THRESHOLD, value: threshold },
          "config-item"
        )
      );
    }

    return items;
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

export class TopicTreeItem extends vscode.TreeItem {
  constructor(
    public readonly data: Topic | Document | any,
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
      case TREE_CONFIG_KEY.AGENTIC_MODE:
        return `Agentic Mode: ${value ? "✅ Enabled" : "❌ Disabled"}`;
      case TREE_CONFIG_KEY.USE_LLM:
        return `LLM Planning: ${value ? "✅ Enabled" : "❌ Disabled"}`;
      case TREE_CONFIG_KEY.RETRIEVAL_STRATEGY:
        return `Strategy: ${
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
      case TREE_CONFIG_KEY.LOG_LEVEL:
        return `📋 Log Level: ${value}`;
      case TREE_CONFIG_KEY.ITERATIVE_REFINEMENT:
        return `Iterative Refinement: ${value ? "✅ Enabled" : "❌ Disabled"}`;
      case TREE_CONFIG_KEY.INCLUDE_WORKSPACE_CONTEXT:
        return `Workspace Context: ${value ? "✅ Included" : "❌ Excluded"}`;
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

        // Boolean toggles
        if (data && data.key === TREE_CONFIG_KEY.AGENTIC_MODE) {
          this.command = {
            command: COMMANDS.EDIT_CONFIG_ITEM,
            title: 'Toggle Agentic Mode',
            arguments: [TREE_CONFIG_KEY.AGENTIC_MODE],
          };
          this.contextValue = "config-agentic-mode";
          this.tooltip = `Agentic Mode: ${data.value ? 'Enabled' : 'Disabled'} — Click to toggle`;
        }

        if (data && data.key === TREE_CONFIG_KEY.USE_LLM) {
          this.command = {
            command: COMMANDS.EDIT_CONFIG_ITEM,
            title: 'Toggle LLM Planning',
            arguments: [TREE_CONFIG_KEY.USE_LLM],
          };
          this.contextValue = "config-llm";
          this.tooltip = `LLM Planning: ${data.value ? 'Enabled' : 'Disabled'} — Click to toggle`;
        }

        if (data && data.key === TREE_CONFIG_KEY.ITERATIVE_REFINEMENT) {
          this.command = {
            command: COMMANDS.EDIT_CONFIG_ITEM,
            title: 'Toggle Iterative Refinement',
            arguments: [TREE_CONFIG_KEY.ITERATIVE_REFINEMENT],
          };
          this.contextValue = "config-iterative-refinement";
          this.tooltip = `Iterative Refinement: ${data.value ? 'Enabled' : 'Disabled'} — Click to toggle`;
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

        if (data && data.key === TREE_CONFIG_KEY.LOG_LEVEL) {
          this.command = {
            command: COMMANDS.EDIT_CONFIG_ITEM,
            title: 'Change Log Level',
            arguments: [TREE_CONFIG_KEY.LOG_LEVEL],
          };
          this.contextValue = "config-log-level";
          this.tooltip = `Log Level: ${data.value} — Click to change`;
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
