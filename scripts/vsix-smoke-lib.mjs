// The parts of scripts/vsix-smoke.mjs that need no VS Code: how its CLI is spawned, and what its
// success line says. The release static tests import them; vsix-smoke.mjs runs on import.

/** Node will not spawn a batch file (.cmd or .bat) without a shell (CVE-2024-27980); the Windows VS Code CLI is one. */
export function needsShell(cli, platform = process.platform) {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(cli);
}

/**
 * The cmd.exe command line for a batch-file CLI and its arguments, each value double-quoted. cmd.exe
 * still expands %VAR% inside quotes and has no escape for it there, and a double quote or a line break
 * would end the argument, so a value holding any of them is refused rather than passed on altered.
 */
export function cmdLine(values) {
  for (const value of values) {
    if (/[%"\r\n]/.test(value)) {
      throw new Error(
        `cannot pass ${JSON.stringify(value)} through cmd.exe: it contains %, a double quote or a line break`,
      );
    }
  }
  return values.map((value) => `"${value}"`).join(" ");
}

/** The smoke's success line: the VS Code that ran the extension host, and the CLI's version when it differs. */
export function smokeSummary(extension, hostVersion, cliVersion) {
  const cli = cliVersion === hostVersion ? "" : ` (installed with the ${cliVersion} CLI)`;
  return `Installed, activated, and create/query/delete smoked ${extension} on VS Code ${hostVersion}${cli}.`;
}
