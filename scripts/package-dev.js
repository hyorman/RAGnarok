#!/usr/bin/env node

/**
 * Wrapper script for package:dev that detects current platform
 * and installs platform-specific dependencies before packaging
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

// Run install-platform-deps.js with target, then vsce package
const installScript = path.join(__dirname, 'install-platform-deps.js');
const installProcess = spawn('node', [installScript, target], {
  stdio: 'inherit',
  shell: true
});

installProcess.on('close', (code) => {
  if (code !== 0) {
    console.error(`Failed to install platform dependencies for ${target}`);
    process.exit(code);
  }

  // Run vsce package
  const vsceProcess = spawn('npx', ['vsce', 'package'], {
    stdio: 'inherit',
    shell: true
  });

  vsceProcess.on('close', (code) => {
    process.exit(code);
  });
});

