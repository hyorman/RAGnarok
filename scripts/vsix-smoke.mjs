import { execFileSync, execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let vsix = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: node scripts/vsix-smoke.mjs <artifact.vsix>");
if (vsix.includes("*")) {
  const dir = path.dirname(vsix);
  const expression = new RegExp(
    `^${path
      .basename(vsix)
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*")}$`,
  );
  const matches = (await readdir(dir)).filter((name) => expression.test(name));
  if (matches.length !== 1) throw new Error(`Expected exactly one VSIX matching ${vsix}, found ${matches.length}`);
  vsix = path.join(dir, matches[0]);
}
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const minimum = pkg.engines.vscode.replace(/^[^\d]*/, "");
const profile = await mkdtemp(path.join(os.tmpdir(), "ragnarok-vsix-smoke-"));
const extensions = path.join(profile, "extensions");
const userData = path.join(profile, "user-data");
const workspace = path.join(profile, "workspace");
await mkdir(workspace, { recursive: true });

function versionTuple(value) {
  return value
    .split(".")
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}
function atLeast(actual, required) {
  const a = versionTuple(actual);
  const b = versionTuple(required);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return true;
}

try {
  let code = process.env.VSCODE_CLI ?? (process.platform === "win32" ? "code.cmd" : "code");
  let baseArgs = [];
  let vscodeExecutablePath;
  if (process.env.VSCODE_VERSION) {
    const vscodeTest = await import("@vscode/test-electron");
    vscodeExecutablePath = await vscodeTest.downloadAndUnzipVSCode(process.env.VSCODE_VERSION);
    [code, ...baseArgs] = vscodeTest.resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, {
      reuseMachineInstall: true,
    });
  }
  // Node refuses to spawn a .cmd file without a shell (CVE-2024-27980), and the
  // Windows VS Code CLI is code.cmd. Every argument is a path or flag this script
  // built, so quoting each one is all cmd.exe needs.
  const viaShell = process.platform === "win32" && /\.cmd$/i.test(code);
  // cmd.exe expands %~dp0 to the current directory, not the batch file's own, when a
  // quoted batch file was found through PATH (code.cmd opens "%~dp0..\Code.exe"), so a
  // bare name is resolved to its absolute path first. where.exe is an .exe: no shell.
  if (viaShell && !/[\\/]/.test(code)) {
    let located;
    try {
      located = execFileSync("where.exe", [code], { encoding: "utf8" });
    } catch (error) {
      throw new Error(`where.exe could not find ${code} on PATH; set VSCODE_CLI to its full path`, { cause: error });
    }
    const resolved = located
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "");
    if (!resolved) throw new Error(`where.exe printed no path for ${code}; set VSCODE_CLI to its full path`);
    code = resolved;
  }
  const runCli = (args, options) =>
    viaShell
      ? execSync([code, ...baseArgs, ...args].map((value) => `"${value}"`).join(" "), options)
      : execFileSync(code, [...baseArgs, ...args], options);
  const version = runCli(["--version"], { encoding: "utf8" }).split(/\r?\n/)[0];
  if (!atLeast(version, minimum)) throw new Error(`VS Code ${version} is below declared minimum ${minimum}`);
  runCli(["--extensions-dir", extensions, "--user-data-dir", userData, "--install-extension", vsix, "--force"], {
    stdio: "inherit",
  });
  const installed = runCli(
    ["--extensions-dir", extensions, "--user-data-dir", userData, "--list-extensions", "--show-versions"],
    { encoding: "utf8" },
  );
  if (!installed.toLowerCase().includes(`${pkg.publisher}.${pkg.name}@${pkg.version}`.toLowerCase())) {
    throw new Error("Exact VSIX did not appear in the isolated installed-extension list");
  }
  const extensionMatches = (await readdir(extensions)).filter((name) =>
    name.toLowerCase().startsWith(`${pkg.publisher}.${pkg.name}-${pkg.version}`.toLowerCase()),
  );
  if (extensionMatches.length !== 1) throw new Error("Could not resolve the exact installed extension directory");
  const extensionDir = path.join(extensions, extensionMatches[0]);
  // A child process loads the native modules: Windows cannot delete a DLL that a live
  // process has loaded, and this process must be able to remove the profile at the end.
  const probeOutput = execFileSync(process.execPath, [path.join(root, "scripts/vsix-native-probe.cjs"), extensionDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const probeLine = probeOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1);
  if (!probeLine) throw new Error("The native module probe printed no result");
  const probe = JSON.parse(probeLine);
  if (!probe.lanceConnect || !probe.sharp || !probe.onnxBackends?.includes("cpu")) {
    throw new Error("Installed VSIX native LanceDB/Sharp/ONNX Runtime modules did not load");
  }
  if (probe.arch !== process.arch) {
    throw new Error(`The native module probe ran on ${probe.arch}, not on ${process.arch}`);
  }
  const declaredTarget = ["x64", "arm64"].find((arch) => path.basename(vsix).includes(`-${arch}.vsix`));
  if (declaredTarget && process.arch !== declaredTarget) {
    throw new Error(`VSIX target ${declaredTarget} is being smoked on ${process.arch}`);
  }

  // Run an extension-host test against the exact unpacked VSIX directory.
  // This invokes the internal create/query/delete hook and fails on activation,
  // command registration, native initialization, query, or cleanup errors.
  const vscodeTest = await import("@vscode/test-electron");
  // When invoked from a VS Code extension host (including Codex), this
  // variable is inherited and would make the Electron binary run as plain
  // Node instead of starting an isolated extension host.
  const inheritedElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  delete process.env.ELECTRON_RUN_AS_NODE;
  try {
    await vscodeTest.runTests({
      ...(vscodeExecutablePath ? { vscodeExecutablePath } : { version: process.env.VSCODE_TEST_VERSION ?? "stable" }),
      extensionDevelopmentPath: extensionDir,
      extensionTestsPath: path.join(root, "scripts/vsix-extension-host-smoke.cjs"),
      extensionTestsEnv: {
        ...process.env,
        RAGNAROK_RUN_INSTALLED_SMOKE: "1",
        RAGNAROK_EXPECTED_EXTENSION_PATH: extensionDir,
      },
      launchArgs: [
        workspace,
        "--extensions-dir",
        extensions,
        "--user-data-dir",
        userData,
        "--disable-workspace-trust",
        "--disable-extensions",
        "--enable-proposed-api=hyorman.ragnarok",
      ],
    });
  } finally {
    if (inheritedElectronRunAsNode === undefined) {
      delete process.env.ELECTRON_RUN_AS_NODE;
    } else {
      process.env.ELECTRON_RUN_AS_NODE = inheritedElectronRunAsNode;
    }
  }
  console.log(
    `Installed, activated, and create/query/delete smoked ${pkg.publisher}.${pkg.name}@${pkg.version} on VS Code ${version}.`,
  );
} finally {
  // Node retries EBUSY, EMFILE, ENFILE, ENOTEMPTY and EPERM, which covers a VS Code
  // process that is slow to exit and still holds files under the profile.
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
