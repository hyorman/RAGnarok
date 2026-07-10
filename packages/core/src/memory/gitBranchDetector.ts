/**
 * Git branch detection utility with caching.
 * Used by the standalone memory module to auto-detect branch scope.
 */

import { execSync } from "child_process";
import { Logger } from "../logger";

export class GitBranchDetector {
  private logger = new Logger("GitBranchDetector");
  private cachedBranch: string | null = null;
  // Tracks whether cachedBranch holds a real (possibly null) detection result.
  // null is a valid cached value — detached HEAD and non-git workspaces must
  // be memoized too, otherwise every memory operation re-spawns a git
  // subprocess for the duration of the process.
  private hasCachedResult = false;
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 5000;

  constructor(private workingDir?: string) {}

  /**
   * Get the current git branch name.
   * Returns null if not in a git repo or git is unavailable.
   * Caches the result (including null) for 5 seconds.
   */
  getCurrentBranch(): string | null {
    const now = Date.now();
    if (this.hasCachedResult && now - this.cacheTimestamp < this.CACHE_TTL_MS) {
      return this.cachedBranch;
    }

    try {
      const branch = this.runGitCommand("git rev-parse --abbrev-ref HEAD", this.workingDir).trim();
      this.cachedBranch = branch === "HEAD" ? null : branch;
    } catch {
      this.logger.debug("Git branch detection failed (not a git repo or git unavailable)");
      this.cachedBranch = null;
    }

    this.hasCachedResult = true;
    this.cacheTimestamp = now;
    return this.cachedBranch;
  }

  invalidateCache(): void {
    this.cachedBranch = null;
    this.hasCachedResult = false;
    this.cacheTimestamp = 0;
  }

  protected runGitCommand(command: string, cwd?: string): string {
    return execSync(command, {
      cwd,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
}
