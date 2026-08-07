#!/usr/bin/env node

import {
  StorageMigrationError,
  applyStorageMigration,
  getStorageMigrationStatus,
  planStorageMigration,
  resumeStorageMigration,
  rollbackStorageMigration,
} from "./utils/storageMigration";

const EXIT_CODES: Record<string, number> = {
  MIG_ALREADY_V2: 10,
  MIG_EMPTY: 11,
  MIG_CORRUPT: 20,
  MIG_UNSUPPORTED: 21,
  MIG_COLLISION: 22,
  MIG_SPACE: 30,
  MIG_CHANGED: 31,
  MIG_BUSY: 32,
  MIG_CONFIRMATION: 33,
  MIG_VALIDATION: 40,
  MIG_CUTOVER: 50,
  MIG_NOT_FOUND: 60,
};

interface CliOptions {
  command: "status" | "dry-run" | "apply" | "resume" | "rollback";
  storage?: string;
  migrationId?: string;
  json: boolean;
  nonInteractive: boolean;
  acceptedBackupPath?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv[0] === "migrate" ? argv.slice(1) : argv;
  let command: CliOptions["command"] | undefined;
  let storage: string | undefined;
  let migrationId: string | undefined;
  let acceptedBackupPath: string | undefined;
  let json = false;
  let nonInteractive = false;
  let commandCount = 0;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--storage") {
      storage = args[++index];
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "--non-interactive") {
      nonInteractive = true;
    } else if (argument === "--accept-backup-path") {
      acceptedBackupPath = args[++index];
    } else if (argument === "--dry-run") {
      command = "dry-run";
      commandCount++;
    } else if (argument === "--apply") {
      command = "apply";
      commandCount++;
    } else if (argument === "--status") {
      command = "status";
      commandCount++;
    } else if (argument === "--resume") {
      command = "resume";
      migrationId = args[++index];
      commandCount++;
    } else if (argument === "--rollback") {
      command = "rollback";
      migrationId = args[++index];
      commandCount++;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!storage) {
    throw new Error("--storage is required");
  }
  if (!command || commandCount !== 1) {
    throw new Error("Choose exactly one of --status, --dry-run, --apply, --resume <id>, or --rollback <id>");
  }
  if ((command === "resume" || command === "rollback") && !migrationId) {
    throw new Error(`${command} requires a migration ID`);
  }
  return { command, storage, migrationId, json, nonInteractive, acceptedBackupPath };
}

function output(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  let result: unknown;
  switch (options.command) {
    case "status":
      result = await getStorageMigrationStatus(options.storage!, options.migrationId);
      break;
    case "dry-run":
      result = await planStorageMigration(options.storage!);
      break;
    case "apply":
      if (!options.nonInteractive) {
        throw new StorageMigrationError(
          "MIG_CONFIRMATION",
          "The standalone CLI is intentionally non-interactive; pass --non-interactive and the exact --accept-backup-path from dry-run",
        );
      }
      result = await applyStorageMigration(options.storage!, {
        acceptedBackupPath: options.acceptedBackupPath,
        nonInteractive: true,
      });
      break;
    case "resume":
      result = await resumeStorageMigration(options.storage!, options.migrationId!);
      break;
    case "rollback":
      result = await rollbackStorageMigration(options.storage!, options.migrationId!);
      break;
  }
  output({ ok: true, command: options.command, result }, options.json);
}

void main().catch((error: unknown) => {
  const code = error instanceof StorageMigrationError ? error.code : "MIG_INTERNAL";
  const exitCode = EXIT_CODES[code] ?? 70;
  const json = process.argv.includes("--json");
  output(
    {
      ok: false,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    },
    json,
  );
  process.exitCode = exitCode;
});
