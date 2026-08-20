import * as vscode from "vscode";
import {
  applyStorageMigration,
  getStorageMigrationStatus,
  planStorageMigration,
  resumeStorageMigration,
  type MigrationReport,
  type StorageMigrationPlan,
  type TopicManager,
} from "@ragnarok/core";

export type MigrationChoice = "migrate" | "cancel";

export interface MigrationUxDependencies {
  createTopicManager(): Promise<TopicManager>;
  plan(storageDir: string): Promise<StorageMigrationPlan>;
  status(storageDir: string, migrationId: string): ReturnType<typeof getStorageMigrationStatus>;
  apply(storageDir: string, options: { acceptedBackupPath: string; signal: AbortSignal }): Promise<MigrationReport>;
  resume(storageDir: string, migrationId: string): Promise<MigrationReport>;
  choose(plan: StorageMigrationPlan, summary: string): Promise<MigrationChoice>;
  progress(resuming: boolean, task: (signal: AbortSignal) => Promise<void>): Promise<void>;
  showStorageFailure(message: string): Promise<void>;
  showCancellation(message: string): Promise<void>;
}

function migrationSummary(plan: StorageMigrationPlan): string {
  return (
    `Legacy RAGnarōk 0.3 storage detected: ${plan.topics.length} topic(s), ` +
    `${plan.topics.reduce((sum, topic) => sum + topic.leafDocumentCount, 0)} document leaf/leaves, ` +
    `${plan.topics.reduce((sum, topic) => sum + topic.chunkCount, 0)} chunk(s). ` +
    `Migration needs approximately ${plan.requiredBytes} bytes and preserves an immutable backup at ${plan.backupPath}.`
  );
}

function isLegacyStorageError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("unversioned RAGnarōk storage");
}

function isStorageLockError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "StorageLockHeldError" || error.message.includes("locked by another RAGnarōk process"))
  );
}

export function createDefaultMigrationUx(createTopicManager: () => Promise<TopicManager>): MigrationUxDependencies {
  return {
    createTopicManager,
    plan: planStorageMigration,
    status: getStorageMigrationStatus,
    apply: applyStorageMigration,
    resume: resumeStorageMigration,
    choose: async (plan, summary) => {
      let choice = await vscode.window.showWarningMessage(summary, { modal: true }, "Preview", "Migrate");
      if (choice === "Preview") {
        choice = await vscode.window.showInformationMessage(
          `${summary}\n\n${plan.warnings.join("\n")}`,
          { modal: true },
          "Migrate",
        );
      }
      return choice === "Migrate" ? "migrate" : "cancel";
    },
    progress: async (resuming, task) => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: resuming ? "Resuming RAGnarōk storage migration" : "Migrating RAGnarōk storage",
          cancellable: !resuming,
        },
        async (_progress, token) => {
          const controller = new AbortController();
          if (token.isCancellationRequested) {
            controller.abort(new Error("Storage migration cancelled before cutover"));
          }
          const cancellation = token.onCancellationRequested(() =>
            controller.abort(new Error("Storage migration cancelled before cutover")),
          );
          try {
            await task(controller.signal);
          } finally {
            cancellation.dispose();
          }
        },
      );
    },
    showStorageFailure: async (message) => {
      await vscode.window.showErrorMessage(message, { modal: true });
    },
    showCancellation: async (message) => {
      await vscode.window.showInformationMessage(message);
    },
  };
}

/**
 * Open storage, invoking the guided offline migrator only for a provable v0.3
 * local layout. Every other corruption/lock condition remains fail-closed.
 */
export async function openTopicManagerWithMigration(
  storageDir: string,
  dependencies: MigrationUxDependencies,
): Promise<TopicManager> {
  try {
    return await dependencies.createTopicManager();
  } catch (error) {
    if (isStorageLockError(error)) {
      await dependencies.showStorageFailure(
        "RAGnarōk storage is already open in another VS Code window. Close that window and retry. No data was changed.",
      );
      throw error;
    }
    if (!isLegacyStorageError(error)) {
      await dependencies.showStorageFailure(
        `RAGnarōk storage could not be opened safely: ${
          error instanceof Error ? error.message : String(error)
        }. No data was changed.`,
      );
      throw error;
    }

    let plan: StorageMigrationPlan;
    try {
      plan = await dependencies.plan(storageDir);
    } catch (planError) {
      await dependencies.showStorageFailure(
        `Legacy storage inspection failed: ${
          planError instanceof Error ? planError.message : String(planError)
        }. No data was changed.`,
      );
      throw planError;
    }
    if (plan.layout !== "v0.3-local" || plan.unsupported.length > 0) {
      const unsupported = plan.unsupported.join("; ") || plan.layout;
      await dependencies.showStorageFailure(
        `Legacy storage cannot be migrated automatically: ${unsupported}. No data was changed.`,
      );
      throw new Error(`Legacy storage cannot be migrated automatically: ${unsupported}`);
    }

    const summary = migrationSummary(plan);
    if ((await dependencies.choose(plan, summary)) !== "migrate") {
      await dependencies.showCancellation("RAGnarōk storage migration was cancelled. No data was changed.");
      throw error;
    }

    try {
      const status = await dependencies.status(storageDir, plan.migrationId);
      await dependencies.progress(Boolean(status.state), async (signal) => {
        signal.throwIfAborted();
        if (status.state) {
          await dependencies.resume(storageDir, plan.migrationId);
        } else {
          await dependencies.apply(storageDir, {
            acceptedBackupPath: plan.backupPath,
            signal,
          });
        }
      });
    } catch (migrationError) {
      if (
        (migrationError instanceof Error && migrationError.name === "AbortError") ||
        (migrationError instanceof Error && migrationError.message.includes("cancelled before cutover"))
      ) {
        await dependencies.showCancellation("RAGnarōk storage migration was cancelled before cutover.");
      } else {
        await dependencies.showStorageFailure(
          `RAGnarōk storage migration failed: ${
            migrationError instanceof Error ? migrationError.message : String(migrationError)
          }. No in-place reset was performed. Inspect migration status before retrying; an interrupted validated cutover may require resume.`,
        );
      }
      throw migrationError;
    }

    return dependencies.createTopicManager();
  }
}
