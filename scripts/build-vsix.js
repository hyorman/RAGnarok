#!/usr/bin/env node

/**
 * Build a platform-specific VSIX in an isolated staging directory.
 *
 * This replaces the mutate-in-place approach (install-platform-deps.js + vsce package)
 * with a clean staging workflow:
 *
 *   1. Clean and rebuild all extension output
 *   2. Create a unique staging directory with the exact workspace manifests and lockfile
 *   2. Copy extension bundle, assets, and metadata
 *   3. npm ci --omit=dev for the target OS/CPU
 *   4. Install target-platform native binaries
 *   5. Prune bloat (maps, unused pdf.js versions, onnxruntime-node platforms, langchain nested)
 *   6. vsce package from the staging directory
 *   7. Copy VSIX back, clean up staging
 *
 * Benefits:
 *   - Development node_modules never mutated
 *   - No gutting hacks (npm list not needed since no stubs)
 *   - Reproducible builds
 *   - Every dependency resolution is bound to package-lock.json
 */

const fs = require("fs");
const path = require("path");
const { execFileSync, execSync } = require("child_process");
const https = require("https");
const os = require("os");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");

/**
 * Run a Node CLI by its JavaScript entry point instead of its launcher script.
 *
 * On Windows both npm and vsce exist only as `.cmd` shims, and neither way of
 * reaching them from Node works:
 *
 *   - spawning `npm` fails with ENOENT, because execFileSync does not consult
 *     PATHEXT and there is no extension-less executable;
 *   - spawning `npm.cmd` fails with EINVAL, because Node refuses to execute
 *     `.cmd`/`.bat` files without a shell (the fix for CVE-2024-27980).
 *
 * `shell: true` would satisfy both, at the price of putting every argument and
 * the program path through cmd.exe — where a space in the repository path, or
 * in the Windows temp directory, becomes a quoting bug. These are Node programs,
 * so the portable answer is to run them the way Node runs anything: hand the
 * script to the current interpreter. Same call on all six targets, no shell, no
 * quoting, and the exact Node already in use.
 */
function runNodeScript(scriptPath, args, options = {}) {
  return execFileSync(process.execPath, [scriptPath, ...args], options);
}

/** npm's CLI entry, which ships beside the running Node rather than in the project. */
function resolveNpmCli() {
  // npm sets npm_execpath to its own CLI when it runs a script, and this build
  // is always reached through `npm run package*`. It is the only source that
  // stays correct under nvm-windows, fnm and Volta, where node.exe is a shim
  // with no npm beside it.
  const fromNpm = process.env.npm_execpath;
  if (fromNpm && fromNpm.endsWith(".js") && fs.existsSync(fromNpm)) {
    return fromNpm;
  }

  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    // Windows: npm sits next to node.exe.
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    // POSIX: node lives in bin/, npm one level up in lib/.
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    return require.resolve("npm/bin/npm-cli.js");
  } catch {
    throw new Error(
      "Could not locate npm's CLI entry point (npm-cli.js) beside " +
        `${process.execPath}. The VSIX build shells npm through Node to stay portable across ` +
        "platforms; report this with your Node installation layout.",
    );
  }
}

/** A CLI installed as a project dependency, resolved to its bin script. */
function resolveDependencyBin(packageName, binName) {
  const manifestPath = require.resolve(`${packageName}/package.json`, { paths: [ROOT] });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const relative = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];
  if (!relative) {
    throw new Error(`${packageName} declares no "${binName}" bin`);
  }
  return path.join(path.dirname(manifestPath), relative);
}

// ---------------------------------------------------------------------------
// 1. Parse target platform
// ---------------------------------------------------------------------------

function getTargetPlatform() {
  const target = process.argv[2] || process.env.VSCE_TARGET || process.env.TARGET;
  if (!target) {
    console.error("Usage: node build-vsix.js <target>\n" + "Examples: darwin-arm64, linux-x64, win32-x64");
    process.exit(1);
  }

  const [platform, arch] = target.split("-");
  const validPlatforms = ["darwin", "linux", "win32"];
  const validArchs = ["arm64", "x64"];

  if (!validPlatforms.includes(platform) || !validArchs.includes(arch)) {
    console.error(`Invalid target: ${target}. Expected {platform}-{arch}`);
    process.exit(1);
  }

  // LanceDB uses variants like linux-x64-gnu, win32-x64-msvc
  const patterns = [target];
  if (platform === "linux") patterns.push(`${target}-gnu`);
  if (platform === "win32") patterns.push(`${target}-msvc`);

  return { platform, arch, target, patterns };
}

