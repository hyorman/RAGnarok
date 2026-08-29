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

export interface MigrationUxDependencies {
  createTopicManager(): Promise<TopicManager>;
  plan(storageDir: string): Promise<StorageMigrationPlan>;
  status(storageDir: string, migrationId: string): ReturnType<typeof getStorageMigrationStatus>;
  apply(storageDir: string, options: { acceptedBackupPath: string; signal: AbortSignal }): Promise<MigrationReport>;
  resume(storageDir: string, migrationId: string): Promise<MigrationReport>;
  progress(resuming: boolean, task: (signal: AbortSignal) => Promise<void>): Promise<void>;
  showStorageFailure(message: string): Promise<void>;
  showInformation(message: string): Promise<void>;
}

function migrationSummary(plan: StorageMigrationPlan): string {
  return (
    `Migrated legacy RAGnarōk 0.3 storage: ${plan.topics.length} topic(s), ` +
    `${plan.topics.reduce((sum, topic) => sum + topic.leafDocumentCount, 0)} document leaf/leaves, ` +
    `${plan.topics.reduce((sum, topic) => sum + topic.chunkCount, 0)} chunk(s). ` +
    `The original storage is kept as an immutable backup at ${plan.backupPath}.` +
    (plan.warnings.length ? " Warnings: " + plan.warnings.join(" ") : "") +
    (plan.remaps.length > 0 ? ` ${plan.remaps.length} ID(s) were remapped (see migration report).` : "")
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
    showInformation: async (message) => {
      await vscode.window.showInformationMessage(message);
    },
  };
}

/**
 * Open storage, converting a provable v0.3 local layout in place without asking.
 * Every other corruption/lock condition remains fail-closed.
 *
 * Migration runs unattended because it is recoverable, not because it is
 * trivial: conversion happens in a staging directory, is validated before
 * cutover, and the original tree survives as an immutable checksummed backup
 * that `ragnarok-migrate --rollback` restores. A prompt on every window open
 * bought the user no safety they do not already have, and declining it left the
 * extension unusable until the next reload.
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
        await dependencies.showInformation("RAGnarōk storage migration was cancelled before cutover.");
      } else {
        await dependencies.showStorageFailure(
          `RAGnarōk storage migration failed: ${
            migrationError instanceof Error ? migrationError.message : String(migrationError)
          }. No in-place reset was performed. Inspect migration status before retrying; an interrupted validated cutover may require resume.`,
        );
      }
      throw migrationError;
    }

    // Unattended does not mean unannounced: the backup path is the user's only
    // route back, so it is reported rather than left in the migration report.
    await dependencies.showInformation(migrationSummary(plan));
    return dependencies.createTopicManager();
  }
}
