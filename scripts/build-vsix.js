#!/usr/bin/env node

/**
 * Build a platform-specific VSIX in an isolated staging directory.
 *
 * This replaces the mutate-in-place approach (install-platform-deps.js + vsce package)
 * with a clean staging workflow:
 *
 *   1. Create a staging directory with production-only package.json
 *   2. Copy extension bundle, assets, and metadata
 *   3. npm install --omit=dev (only production deps, no workspaces)
 *   4. Install target-platform native binaries
 *   5. Prune bloat (maps, unused pdf.js versions, onnxruntime-node platforms, langchain nested)
 *   6. vsce package from the staging directory
 *   7. Copy VSIX back, clean up staging
 *
 * Benefits:
 *   - Development node_modules never mutated
 *   - No gutting hacks (npm list not needed since no stubs)
 *   - Reproducible builds
 *   - onnxruntime-web eliminated at install time via stub dependency
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const https = require('https');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. Parse target platform
// ---------------------------------------------------------------------------

function getTargetPlatform() {
  const target = process.argv[2] || process.env.VSCE_TARGET || process.env.TARGET;
  if (!target) {
    console.error(
      'Usage: node build-vsix.js <target>\n' +
      'Examples: darwin-arm64, linux-x64, win32-x64'
    );
    process.exit(1);
  }

  const [platform, arch] = target.split('-');
  const validPlatforms = ['darwin', 'linux', 'win32'];
  const validArchs = ['arm64', 'x64'];

  if (!validPlatforms.includes(platform) || !validArchs.includes(arch)) {
    console.error(`Invalid target: ${target}. Expected {platform}-{arch}`);
    process.exit(1);
  }

  // LanceDB uses variants like linux-x64-gnu, win32-x64-msvc
  const patterns = [target];
  if (platform === 'linux') patterns.push(`${target}-gnu`);
  if (platform === 'win32') patterns.push(`${target}-msvc`);

  return { platform, arch, target, patterns };
}

// ---------------------------------------------------------------------------
// 2. Create staging directory
// ---------------------------------------------------------------------------

function createStagingDir(target) {
  const stagingDir = path.join(ROOT, `.vsce-staging-${target}`);
  if (fs.existsSync(stagingDir)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  fs.mkdirSync(stagingDir, { recursive: true });
  return stagingDir;
}

function createStagingPackageJson(stagingDir, targetPlatform) {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  // Filter optional deps to only include target platform
  const filteredOptional = {};
  for (const [name, version] of Object.entries(rootPkg.optionalDependencies || {})) {
    if (matchesTargetPlatform(name, targetPlatform.patterns)) {
      filteredOptional[name] = version;
    }
  }

  // Build staging package.json: no workspaces, no devDeps, filtered optionalDeps
  const stagingPkg = { ...rootPkg };
  delete stagingPkg.workspaces;
  delete stagingPkg.devDependencies;
  delete stagingPkg.scripts; // Not needed in staging
  stagingPkg.optionalDependencies = filteredOptional;

  // Override onnxruntime-web with local stub (not needed in Node.js, saves ~92MB)
  // Use both a direct dependency and $ref override to ensure ALL instances
  // (including nested transitive deps) use the stub instead of the real package
  if (!stagingPkg.dependencies) stagingPkg.dependencies = {};
  stagingPkg.dependencies['onnxruntime-web'] = 'file:stubs/onnxruntime-web';
  stagingPkg.overrides = {
    ...stagingPkg.overrides,
    'onnxruntime-web': '$onnxruntime-web',
  };

  fs.writeFileSync(
    path.join(stagingDir, 'package.json'),
    JSON.stringify(stagingPkg, null, 2) + '\n'
  );
}

// ---------------------------------------------------------------------------
// 3. Copy extension files to staging
// ---------------------------------------------------------------------------

function copyToStaging(stagingDir) {
  // Note: package-lock.json is NOT copied — the staging package.json is structurally
  // different (no workspaces, onnxruntime-web override, filtered optionalDeps) so the
  // root lockfile would cause resolution conflicts. npm generates a fresh lockfile in
  // staging. Reproducibility is ensured by exact version pins in the root package.json.
  const filesToCopy = ['README.md', 'LICENSE', 'ARCHITECTURE.md', '.vscodeignore', '.npmrc'];
  for (const file of filesToCopy) {
    const src = path.join(ROOT, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(stagingDir, file));
    }
  }

  // Copy directories
  const dirsToCopy = ['dist', 'assets', 'stubs'];
  for (const dir of dirsToCopy) {
    const src = path.join(ROOT, dir);
    if (fs.existsSync(src)) {
      copyDirSync(src, path.join(stagingDir, dir));
    }
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

// ---------------------------------------------------------------------------
// 4. npm install in staging
// ---------------------------------------------------------------------------

function npmInstallStaging(stagingDir) {
  console.log('\nInstalling production dependencies in staging...');
  execSync('npm install --omit=dev --ignore-scripts', {
    cwd: stagingDir,
    stdio: 'inherit',
    env: { ...process.env, npm_config_install_strategy: 'shallow' },
  });
}

// ---------------------------------------------------------------------------
// 5. Platform-specific native deps
// ---------------------------------------------------------------------------

const PLATFORM_PACKAGE_CONFIGS = [
  { scope: '@lancedb', prefix: 'lancedb-', description: 'LanceDB', expectedCount: 1 },
  { scope: '@img', prefix: 'sharp-', description: 'Sharp', expectedCount: 1 },
  { scope: '@img', prefix: 'sharp-libvips-', description: 'Sharp libvips', expectedCount: 1 },
];

function matchesTargetPlatform(packageName, patterns) {
  const parts = packageName.split('/');
  if (parts.length !== 2) return false;
  const name = parts[1];
  return patterns.some(p => {
    const idx = name.indexOf(p);
    if (idx === -1) return false;
    const rest = name.substring(idx + p.length);
    return rest === '' || rest.startsWith('-');
  });
}

async function installNativeDeps(stagingDir, targetPlatform) {
  console.log('\nInstalling platform-specific native binaries...');
  const nodeModules = path.join(stagingDir, 'node_modules');
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const platformDeps = [];
  for (const config of PLATFORM_PACKAGE_CONFIGS) {
    for (const source of ['dependencies', 'optionalDependencies']) {
      const deps = rootPkg[source] || {};
      for (const [name, version] of Object.entries(deps)) {
        if (name.startsWith(`${config.scope}/${config.prefix}`) &&
            matchesTargetPlatform(name, targetPlatform.patterns)) {
          platformDeps.push({ name, version: version.replace(/^[\^~]/, ''), config });
        }
      }
    }
  }

  for (const { name, version, config } of platformDeps) {
    const scopeDir = path.join(nodeModules, config.scope);
    fs.mkdirSync(scopeDir, { recursive: true });
    const packageDir = path.join(scopeDir, name.split('/')[1]);

    if (fs.existsSync(packageDir)) {
      console.log(`  ✓ ${name} already installed`);
      removePlatformRestrictions(packageDir);
      continue;
    }

    fs.mkdirSync(packageDir, { recursive: true });
    try {
      await downloadAndExtract(name, version, packageDir);
      removePlatformRestrictions(packageDir);
      console.log(`  ✓ ${name} installed`);
    } catch (error) {
      console.error(`  ✗ Failed to install ${name}: ${error.message}`);
      if (fs.existsSync(packageDir)) {
        fs.rmSync(packageDir, { recursive: true, force: true });
      }
    }
  }
}

function removePlatformRestrictions(packageDir) {
  const pkgPath = path.join(packageDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    delete pkg.os;
    delete pkg.cpu;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  }
}

function downloadAndExtract(packageName, version, targetDir) {
  const tarball = `https://registry.npmjs.org/${packageName}/-/${packageName.split('/')[1]}-${version}.tgz`;

  return new Promise((resolve, reject) => {
    const follow = (url, redirects = 0) => {
      if (redirects > 5) {
        reject(new Error(`Too many redirects for ${packageName}`));
        return;
      }
      https.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          follow(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const tar = spawn('tar', ['xz', '-C', targetDir, '--strip-components=1'], {
          stdio: ['pipe', 'inherit', 'inherit'],
        });
        res.pipe(tar.stdin);
        tar.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar exit ${code}`)));
      }).on('error', reject);
    };
    follow(tarball);
  });
}

// ---------------------------------------------------------------------------
// 6. Prune bloat
// ---------------------------------------------------------------------------

function pruneBloat(stagingDir, targetPlatform) {
  console.log('\nPruning package bloat...');
  const nm = path.join(stagingDir, 'node_modules');

  // Remove non-target onnxruntime-node platform binaries
  pruneOnnxruntimeNode(nm, targetPlatform);

  // Remove HuggingFace model cache (shouldn't exist in clean install, but just in case)
  const hfCache = path.join(nm, '@huggingface', 'transformers', '.cache');
  if (fs.existsSync(hfCache)) {
    fs.rmSync(hfCache, { recursive: true, force: true });
    console.log('  ✓ Removed .cache');
  }

  // Remove unused pdf.js versions from pdf-parse (~24MB) — keep only v1.10.100
  const pdfJsDir = path.join(nm, 'pdf-parse', 'lib', 'pdf.js');
  if (fs.existsSync(pdfJsDir)) {
    const KEEP_PDFJS = 'v1.10.100';
    let removedVersions = 0;
    for (const entry of fs.readdirSync(pdfJsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== KEEP_PDFJS) {
        fs.rmSync(path.join(pdfJsDir, entry.name), { recursive: true, force: true });
        removedVersions++;
      }
    }
    if (removedVersions > 0) console.log(`  ✓ Removed ${removedVersions} unused pdf.js versions (kept ${KEEP_PDFJS})`);
  }

  // Remove .map source maps from all packages included in VSIX
  let mapCount = 0;
  const topLevelScopes = [
    '@huggingface', '@langchain', '@lancedb', '@img',
    'apache-arrow', 'pdf-parse', 'cheerio', 'archiver',
    'zod', 'glob', 'sharp', 'lodash', 'semver',
  ];
  for (const scope of topLevelScopes) {
    const dir = path.join(nm, scope);
    if (!fs.existsSync(dir)) continue;
    for (const f of findFiles(dir, '.map')) {
      fs.unlinkSync(f);
      mapCount++;
    }
  }
  if (mapCount > 0) console.log(`  ✓ Removed ${mapCount} .map files`);

  // Gut unused nested deps in @langchain/community
  // Keep package.json stubs so npm list --production passes (required by vsce)
  const communityNm = path.join(nm, '@langchain', 'community', 'node_modules');
  if (fs.existsSync(communityNm)) {
    // @langchain/classic provides BufferLoader base class for PDFLoader — keep it
    const KEEP = new Set(['@langchain/classic']);
    let gutted = 0;
    for (const entry of fs.readdirSync(communityNm, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(communityNm, entry.name);
      if (entry.name.startsWith('@')) {
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

function pruneOnnxruntimeNode(nm, targetPlatform) {
  const napiDir = path.join(nm, '@huggingface', 'transformers',
    'node_modules', 'onnxruntime-node', 'bin', 'napi-v3');
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
    } catch (_) { /* ignore */ }
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

