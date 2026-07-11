#!/usr/bin/env node

/**
 * Small wrapper for package:dev that detects the current platform/arch
 * and delegates to build-vsix.js with the resolved target.
 */

const { spawn } = require('child_process');
const path = require('path');

// Detect current platform
const platform = process.platform; // 'darwin', 'linux', 'win32'
const arch = process.arch; // 'arm64', 'x64', etc.

// Map Node.js platform/arch to target format
const platformMap = {
  'darwin': 'darwin',
  'linux': 'linux',
  'win32': 'win32'
};

const archMap = {
  'arm64': 'arm64',
  'x64': 'x64'
};

const platformName = platformMap[platform];
const archName = archMap[arch];

if (!platformName || !archName) {
  console.error(`Unsupported platform: ${platform} ${arch}`);
  process.exit(1);
}

const target = `${platformName}-${archName}`;
const forwardedArgs = process.argv.slice(2);
const buildScript = path.join(__dirname, 'build-vsix.js');

// Delegate to the staging-based VSIX builder with the detected target.
const buildProcess = spawn(process.execPath, [buildScript, target, ...forwardedArgs], {
  stdio: 'inherit'
});

buildProcess.on('error', (error) => {
  console.error(`Failed to run build-vsix.js for ${target}: ${error.message}`);
  process.exit(1);
});

buildProcess.on('close', (code) => {
  process.exit(code ?? 1);
});

