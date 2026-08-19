#!/usr/bin/env node

/**
 * Synchronize version across all package.json files in the monorepo.
 *
 * Usage:
 *   node scripts/version-sync.js <version>
 *   node scripts/version-sync.js            # prints current versions
 *
 * Updates:
 *   - Root package.json (VS Code extension manifest)
 *   - packages/core/package.json
 *   - packages/vscode/package.json
 *   - packages/mcp-server/package.json
 *   - packages/graph-ui/package.json
 *   - Inter-package dependency pins (@ragnarok/core)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const PACKAGE_FILES = [
  path.join(ROOT, "package.json"),
  path.join(ROOT, "packages/core/package.json"),
  path.join(ROOT, "packages/vscode/package.json"),
  path.join(ROOT, "packages/mcp-server/package.json"),
  // Private, but it pins @ragnarok/core: omitting it leaves that pin on the
  // previous version and breaks `npm install` after every bump.
  path.join(ROOT, "packages/graph-ui/package.json"),
];

const INTERNAL_PACKAGES = ["@ragnarok/core"];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function printVersions() {
  console.log("Current versions:");
  for (const file of PACKAGE_FILES) {
    const pkg = readJson(file);
    const rel = path.relative(ROOT, file);
    console.log(`  ${rel}: ${pkg.version}`);
  }
}

function syncVersions(newVersion) {
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(newVersion)) {
    console.error(`Invalid version: "${newVersion}". Expected semver (e.g. 1.2.3 or 1.2.3-beta.1)`);
    process.exit(1);
  }

  for (const file of PACKAGE_FILES) {
    const pkg = readJson(file);
    const oldVersion = pkg.version;
    pkg.version = newVersion;

    // Update inter-package dependency pins
    for (const depKey of ["dependencies", "devDependencies", "peerDependencies"]) {
      if (pkg[depKey]) {
        for (const internalPkg of INTERNAL_PACKAGES) {
          if (pkg[depKey][internalPkg]) {
            pkg[depKey][internalPkg] = newVersion;
          }
        }
      }
    }

    writeJson(file, pkg);
    const rel = path.relative(ROOT, file);
    console.log(`  ${rel}: ${oldVersion} → ${newVersion}`);
  }

  console.log(`\nAll packages synced to ${newVersion}`);
}

// Main
const newVersion = process.argv[2];

if (!newVersion) {
  printVersions();
} else {
  console.log(`Syncing all packages to version ${newVersion}:`);
  syncVersions(newVersion);
}
