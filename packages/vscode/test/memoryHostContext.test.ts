import { expect } from "chai";
import type { MemoryOperationInput } from "@ragnarok/core";
import { resolveMemoryHostContext, type MemoryHostContextHost } from "@ragnarok/vscode";

type Folder = { uri: { fsPath: string } };

function host(options: { folders?: Folder[]; activeFolder?: Folder; branch?: string | null }): MemoryHostContextHost {
  const activeUri = options.activeFolder ? { fsPath: `${options.activeFolder.uri.fsPath}/active.ts` } : undefined;
  return {
    workspaceFolders: options.folders,
    activeDocumentUri: activeUri,
    getWorkspaceFolder: () => options.activeFolder,
    getCurrentBranch: async () => options.branch ?? null,
  };
}

describe("VS Code memory host context", function () {
  const branchInput: MemoryOperationInput = { action: "store", content: "x", scope: "branch" };

  it("uses an explicit branch before consulting workspace context", async function () {
    let branchDetections = 0;
    const context = await resolveMemoryHostContext(
      { ...branchInput, branch: "feature/explicit" },
      {
        workspaceFolders: [{ uri: { fsPath: "/one" } }, { uri: { fsPath: "/two" } }],
        getWorkspaceFolder: () => undefined,
        getCurrentBranch: async () => {
          branchDetections++;
          return "ignored";
        },
      },
    );

    expect(context).to.deep.equal({
      workingDir: "",
      branchContext: { state: "resolved", branch: "feature/explicit" },
    });
    expect(branchDetections).to.equal(0);
  });

  it("detects the branch from the active editor workspace folder", async function () {
    const first = { uri: { fsPath: "/one" } };
    const second = { uri: { fsPath: "/two" } };
    const detectedDirs: string[] = [];
    const context = await resolveMemoryHostContext(branchInput, {
      ...host({ folders: [first, second], activeFolder: second }),
      getCurrentBranch: async (workingDir) => {
        detectedDirs.push(workingDir);
        return "feature/active";
      },
    });

    expect(context).to.deep.equal({
      workingDir: "/two",
      branchContext: { state: "resolved", branch: "feature/active" },
    });
    expect(detectedDirs).to.deep.equal(["/two"]);
  });

  it("falls back to the sole workspace folder", async function () {
    const context = await resolveMemoryHostContext(
      branchInput,
      host({ folders: [{ uri: { fsPath: "/only" } }], branch: "main" }),
    );

    expect(context).to.deep.equal({
      workingDir: "/only",
      branchContext: { state: "resolved", branch: "main" },
    });
  });

  it("returns ambiguous for multiple roots without an active editor folder", async function () {
    const context = await resolveMemoryHostContext(
      branchInput,
      host({ folders: [{ uri: { fsPath: "/one" } }, { uri: { fsPath: "/two" } }] }),
    );

    expect(context).to.deep.equal({
      workingDir: "",
      branchContext: { state: "ambiguous" },
    });
  });

  it("returns unavailable when the selected folder has no detectable branch", async function () {
    const context = await resolveMemoryHostContext(
      branchInput,
      host({ folders: [{ uri: { fsPath: "/only" } }], branch: null }),
    );

    expect(context).to.deep.equal({
      workingDir: "/only",
      branchContext: { state: "unavailable" },
    });
  });

  it("returns unavailable with no working directory outside a workspace", async function () {
    const context = await resolveMemoryHostContext(branchInput, host({ folders: [] }));

    expect(context).to.deep.equal({
      workingDir: "",
      branchContext: { state: "unavailable" },
    });
  });
});
