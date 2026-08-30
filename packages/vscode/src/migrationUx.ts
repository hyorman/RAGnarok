import * as vscode from "vscode";
import {
  applyStorageMigration,
  findLatestMigrationState,
  inspectStorage,
  prepareStorageMigration,
  resumeStorageMigration,
  rollbackStorageMigration,
  StorageFormatVersionError,
  STORAGE_FORMAT_VERSION,
  type MigrationReport,
  type PreparedStorageMigration,
  type StorageMigrationPlan,
  type TopicManager,
} from "@ragnarok/core";

export interface MigrationUxDependencies {
  createTopicManager(): Promise<TopicManager>;
  inspect: typeof inspectStorage;
  prepare: typeof prepareStorageMigration;
  findState: typeof findLatestMigrationState;
  apply(
    storageDir: string,
    options: { prepared?: PreparedStorageMigration; acceptedBackupPath: string; signal: AbortSignal },
  ): Promise<MigrationReport>;
  resume(storageDir: string, migrationId: string): Promise<MigrationReport>;
  rollback: typeof rollbackStorageMigration;
  progress(resuming: boolean, task: (signal: AbortSignal) => Promise<void>): Promise<void>;
  showStorageFailure(message: string): Promise<void>;
  showInformation(message: string): Promise<void>;
}

/**
 * Stages a crash can leave behind *before* anything has moved out of the source
 * tree. They are not "interrupted" in the fail-closed sense — the store still
 * reads as plain legacy data — but a stale state file and staging directory
 * exist, and a fresh apply would collide with them. Resume clears both.
 */
const RESUMABLE_PRE_CUTOVER_STAGES = new Set(["planned", "staged", "validated"]);

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

function isStorageLockError(error: unknown): boolean {
  return error instanceof Error && error.name === "StorageLockHeldError";
}

