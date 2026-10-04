"use strict";

// Loads the installed extension's native modules (LanceDB, Sharp, ONNX Runtime) for vsix-smoke.mjs.
// It runs in its own process because Windows cannot delete a DLL that a live process has loaded.
const { createRequire } = require("node:module");
const path = require("node:path");

const extensionDir = process.argv[2];
if (!extensionDir) throw new Error("Usage: node scripts/vsix-native-probe.cjs <installed-extension-dir>");

const extensionRequire = createRequire(path.join(extensionDir, "package.json"));
const lance = extensionRequire("@lancedb/lancedb");
const transformersRoot = path.dirname(path.dirname(extensionRequire.resolve("@huggingface/transformers")));
const transformersRequire = createRequire(path.join(transformersRoot, "package.json"));
const sharp = transformersRequire("sharp");
// Requiring onnxruntime-node loads its native binding for this platform/arch
// and asks it for the backends it was built with.
const onnxruntime = transformersRequire("onnxruntime-node");
const onnxBackends = (onnxruntime.listSupportedBackends?.() ?? []).map((backend) => backend.name);

console.log(
  JSON.stringify({
    lanceConnect: typeof lance.connect === "function",
    sharp: sharp.versions?.sharp ?? null,
    onnxBackends,
    arch: process.arch,
  }),
);