// ---------------------------------------------------------------------------
// 2. Create staging directory
// ---------------------------------------------------------------------------

function createStagingDir(target) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ragnarok-vsix-${target}-${process.pid}-`));
}

function createStagingPackageJson(stagingDir, targetPlatform) {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  // The source tree was clean-built immediately before staging. VSCE otherwise
  // reruns this hook inside the deliberately source-free staging tree, where
  // workspace tsconfig/source files do not exist.
  delete rootPkg.scripts?.["vscode:prepublish"];
  fs.writeFileSync(path.join(stagingDir, "package.json"), JSON.stringify(rootPkg, null, 2) + "\n");
  fs.copyFileSync(path.join(ROOT, "package-lock.json"), path.join(stagingDir, "package-lock.json"));

  // npm ci validates every declared workspace. Copy only manifests and the
  // already-clean build output; source files never enter the staged VSIX.
  for (const workspace of rootPkg.workspaces || []) {
    const source = path.join(ROOT, workspace);
    const target = path.join(stagingDir, workspace);
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(path.join(source, "package.json"), path.join(target, "package.json"));
    const dist = path.join(source, "dist");
    if (fs.existsSync(dist)) copyDirSync(dist, path.join(target, "dist"));
  }
}

// ---------------------------------------------------------------------------
// 3. Copy extension files to staging
// ---------------------------------------------------------------------------

function copyToStaging(stagingDir) {
  const filesToCopy = [
    "README.md",
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_MODELS.md",
    "ARCHITECTURE.md",
    ".vscodeignore",
    ".npmrc",
    "bom.cdx.json",
    "bom.spdx.json",
    "release-policy.json",
  ];
  for (const file of filesToCopy) {
    const src = path.join(ROOT, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(stagingDir, file));
    }
  }

  // Copy directories
  const dirsToCopy = ["dist", "assets", "stubs"];
  for (const dir of dirsToCopy) {
    const src = path.join(ROOT, dir);
    if (fs.existsSync(src)) {
      copyDirSync(src, path.join(stagingDir, dir));
    }
  }

  // Bundled ONNX models live in the core package (shipped with the npm
  // package); stage them under assets/models where findAssetsModelsDir()
  // expects them relative to the extension bundle.
  const modelsSrc = path.join(ROOT, "packages", "core", "assets", "models");
  if (fs.existsSync(modelsSrc)) {
    copyDirSync(modelsSrc, path.join(stagingDir, "assets", "models"));
  }
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function verifyStagedModels(stagingDir) {
  const modelsDir = path.join(stagingDir, "assets", "models");
  const manifestPath = path.join(modelsDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing staged model manifest: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error("Staged model manifest has no artifacts");
  }
  for (const artifact of manifest.artifacts) {
    const filePath = path.resolve(modelsDir, artifact.filename);
    if (!filePath.startsWith(modelsDir + path.sep) || !fs.existsSync(filePath)) {
      throw new Error(`Missing or invalid staged model artifact: ${artifact.filename}`);
    }
    const actual = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    if (actual !== artifact.sha256) {
      // Distinguish the two ways this fails, because the fixes are opposite.
      // A staged copy shorter than its source means the copy was interrupted —
      // almost always a full disk, since staging also holds a production
      // node_modules and the ~200 MB VSIX. A staged copy that matches its
      // source byte-for-byte means the source itself no longer matches the
      // manifest, which is a real integrity problem.
      const sourcePath = path.join(ROOT, "packages", "core", "assets", "models", artifact.filename);
      const stagedBytes = fs.statSync(filePath).size;
      const sourceBytes = fs.existsSync(sourcePath) ? fs.statSync(sourcePath).size : null;
      if (sourceBytes !== null && stagedBytes !== sourceBytes) {
        throw new Error(
          `Staged model copy is incomplete: ${artifact.filename} ` +
            `(${stagedBytes} of ${sourceBytes} bytes). The staging directory is on the temp volume — ` +
            `check free disk space and retry.`,
        );
      }
      throw new Error(
        `Staged model checksum mismatch: ${artifact.filename}. The staged copy matches its source, so ` +
          `the source artifact no longer matches assets/models/manifest.json.`,
      );
    }
  }
  console.log(`Verified ${manifest.artifacts.length} staged model artifacts.`);
}

// ---------------------------------------------------------------------------
// 4. npm install in staging
// ---------------------------------------------------------------------------

function npmInstallStaging(stagingDir, targetPlatform) {
  console.log("\nInstalling exact production dependency tree from package-lock.json...");
  runNodeScript(
    resolveNpmCli(),
    [
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `--os=${targetNpmPlatform(targetPlatform.platform)}`,
      `--cpu=${targetPlatform.arch}`,
    ],
    {
      cwd: stagingDir,
      stdio: "inherit",
      env: { ...process.env, npm_config_install_strategy: "shallow" },
    },
  );
}

function targetNpmPlatform(platform) {
  return platform === "win32" ? "win32" : platform;
}

// ---------------------------------------------------------------------------
// 5. Platform-specific native deps
// ---------------------------------------------------------------------------

const PLATFORM_PACKAGE_CONFIGS = [
  { scope: "@lancedb", prefix: "lancedb-", description: "LanceDB", expectedCount: 1 },
  { scope: "@img", prefix: "sharp-", description: "Sharp", expectedCount: 1 },
  { scope: "@img", prefix: "sharp-libvips-", description: "Sharp libvips", expectedCount: 1 },
];

function getNativePackageConfig(packageName) {
  const [scope, name, ...extra] = packageName.split("/");
  if (!scope || !name || extra.length > 0) return undefined;
  return PLATFORM_PACKAGE_CONFIGS.filter((config) => config.scope === scope && name.startsWith(config.prefix)).sort(
    (left, right) => right.prefix.length - left.prefix.length,
  )[0];
}

function expectedNativePackageName(config, targetPlatform) {
  let suffix = targetPlatform.target;
  if (config.scope === "@lancedb" && targetPlatform.platform === "linux") suffix += "-gnu";
  if (config.scope === "@lancedb" && targetPlatform.platform === "win32") suffix += "-msvc";
  return `${config.scope}/${config.prefix}${suffix}`;
}

function matchesTargetPlatform(packageName, patterns) {
  const parts = packageName.split("/");
  if (parts.length !== 2) return false;
  const name = parts[1];
  return patterns.some((p) => {
    const idx = name.indexOf(p);
    if (idx === -1) return false;
    const rest = name.substring(idx + p.length);
    return rest === "" || rest.startsWith("-");
  });
}

async function installNativeDeps(stagingDir, targetPlatform) {
  console.log("\nInstalling platform-specific native binaries...");
  const nodeModules = path.join(stagingDir, "node_modules");
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));

  const declaredDependencies = {
    ...(rootPkg.dependencies || {}),
    ...(rootPkg.optionalDependencies || {}),
  };
  const platformDeps = PLATFORM_PACKAGE_CONFIGS.map((config) => {
    const name = expectedNativePackageName(config, targetPlatform);
    const version = declaredDependencies[name];
    if (!version) {
      throw new Error(`Missing declared target native package: ${name}`);
    }
    return { name, version: version.replace(/^[\^~]/, ""), config };
  });

  for (const { name, version, config } of platformDeps) {
    const scopeDir = path.join(nodeModules, config.scope);
    fs.mkdirSync(scopeDir, { recursive: true });
    const packageDir = path.join(scopeDir, name.split("/")[1]);

    if (fs.existsSync(packageDir)) {
      console.log(`  ✓ ${name} already installed`);
      removePlatformRestrictions(packageDir);
      continue;
    }

    const locked = lock.packages?.[`node_modules/${name}`];
    if (!locked || locked.version !== version || !locked.resolved || !locked.integrity) {
      throw new Error(`No exact lockfile resolution/integrity for ${name}@${version}`);
    }
    fs.mkdirSync(packageDir, { recursive: true });
    await downloadAndExtract(locked.resolved, locked.integrity, packageDir, name);
    removePlatformRestrictions(packageDir);
    console.log(`  ✓ ${name} installed from verified lockfile artifact`);
  }
  verifyNativePackages(nodeModules, targetPlatform, platformDeps);
}

function removePlatformRestrictions(packageDir) {
  const pkgPath = path.join(packageDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    delete pkg.os;
    delete pkg.cpu;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  }
}

function downloadAndExtract(tarball, integrity, targetDir, packageName) {
  return new Promise((resolve, reject) => {
    const follow = (url, redirects = 0) => {
      if (redirects > 5) {
        reject(new Error(`Too many redirects for ${packageName}`));
        return;
      }
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") {
        reject(new Error(`Refusing non-HTTPS native artifact URL for ${packageName}`));
        return;
      }
      https
        .get(parsed, (res) => {
          if ([301, 302, 307, 308].includes(res.statusCode)) {
            if (!res.headers.location) return reject(new Error(`Redirect without location for ${packageName}`));
            follow(new URL(res.headers.location, parsed).href, redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            return;
          }
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            try {
              const archive = Buffer.concat(chunks);
              verifyIntegrity(archive, integrity, packageName);
              const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-native-"));
              const archivePath = path.join(tempDir, "package.tgz");
              fs.writeFileSync(archivePath, archive);
              try {
                const listing = execFileSync("tar", ["tzf", archivePath], { encoding: "utf8" });
                for (const member of listing.split(/\r?\n/).filter(Boolean)) assertSafeArchiveMember(member);
                const verboseListing = execFileSync("tar", ["tvzf", archivePath], { encoding: "utf8" });
                for (const line of verboseListing.split(/\r?\n/).filter(Boolean)) {
                  if (line.startsWith("l") || line.startsWith("h")) {
                    throw new Error(`Native archive contains a link entry: ${line}`);
                  }
                }
                execFileSync("tar", ["xzf", archivePath, "-C", targetDir, "--strip-components=1"], {
                  stdio: "inherit",
                });
              } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
              }
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        })
        .on("error", reject);
    };
    follow(tarball);
  });
}

function verifyIntegrity(contents, integrity, packageName) {
  const candidates = integrity.split(/\s+/);
  const selected =
    candidates.find((value) => value.startsWith("sha512-")) || candidates.find((value) => value.startsWith("sha256-"));
  if (!selected) throw new Error(`Unsupported integrity algorithm for ${packageName}`);
  const [algorithm, expected] = selected.split("-", 2);
  const actual = crypto.createHash(algorithm).update(contents).digest("base64");
  if (!crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
    throw new Error(`Integrity mismatch for ${packageName}`);
  }
}

function assertSafeArchiveMember(member) {
  const normalized = member.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Native archive contains absolute path: ${member}`);
  }
  if (normalized.split("/").includes("..")) {
    throw new Error(`Native archive contains traversal path: ${member}`);
  }
}