/** Gut a package directory — remove everything except package.json. Returns 1 if gutted, 0 if skipped. */
function gutPackage(pkgDir) {
  if (!fs.existsSync(path.join(pkgDir, 'package.json'))) return 0;
  let removed = false;
  for (const entry of fs.readdirSync(pkgDir)) {
    if (entry === 'package.json' || entry === 'node_modules') continue;
    fs.rmSync(path.join(pkgDir, entry), { recursive: true, force: true });
    removed = true;
  }
  return removed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 7. Package with vsce
// ---------------------------------------------------------------------------

function packageVsix(stagingDir, targetPlatform) {
  const publish = process.argv.includes('--publish');
  const action = publish ? 'publish' : 'package';
  console.log(`\n${publish ? 'Publishing' : 'Packaging'} VSIX...`);

  // Use the root project's vsce binary
  const vscebin = path.join(ROOT, 'node_modules', '.bin', 'vsce');
  const vsceCmd = `${vscebin} ${action} --target ${targetPlatform.target}`;
  execSync(vsceCmd, { cwd: stagingDir, stdio: 'inherit' });

  if (!publish) {
    // Find the generated VSIX and move it to root
    const vsix = fs.readdirSync(stagingDir).find(f => f.endsWith('.vsix'));
    if (!vsix) {
      throw new Error('No .vsix file produced');
    }
    const src = path.join(stagingDir, vsix);
    const dest = path.join(ROOT, vsix);
    fs.copyFileSync(src, dest);
    console.log(`\n✓ VSIX: ${dest}`);
    return dest;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const targetPlatform = getTargetPlatform();
  console.log(`Building VSIX for ${targetPlatform.target}...\n`);

  // Ensure dist/extension.js exists
  const distExtension = path.join(ROOT, 'dist', 'extension.js');
  if (!fs.existsSync(distExtension)) {
    console.log('Building extension bundle...');
    execSync('npm run compile', { cwd: ROOT, stdio: 'inherit' });
  }

  const stagingDir = createStagingDir(targetPlatform.target);
  console.log(`Staging directory: ${stagingDir}`);

  try {
    createStagingPackageJson(stagingDir, targetPlatform);
    copyToStaging(stagingDir);
    npmInstallStaging(stagingDir);
    await installNativeDeps(stagingDir, targetPlatform);
    pruneBloat(stagingDir, targetPlatform);
    packageVsix(stagingDir, targetPlatform);
  } finally {
    if (process.argv.includes('--keep-staging')) {
      console.log(`\nKeeping staging directory for inspection: ${stagingDir}`);
    } else {
      console.log('\nCleaning up staging directory...');
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error('\n✗ Build failed:', error.message);
  process.exit(1);
});