export function createDefaultMigrationUx(createTopicManager: () => Promise<TopicManager>): MigrationUxDependencies {
  return {
    createTopicManager,
    inspect: inspectStorage,
    prepare: prepareStorageMigration,
    findState: findLatestMigrationState,
    apply: applyStorageMigration,
    resume: resumeStorageMigration,
    rollback: rollbackStorageMigration,
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
 * Classify the store first, then open it — never the reverse.
 *
 * Inferring the storage state from an open failure could only ever see the
 * conditions that make opening fail, which left an interrupted migration
 * stranded until someone ran the CLI by hand. Inspection is read-only and
 * lock-free, so activation can decide to resume, roll back, or convert before
 * any handle exists.
 *
 * Migration itself runs unattended because it is recoverable, not because it is
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
  const inspection = await dependencies.inspect(storageDir);

  if (inspection.status === "interrupted") {
    // Stage decides the entry point, and the two are not interchangeable:
    // resume() only understands forward states, so routing a rollback stage
    // through it would re-run the forward migration over a half-restored tree.
    const interruptedRollback = inspection.stage.startsWith("rollback");
    try {
      await dependencies.progress(true, async () => {
        if (interruptedRollback) {
          await dependencies.rollback(storageDir, inspection.migrationId);
        } else {
          await dependencies.resume(storageDir, inspection.migrationId);
        }
      });
      await dependencies.showInformation(
        interruptedRollback
          ? `RAGnarōk completed an interrupted storage rollback (${inspection.migrationId}).`
          : `RAGnarōk resumed and completed an interrupted storage migration (${inspection.migrationId}).`,
      );
    } catch (resumeError) {
      await dependencies.showStorageFailure(
        `RAGnarōk could not recover the interrupted storage ${interruptedRollback ? "rollback" : "migration"} ` +
          `${inspection.migrationId} (stage ${inspection.stage}): ` +
          `${resumeError instanceof Error ? resumeError.message : String(resumeError)}. ` +
          `Your data is intact — the original store is preserved (see the migration state file at ` +
          `${inspection.statePath} for the exact backup location). Reload the window to retry.`,
      );
      throw resumeError;
    }
    if (interruptedRollback) {
      // A completed rollback republishes the 0.3 tree; one re-entry routes it
      // through the legacy branch (its state is now `rolledBack`, which
      // classifies as legacy data with an ignorable state file — no loop).
      return openTopicManagerWithMigration(storageDir, dependencies);
    }
    return dependencies.createTopicManager();
  }

  if (inspection.status === "legacy") {
    const pending = await dependencies.findState(storageDir);
    if (pending && RESUMABLE_PRE_CUTOVER_STAGES.has(pending.state.stage)) {
      try {
        await dependencies.progress(true, async () => {
          await dependencies.resume(storageDir, pending.state.migrationId);
        });
      } catch (resumeError) {
        await dependencies.showStorageFailure(
          `RAGnarōk could not resume a previously started storage migration ` +
            `(${pending.state.migrationId}, stage ${pending.state.stage}): ` +
            `${resumeError instanceof Error ? resumeError.message : String(resumeError)}. No data was changed.`,
        );
        throw resumeError;
      }
      await dependencies.showInformation(
        `RAGnarōk resumed and completed an interrupted storage migration (${pending.state.migrationId}).`,
      );
      return dependencies.createTopicManager();
    }
    let prepared: PreparedStorageMigration;
    try {
      prepared = await dependencies.prepare(storageDir);
    } catch (planError) {
      await dependencies.showStorageFailure(
        `Legacy storage inspection failed: ${
          planError instanceof Error ? planError.message : String(planError)
        }. No data was changed.`,
      );
      throw planError;
    }
    if (prepared.plan.layout !== "v0.3-local" || prepared.plan.unsupported.length > 0) {
      const unsupported = prepared.plan.unsupported.join("; ") || prepared.plan.layout;
      await dependencies.showStorageFailure(
        `Legacy storage cannot be migrated automatically: ${unsupported}. No data was changed.`,
      );
      throw new Error(`Legacy storage cannot be migrated automatically: ${unsupported}`);
    }
    try {
      await dependencies.progress(false, async (signal) => {
        signal.throwIfAborted();
        // The prepared handle carries the conversion this pass already ran:
        // apply reuses it instead of converting the whole corpus a second time.
        await dependencies.apply(storageDir, {
          prepared,
          acceptedBackupPath: prepared.plan.backupPath,
          signal,
        });
      });
    } catch (migrationError) {
      if (
        (migrationError instanceof Error && migrationError.name === "AbortError") ||
        (migrationError instanceof Error && migrationError.message.includes("cancelled before cutover"))
      ) {
        await dependencies.showInformation("RAGnarōk storage migration was cancelled before cutover.");
      } else if ((migrationError as { code?: string })?.code === "MIG_BUSY") {
        // Inspection is lock-free, so two fresh windows can race into
        // migration; the loser is told to wait, not shown a failure.
        await dependencies.showStorageFailure(
          "Another VS Code window is migrating this storage. Reload this window when it finishes.",
        );
      } else {
        await dependencies.showStorageFailure(
          `RAGnarōk storage migration failed: ${
            migrationError instanceof Error ? migrationError.message : String(migrationError)
          }. No in-place reset was performed; the next activation will resume or retry automatically.`,
        );
      }
      throw migrationError;
    }
    // Unattended does not mean unannounced: the backup path is the user's only
    // route back, so it is reported rather than left in the migration report.
    await dependencies.showInformation(migrationSummary(prepared.plan));
    return dependencies.createTopicManager();
  }

  if (inspection.status === "future-version") {
    await dependencies.showStorageFailure(
      `This storage was written by a newer RAGnarōk (format ${String(
        inspection.foundVersion,
      )}). Update the extension. No data was changed.`,
    );
    throw new StorageFormatVersionError(inspection.foundVersion, STORAGE_FORMAT_VERSION);
  }
  if (inspection.status === "reset-interrupted") {
    await dependencies.showStorageFailure(
      "A previous storage reset was interrupted. The data was moved to a backup-v1-* folder inside the storage directory; restore or remove it, then reload.",
    );
    throw new Error("Storage reset interrupted");
  }

  // "current" | "empty": open normally. The lock/other failures keep their
  // existing typed handling.
  try {
    return await dependencies.createTopicManager();
  } catch (error) {
    if (isStorageLockError(error)) {
      await dependencies.showStorageFailure(
        "A RAGnarōk storage migration or reset is running in another window. Wait for it to finish, then reload this window.",
      );
    } else {
      await dependencies.showStorageFailure(
        `RAGnarōk storage could not be opened safely: ${
          error instanceof Error ? error.message : String(error)
        }. No data was changed.`,
      );
    }
    throw error;
  }
}