function verifyNativePackages(nodeModules, targetPlatform, expected) {
  if (expected.length !== PLATFORM_PACKAGE_CONFIGS.length) {
    throw new Error(`Expected ${PLATFORM_PACKAGE_CONFIGS.length} target native packages, resolved ${expected.length}`);
  }
  for (const config of PLATFORM_PACKAGE_CONFIGS) {
    const scopeDir = path.join(nodeModules, config.scope);
    const expectedBasename = expectedNativePackageName(config, targetPlatform).split("/")[1];
    const matches = fs.existsSync(scopeDir) ? fs.readdirSync(scopeDir).filter((name) => name === expectedBasename) : [];
    if (matches.length !== config.expectedCount) {
      throw new Error(
        `${config.description}: expected ${config.expectedCount} ${targetPlatform.target} package, found ${matches.length}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Prune bloat
// ---------------------------------------------------------------------------

// @langchain/community is allowlisted into the VSIX, but we only import a
// handful of CommonJS runtime entrypoints. Prune the package down to the
// exact runtime files we need, while preserving the nested node_modules tree
// for the separate gutting step below.
const LANGCHAIN_COMMUNITY_KEEP_PATHS = [
  "package.json",
  "LICENSE",
  "node_modules",
  "dist/_virtual/_rolldown/runtime.cjs",
  "dist/utils/extname.cjs",
  "dist/utils/@furkantoprak/bm25/BM25.cjs",
  "dist/document_loaders/web/github.cjs",
  "dist/document_loaders/web/cheerio.cjs",
  "dist/document_loaders/fs/pdf.cjs",
  "dist/retrievers/bm25.cjs",
  "dist/vectorstores/lancedb.cjs",
];

function pruneBloat(stagingDir, targetPlatform) {
  console.log("\nPruning package bloat...");
  const nm = path.join(stagingDir, "node_modules");

  // Remove non-target onnxruntime-node platform binaries
  pruneOnnxruntimeNode(nm, targetPlatform);
  prunePlatformNativePackages(nm, targetPlatform);
  removeMcpWorkspace(stagingDir);
  relaxUnmetPeerDependencies(nm);

  // Remove HuggingFace model cache (shouldn't exist in clean install, but just in case)
  const hfCache = path.join(nm, "@huggingface", "transformers", ".cache");
  if (fs.existsSync(hfCache)) {
    fs.rmSync(hfCache, { recursive: true, force: true });
    console.log("  ✓ Removed .cache");
  }

  // Remove unused pdf.js versions from pdf-parse (~24MB) — keep only v1.10.100
  const pdfJsDir = path.join(nm, "pdf-parse", "lib", "pdf.js");
  if (fs.existsSync(pdfJsDir)) {
    const KEEP_PDFJS = "v1.10.100";
    let removedVersions = 0;
    for (const entry of fs.readdirSync(pdfJsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== KEEP_PDFJS) {
        fs.rmSync(path.join(pdfJsDir, entry.name), { recursive: true, force: true });
        removedVersions++;
      }
    }
    if (removedVersions > 0) console.log(`  ✓ Removed ${removedVersions} unused pdf.js versions (kept ${KEEP_PDFJS})`);
  }

  const communityPruneResult = pruneLangchainCommunityPackage(nm);
  if (communityPruneResult) {
    console.log(
      `  ✓ Pruned @langchain/community to required runtime files ` +
        `(removed ${communityPruneResult.files} files and ${communityPruneResult.directories} directories)`,
    );
  }

  // Remove .map source maps from all packages included in VSIX
  let mapCount = 0;
  const topLevelScopes = [
    "@huggingface",
    "@langchain",
    "@lancedb",
    "@img",
    "apache-arrow",
    "pdf-parse",
    "cheerio",
    "archiver",
    "zod",
    "glob",
    "sharp",
    "lodash",
    "semver",
  ];
  for (const scope of topLevelScopes) {
    const dir = path.join(nm, scope);
    if (!fs.existsSync(dir)) continue;
    for (const f of findFiles(dir, ".map")) {
      fs.unlinkSync(f);
      mapCount++;
    }
  }
  if (mapCount > 0) console.log(`  ✓ Removed ${mapCount} .map files`);

  // Gut unused nested deps in @langchain/community
  // Keep package.json stubs so npm list --production passes (required by vsce)
  const communityNm = path.join(nm, "@langchain", "community", "node_modules");
  if (fs.existsSync(communityNm)) {
    // @langchain/classic provides BufferLoader base class for PDFLoader.
    // binary-extensions is required by GithubRepoLoader and is only present
    // under @langchain/community/node_modules in the packaged tree.
    const KEEP = new Set(["@langchain/classic", "binary-extensions"]);
    let gutted = 0;
    for (const entry of fs.readdirSync(communityNm, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(communityNm, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scoped of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!scoped.isDirectory()) continue;
          const scopedName = `${entry.name}/${scoped.name}`;
          if (KEEP.has(scopedName)) continue;
          gutted += gutPackage(path.join(dir, scoped.name));
        }
      } else {
        gutted += gutPackage(dir);
      }
    }
    if (gutted > 0) console.log(`  ✓ Gutted ${gutted} unused nested packages in @langchain/community`);
  }
}

function prunePlatformNativePackages(rootNodeModules, targetPlatform) {
  let removed = 0;
  for (const nodeModules of findNodeModulesDirectories(rootNodeModules)) {
    for (const config of PLATFORM_PACKAGE_CONFIGS) {
      const scopeDir = path.join(nodeModules, config.scope);
      if (!fs.existsSync(scopeDir)) continue;
      const expectedBasename = expectedNativePackageName(config, targetPlatform).split("/")[1];
      for (const name of fs.readdirSync(scopeDir)) {
        if (getNativePackageConfig(`${config.scope}/${name}`) !== config) continue;
        // Retain target copies at every dependency depth. Packages such as the
        // Sharp instance nested under Transformers resolve their optional
        // @img binary relative to that package; VSCE does not reliably retain
        // an unrelated root optional package as a substitute.
        if (name === expectedBasename) continue;
        fs.rmSync(path.join(scopeDir, name), { recursive: true, force: true });
        removed++;
      }
    }
  }
  if (removed > 0) {
    console.log(`  ✓ Removed ${removed} non-target native packages`);
  }
}

function findNodeModulesDirectories(rootNodeModules) {
  const directories = [rootNodeModules];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.name === "node_modules") directories.push(fullPath);
      visit(fullPath);
    }
  };
  visit(rootNodeModules);
  return directories;
}

function pruneOnnxruntimeNode(nm, targetPlatform) {
  const napiDir = path.join(nm, "@huggingface", "transformers", "node_modules", "onnxruntime-node", "bin", "napi-v3");
  if (!fs.existsSync(napiDir)) return;

  for (const platformDir of fs.readdirSync(napiDir)) {
    const platformPath = path.join(napiDir, platformDir);
    if (!fs.statSync(platformPath).isDirectory()) continue;

    for (const archDir of fs.readdirSync(platformPath)) {
      const archPath = path.join(platformPath, archDir);
      if (!fs.statSync(archPath).isDirectory()) continue;

      if (platformDir === targetPlatform.platform && archDir === targetPlatform.arch) {
        console.log(`  Keeping onnxruntime-node ${platformDir}/${archDir}`);
        continue;
      }
      fs.rmSync(archPath, { recursive: true, force: true });
    }

    // Remove empty platform dir
    try {
      if (fs.readdirSync(platformPath).length === 0) {
        fs.rmSync(platformPath, { recursive: true, force: true });
      }
    } catch (_) {
      /* ignore */
    }
  }
}

function findFiles(dir, ext) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(full, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Drop the MCP server workspace from the staged tree.
 *
 * The extension and the MCP server are independent products that share only
 * `@ragnarok/core`. Staging installs every workspace because `npm ci` validates
 * them all against the lockfile — which drags in the MCP server's dependency
 * tree (`@modelcontextprotocol/*`, `@hono/node-server`, `@anthropic-ai/sdk`,
 * `openai`) under `packages/mcp-server/node_modules/`.
 *
 * `.vscodeignore` already excludes `packages/**`, so none of it shipped. But it
 * still sat in the tree `npm list` walks, and `@hono/node-server`'s unmet `hono`
 * peer failed the whole build — the extension unable to package because of a
 * dependency belonging to a product it does not include.
 *
 * The workspace is removed from the staged manifest *after* `npm ci` (before it,
 * the lockfile would not validate) and its directory deleted, so nothing
 * MCP-related remains to walk, ship, or trip over.
 */
function removeMcpWorkspace(stagingDir) {
  const workspacePath = "packages/mcp-server";
  const manifestPath = path.join(stagingDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(pkg.workspaces) || !pkg.workspaces.includes(workspacePath)) return;

  pkg.workspaces = pkg.workspaces.filter((workspace) => workspace !== workspacePath);
  fs.writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + "\n");

  const dir = path.join(stagingDir, workspacePath);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

  // npm hoists what it can, so the MCP-only packages may also sit at the root.
  // The extension loads none of them.
  for (const name of ["@modelcontextprotocol", "@hono", "@anthropic-ai"]) {
    const hoisted = path.join(stagingDir, "node_modules", name);
    if (fs.existsSync(hoisted)) fs.rmSync(hoisted, { recursive: true, force: true });
  }
  console.log("  ✓ Removed the MCP server workspace and its dependencies");
}

/**
 * Mark peer dependencies that were never installed as optional, in the staged
 * tree only.
 *
 * vsce derives the packaged file list by shelling out to
 * `npm list --production`, and npm exits non-zero when a *non-optional* peer is
 * absent. Two packages in this tree declare peers they cannot expect anyone to
 * install and forget to mark them optional:
 *
 *   - @langchain/community (deprecated) requires @browserbasehq/stagehand,
 *     @ibm-cloud/watsonx-ai and ibm-cloud-sdk-core — vendor integrations for
 *     services this extension does not touch.
 *   - @hono/node-server requires hono. It reaches the tree only because staging
 *     installs every workspace, including the MCP server, which the extension
 *     does not ship.
 *
 * npm is right and the manifests are wrong, so the repair belongs here: the
 * staging directory is disposable, and "a peer we deliberately did not install
 * is optional" is exactly what these manifests should have said. Nothing in the
 * source tree is touched, and no package contents change — only the metadata
 * npm reads while enumerating.
 *
 * Deriving this from the tree rather than a hand-written list means a future
 * dependency with the same defect is handled without another fix here.
 */
function relaxUnmetPeerDependencies(nodeModulesDir) {
  if (!fs.existsSync(nodeModulesDir)) return;

  const manifests = [];
  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    if (entry.name.startsWith("@")) {
      const scopeDir = path.join(nodeModulesDir, entry.name);
      for (const scoped of fs.readdirSync(scopeDir, { withFileTypes: true })) {
        if (scoped.isDirectory()) manifests.push(path.join(scopeDir, scoped.name, "package.json"));
      }
    } else {
      manifests.push(path.join(nodeModulesDir, entry.name, "package.json"));
    }
  }

  let relaxed = 0;
  for (const manifestPath of manifests) {
    if (!fs.existsSync(manifestPath)) continue;
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      continue; // A manifest we cannot read is not one we can repair.
    }
    const peers = pkg.peerDependencies;
    if (!peers) continue;

    let changed = false;
    for (const peer of Object.keys(peers)) {
      if (pkg.peerDependenciesMeta?.[peer]?.optional) continue;
      if (fs.existsSync(path.join(nodeModulesDir, peer, "package.json"))) continue;
      pkg.peerDependenciesMeta = pkg.peerDependenciesMeta || {};
      pkg.peerDependenciesMeta[peer] = { ...pkg.peerDependenciesMeta[peer], optional: true };
      changed = true;
      relaxed += 1;
    }
    if (changed) fs.writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + "\n");
  }

  if (relaxed > 0) {
    console.log(`  ✓ Marked ${relaxed} uninstalled peer dependencies optional for packaging`);
  }
}

