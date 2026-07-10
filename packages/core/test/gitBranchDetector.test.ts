import { expect } from "chai";
import * as sinon from "sinon";
import { execSync } from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { GitBranchDetector } from "../src/memory/gitBranchDetector";

/**
 * Testable subclass that intercepts execSync calls for stubbing.
 * Needed because Node.js child_process exports are non-configurable
 * and cannot be stubbed by sinon directly.
 */
class TestableGitBranchDetector extends GitBranchDetector {
  public execSyncCalls: Array<{ command: string; cwd?: string }> = [];
  private _fakeResult: string | Error | null = null;

  /** Configure the fake to return a branch string or throw an error. */
  setFakeResult(result: string | Error | null): void {
    this._fakeResult = result;
  }

  /** Override to intercept the git call. Falls through to real execSync if no fake set. */
  protected runGitCommand(command: string, cwd?: string): string {
    this.execSyncCalls.push({ command, cwd });
    if (this._fakeResult instanceof Error) {
      throw this._fakeResult;
    }
    if (this._fakeResult !== null) {
      return this._fakeResult;
    }
    return execSync(command, {
      cwd,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
}

describe("GitBranchDetector", function () {
  this.timeout(10000);

  afterEach(function () {
    sinon.restore();
  });

  describe("getCurrentBranch()", function () {
    it("should return a branch name when inside a git repo", function () {
      // The workspace itself is a git repo, so real execSync should work
      const detector = new GitBranchDetector(process.cwd());
      const branch = detector.getCurrentBranch();
      expect(branch).to.be.a("string");
      expect(branch!.length).to.be.greaterThan(0);
    });

    it("should return null when workingDir is not a git repo", function () {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-test-"));
      try {
        const detector = new GitBranchDetector(tmpDir);
        const branch = detector.getCurrentBranch();
        expect(branch).to.be.null;
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("caching behavior", function () {
    it("should return cached result without re-executing git", function () {
      const detector = new TestableGitBranchDetector();
      detector.setFakeResult("main\n");

      const first = detector.getCurrentBranch();
      const second = detector.getCurrentBranch();

      expect(first).to.equal("main");
      expect(second).to.equal("main");
      expect(detector.execSyncCalls).to.have.lengthOf(1);
    });

    it("should re-execute after cache TTL expires", function () {
      const clock = sinon.useFakeTimers();
      const detector = new TestableGitBranchDetector();
      detector.setFakeResult("main\n");

      detector.getCurrentBranch();
      expect(detector.execSyncCalls).to.have.lengthOf(1);

      // Advance past the 5s TTL
      clock.tick(5001);
      detector.getCurrentBranch();
      expect(detector.execSyncCalls).to.have.lengthOf(2);

      clock.restore();
    });
  });

  describe("invalidateCache()", function () {
    it("should cause next call to re-detect branch", function () {
      const detector = new TestableGitBranchDetector();
      detector.setFakeResult("main\n");

      detector.getCurrentBranch();
      expect(detector.execSyncCalls).to.have.lengthOf(1);

      detector.invalidateCache();
      detector.getCurrentBranch();
      expect(detector.execSyncCalls).to.have.lengthOf(2);
    });
  });

  describe("constructor with custom workingDir", function () {
    it("should pass workingDir as cwd", function () {
      const customDir = "/some/custom/path";
      const detector = new TestableGitBranchDetector(customDir);
      detector.setFakeResult("feature-branch\n");

      const branch = detector.getCurrentBranch();

      expect(branch).to.equal("feature-branch");
      expect(detector.execSyncCalls).to.have.lengthOf(1);
      expect(detector.execSyncCalls[0].cwd).to.equal(customDir);
    });
  });

  describe("error handling", function () {
    it("should return null when git command fails", function () {
      const detector = new TestableGitBranchDetector();
      detector.setFakeResult(new Error("fatal: not a git repository"));

      const branch = detector.getCurrentBranch();
      expect(branch).to.be.null;
    });

    it("should return null when branch is HEAD (detached)", function () {
      const detector = new TestableGitBranchDetector();
      detector.setFakeResult("HEAD\n");

      const branch = detector.getCurrentBranch();
      expect(branch).to.be.null;
    });

    it("should cache null results from errors for the TTL", function () {
      const detector = new TestableGitBranchDetector();
      detector.setFakeResult(new Error("git not found"));

      expect(detector.getCurrentBranch()).to.be.null;
      expect(detector.getCurrentBranch()).to.be.null;

      // Negative results are memoized like positive ones — without this,
      // non-git workspaces spawn a git subprocess on every memory operation
      expect(detector.execSyncCalls).to.have.lengthOf(1);
    });

    it("should cache detached-HEAD null results for the TTL", function () {
      const detector = new TestableGitBranchDetector();
      detector.setFakeResult("HEAD\n");

      expect(detector.getCurrentBranch()).to.be.null;
      expect(detector.getCurrentBranch()).to.be.null;

      expect(detector.execSyncCalls).to.have.lengthOf(1);
    });

    it("should re-detect a null result after the TTL expires", function () {
      const clock = sinon.useFakeTimers();
      const detector = new TestableGitBranchDetector();
      detector.setFakeResult(new Error("git not found"));

      detector.getCurrentBranch();
      expect(detector.execSyncCalls).to.have.lengthOf(1);

      clock.tick(5001);
      detector.setFakeResult("main\n");
      expect(detector.getCurrentBranch()).to.equal("main");
      expect(detector.execSyncCalls).to.have.lengthOf(2);

      clock.restore();
    });
  });
});
