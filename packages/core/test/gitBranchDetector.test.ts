import { expect } from "chai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { GitBranchDetector } from "../src/memory/gitBranchDetector";

describe("GitBranchDetector", function () {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-branch-detector-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeHead(root: string, value: string): Promise<void> {
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, ".git", "HEAD"), value, "utf8");
  }

  it("reads a branch from .git/HEAD without spawning git", async () => {
    await writeHead(tempDir, "ref: refs/heads/feature/async-head\n");
    expect(await new GitBranchDetector(tempDir).getCurrentBranch()).to.equal("feature/async-head");
  });

  it("returns null outside a repository", async () => {
    expect(await new GitBranchDetector(tempDir).getCurrentBranch()).to.be.null;
  });

  it("returns null for detached HEAD", async () => {
    await writeHead(tempDir, "0123456789abcdef0123456789abcdef01234567\n");
    expect(await new GitBranchDetector(tempDir).getCurrentBranch()).to.be.null;
  });

  it("walks parent directories", async () => {
    await writeHead(tempDir, "ref: refs/heads/main\n");
    const nested = path.join(tempDir, "a", "b");
    await fs.mkdir(nested, { recursive: true });
    expect(await new GitBranchDetector(nested).getCurrentBranch()).to.equal("main");
  });

  it("resolves worktree gitdir files", async () => {
    const actualGitDir = path.join(tempDir, "worktree-git");
    const worktree = path.join(tempDir, "checkout");
    await fs.mkdir(actualGitDir, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(path.join(actualGitDir, "HEAD"), "ref: refs/heads/worktree-branch\n");
    await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${actualGitDir}\n`);
    expect(await new GitBranchDetector(worktree).getCurrentBranch()).to.equal("worktree-branch");
  });

  it("caches results until invalidated", async () => {
    await writeHead(tempDir, "ref: refs/heads/main\n");
    const detector = new GitBranchDetector(tempDir);
    expect(await detector.getCurrentBranch()).to.equal("main");
    await fs.writeFile(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/changed\n");
    expect(await detector.getCurrentBranch()).to.equal("main");
    detector.invalidateCache();
    expect(await detector.getCurrentBranch()).to.equal("changed");
  });

  it("deduplicates concurrent detection", async () => {
    await writeHead(tempDir, "ref: refs/heads/concurrent\n");
    const detector = new GitBranchDetector(tempDir);
    const results = await Promise.all(Array.from({ length: 20 }, () => detector.getCurrentBranch()));
    expect(new Set(results)).to.deep.equal(new Set(["concurrent"]));
  });
});