function pruneLangchainCommunityPackage(nodeModulesDir) {
  const communityDir = path.join(nodeModulesDir, "@langchain", "community");
  if (!fs.existsSync(communityDir)) return null;

  const keepSet = buildKeepPathSet(LANGCHAIN_COMMUNITY_KEEP_PATHS);
  const removed = { files: 0, directories: 0 };
  pruneDirectoryToKeepSet(communityDir, communityDir, keepSet, removed);
  return removed;
}

function buildKeepPathSet(relativePaths) {
  const keepSet = new Set();
  for (const relativePath of relativePaths) {
    const normalizedPath = normalizeRelativePath(relativePath);
    keepSet.add(normalizedPath);

    let parent = path.posix.dirname(normalizedPath);
    while (parent !== ".") {
      keepSet.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return keepSet;
}

function pruneDirectoryToKeepSet(rootDir, currentDir, keepSet, removed) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = normalizeRelativePath(path.relative(rootDir, fullPath));

    if (entry.isDirectory()) {
      if (relativePath === "node_modules") continue;

      if (keepSet.has(relativePath)) {
        pruneDirectoryToKeepSet(rootDir, fullPath, keepSet, removed);
        continue;
      }

      const counts = countTreeEntries(fullPath);
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed.files += counts.files;
      removed.directories += counts.directories;
      continue;
    }

    if (!keepSet.has(relativePath)) {
      fs.rmSync(fullPath, { force: true });
      removed.files += 1;
    }
  }
}

