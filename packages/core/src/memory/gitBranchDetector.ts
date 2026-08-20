import * as fs from "fs/promises";
import * as path from "path";
import { Logger } from "../logger";

/** Asynchronous branch detection that supports normal repositories and worktrees. */
export class GitBranchDetector {
  private logger = new Logger("GitBranchDetector");
  private cachedBranch: string | null = null;
  private hasCachedResult = false;
  private cacheTimestamp = 0;
  private inFlight: Promise<string | null> | null = null;
  private readonly CACHE_TTL_MS = 5000;

  constructor(private workingDir: string = process.cwd()) {}

  async getCurrentBranch(): Promise<string | null> {
    const now = Date.now();
    if (this.hasCachedResult && now - this.cacheTimestamp < this.CACHE_TTL_MS) {
      return this.cachedBranch;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.detectBranch();
    try {
      this.cachedBranch = await this.inFlight;
      this.hasCachedResult = true;
      this.cacheTimestamp = Date.now();
      return this.cachedBranch;
    } finally {
      this.inFlight = null;
    }
  }

  invalidateCache(): void {
    this.cachedBranch = null;
    this.hasCachedResult = false;
    this.cacheTimestamp = 0;
  }

  protected async detectBranch(): Promise<string | null> {
    try {
      const gitDir = await this.findGitDirectory(path.resolve(this.workingDir));
      if (!gitDir) {
        return null;
      }
      const head = (await fs.readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
      const match = head.match(/^ref:\s+refs\/heads\/(.+)$/);
      return match?.[1] ?? null;
    } catch (error) {
      this.logger.debug("Git branch detection failed", error);
      return null;
    }
  }

  private async findGitDirectory(start: string): Promise<string | null> {
    let current = start;
    try {
      if (!(await fs.stat(current)).isDirectory()) {
        current = path.dirname(current);
      }
    } catch {
      return null;
    }
    while (true) {
      const marker = path.join(current, ".git");
      try {
        const stat = await fs.stat(marker);
        if (stat.isDirectory()) {
          return marker;
        }
        if (stat.isFile()) {
          const content = (await fs.readFile(marker, "utf8")).trim();
          const match = content.match(/^gitdir:\s*(.+)$/i);
          if (match) {
            return path.resolve(current, match[1]);
          }
        }
      } catch {
        // Continue walking parents.
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
}