function countTreeEntries(dir) {
  const counts = { files: 0, directories: 1 };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nestedCounts = countTreeEntries(fullPath);
      counts.files += nestedCounts.files;
      counts.directories += nestedCounts.directories;
    } else {
      counts.files += 1;
    }
  }
  return counts;
}

function normalizeRelativePath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

/** Gut a package directory — remove everything except package.json and nested node_modules. Returns 1 if gutted, 0 if skipped. */
function gutPackage(pkgDir) {
  if (!fs.existsSync(path.join(pkgDir, "package.json"))) return 0;
  let removed = false;
  for (const entry of fs.readdirSync(pkgDir)) {
    if (entry === "package.json" || entry === "node_modules") continue;
    fs.rmSync(path.join(pkgDir, entry), { recursive: true, force: true });
    removed = true;
  }
  return removed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 7. Package with vsce
// ---------------------------------------------------------------------------

/**
 * The extension and the MCP server are independent products that happen to
 * share `@ragnarok/core`. Nothing MCP-specific may ship inside the VSIX.
 *
 * `.vscodeignore` already excludes `node_modules/**` and allowlists only what
 * the extension loads, so these packages are kept out by construction — but
 * "by construction" is exactly the kind of guarantee that erodes when someone
 * adds one allowlist line. Staging installs the MCP server's dependencies
 * (npm ci installs every workspace), so the material is present and one
 * negation away from shipping. Assert instead of trusting.
 */
function assertNoMcpDependencies(stagingDir) {
  // Checked against the staging tree, not the finished archive: vsce can only
  // package what is here, so a directory that is absent cannot be shipped.
  // Reading the .vsix would need a zip reader — `unzip` is not a Windows
  // command, and this build has to work on all six targets.
  //
  // Only markers unique to the MCP server. `openai` and `@anthropic-ai` are
  // deliberately absent: the MCP server uses them, but so does
  // @langchain/community's own OpenAI integration, which the extension does
  // load — flagging those names would fail the build on a legitimate
  // dependency rather than catch a leak.
  const forbidden = [
    path.join("node_modules", "@modelcontextprotocol"),
    path.join("node_modules", "@hono"),
    path.join("packages", "mcp-server"),
  ];
  const staged = forbidden.filter((relative) => fs.existsSync(path.join(stagingDir, relative)));
  if (staged.length > 0) {
    throw new Error(
      `MCP dependencies are still staged and would ship in the VSIX (the extension must not ` +
        `include them):\n  ${staged.join("\n  ")}`,
    );
  }
  console.log("  ✓ No MCP dependencies staged for the VSIX");
}

function packageVsix(stagingDir, targetPlatform) {
  console.log("\nPackaging VSIX...");

  assertNoMcpDependencies(stagingDir);

  // Use the root project's vsce binary
  runNodeScript(resolveDependencyBin("@vscode/vsce", "vsce"), ["package", "--target", targetPlatform.target], {
    cwd: stagingDir,
    stdio: "inherit",
  });

  // Find the generated VSIX and move it to root
  const vsix = fs.readdirSync(stagingDir).find((f) => f.endsWith(".vsix"));
  if (!vsix) {
    throw new Error("No .vsix file produced");
  }
  const src = path.join(stagingDir, vsix);
  const dest = path.join(ROOT, vsix);
  fs.copyFileSync(src, dest);
  console.log(`\n✓ VSIX: ${dest}`);
  return dest;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (process.argv.includes("--publish")) {
    throw new Error("Direct build-and-publish is disabled; use a verified release manifest");
  }
  const targetPlatform = getTargetPlatform();
  console.log(`Building VSIX for ${targetPlatform.target}...\n`);

  // A VSIX must never inherit stale output from a developer checkout.
  console.log("Cleaning and rebuilding extension output from source...");
  for (const output of [
    "dist",
    "packages/core/dist",
    "packages/core/tsconfig.tsbuildinfo",
    "packages/mcp-server/dist",
    "packages/mcp-server/tsconfig.tsbuildinfo",
    "packages/vscode/dist",
    "packages/vscode/tsconfig.tsbuildinfo",
  ]) {
    fs.rmSync(path.join(ROOT, output), { recursive: true, force: true });
  }
  execSync("npm run vscode:prepublish", { cwd: ROOT, stdio: "inherit" });

  const distExtension = path.join(ROOT, "dist", "extension.js");
  if (!fs.existsSync(distExtension)) {
    throw new Error(
      `Missing extension bundle: expected ${distExtension} after running "npm run vscode:prepublish". ` +
        "Check the compile/bundle output and ensure the extension entrypoint is generated before packaging.",
    );
  }

  const stagingDir = createStagingDir(targetPlatform.target);
  console.log(`Staging directory: ${stagingDir}`);

  try {
    createStagingPackageJson(stagingDir, targetPlatform);
    copyToStaging(stagingDir);
    verifyStagedModels(stagingDir);
    npmInstallStaging(stagingDir, targetPlatform);
    await installNativeDeps(stagingDir, targetPlatform);
    pruneBloat(stagingDir, targetPlatform);
    packageVsix(stagingDir, targetPlatform);
  } finally {
    if (process.argv.includes("--keep-staging")) {
      console.log(`\nKeeping staging directory for inspection: ${stagingDir}`);
    } else {
      console.log("\nCleaning up staging directory...");
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("\n✗ Build failed:", error.message);
    process.exit(1);
  });
} else {
  module.exports = {
    assertSafeArchiveMember,
    expectedNativePackageName,
    getNativePackageConfig,
    matchesTargetPlatform,
    prunePlatformNativePackages,
    verifyIntegrity,
    verifyNativePackages,
  };
}
