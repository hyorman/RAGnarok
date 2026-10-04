import { expect } from "chai";
import sinon from "sinon";
import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { EmbeddingService, MemoryStore, Topic, TopicManager } from "@ragnarok/core";
import { COMMANDS } from "../src/constants";
import { CommandHandler } from "../src/commands";
import { GitHubTokenManager } from "../src/githubTokenManager";
import type { ConfigTreeDataProvider, TopicTreeDataProvider } from "../src/topicTreeView";

type Handler = (...args: unknown[]) => Promise<unknown>;
type AddDocumentsOptions = { onProgress?: (progress: { message: string; progress: number }) => void } & Record<
  string,
  unknown
>;
type Report = { message?: string; increment?: number };

const topic = { id: "t1", name: "Docs", documentCount: 0 } as unknown as Topic;

/**
 * Registers the real command handlers against a stubbed `registerCommand` (a
 * second real registration under the same ids would throw: activation already
 * registered them), stubs the progress notification, and records what the ingest
 * pipeline was asked to do. Each handler is invoked with the tree item's topic,
 * so only the prompts after the topic picker need answers.
 */
async function setUpIngestCommands(tokens: Partial<Record<keyof GitHubTokenManager, unknown>> = {}) {
  sinon.stub(GitHubTokenManager, "getInstance").returns({
    listHosts: async () => [],
    getToken: async () => undefined,
    extractHost: (url: string) => new URL(url).hostname,
    ...tokens,
  } as unknown as GitHubTokenManager);

  const handlers = new Map<string, Handler>();
  sinon.stub(vscode.commands, "registerCommand").callsFake(((id: string, callback: Handler) => {
    handlers.set(id, callback);
    return { dispose: () => undefined };
  }) as typeof vscode.commands.registerCommand);

  const progressOptions: vscode.ProgressOptions[] = [];
  const reports: Report[] = [];
  sinon.stub(vscode.window, "withProgress").callsFake((async (
    options: vscode.ProgressOptions,
    task: (progress: { report(value: Report): void }) => unknown,
  ) => {
    progressOptions.push(options);
    return task({ report: (value) => reports.push(value) });
  }) as never);

  const info = sinon.stub(vscode.window, "showInformationMessage").resolves(undefined);
  const showError = sinon.stub(vscode.window, "showErrorMessage").resolves(undefined);
  const addDocuments = sinon
    .stub()
    .callsFake(async (_topicId: string, _sources: string[], options: AddDocumentsOptions) => {
      options.onProgress?.({ message: "chunking", progress: 25 });
      options.onProgress?.({ message: "embedding", progress: 50 });
      return [{ pipelineResult: { metadata: { chunksStored: 3, originalDocuments: 1 } } }];
    });
  const topicManager = {
    addDocuments,
    getTopicStats: async () => ({ documentCount: 2, chunkCount: 9 }),
    getAllTopics: () => [topic],
    isSharedTopic: () => false,
  };
  const refresh = sinon.spy();

  await CommandHandler.registerCommands(
    { subscriptions: [] as unknown[] } as unknown as vscode.ExtensionContext,
    topicManager as unknown as TopicManager,
    {} as unknown as EmbeddingService,
    {} as unknown as MemoryStore,
    { refresh } as unknown as TopicTreeDataProvider,
    {} as unknown as ConfigTreeDataProvider,
  );

  const invoke = (command: string) => {
    const handler = handlers.get(command);
    expect(handler, `${command} should be registered`).to.be.a("function");
    return handler!({ topic });
  };
  return { invoke, addDocuments, progressOptions, reports, info, showError, refresh };
}

describe("ingest command wiring", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("add document fills the whole bar and passes the chosen recursion, per files or folders", async function () {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "ragnarok-ingest-folder-"));
    try {
      const { invoke, addDocuments, progressOptions, reports, info, showError, refresh } = await setUpIngestCommands();
      sinon
        .stub(vscode.window, "showQuickPick")
        .onFirstCall()
        .resolves({ label: "Folders", value: "folders" } as never)
        .onSecondCall()
        .resolves({ label: "Load recursively", value: true } as never);
      sinon.stub(vscode.window, "showOpenDialog").resolves([vscode.Uri.file(folder)]);

      await invoke(COMMANDS.ADD_DOCUMENT);

      expect(progressOptions).to.deep.equal([
        { location: vscode.ProgressLocation.Notification, title: "Processing documents...", cancellable: false },
      ]);
      expect(addDocuments.calledOnce).to.equal(true);
      expect(addDocuments.firstCall.args[0]).to.equal("t1");
      expect(addDocuments.firstCall.args[1]).to.deep.equal([vscode.Uri.file(folder).fsPath]);
      expect(addDocuments.firstCall.args[2].loaderOptions).to.deep.equal({ recursiveDirectory: true });
      // The pipeline moved 0 -> 25 -> 50 and documents fill the whole bar.
      expect(reports).to.deep.equal([
        { message: "chunking", increment: 25 },
        { message: "embedding", increment: 25 },
        { message: "Complete!" },
      ]);
      expect(info.lastCall.args[0]).to.equal('Documents added to "Docs" successfully! Total: 2 documents, 9 chunks.');
      expect(refresh.calledOnce).to.equal(true);
      expect(showError.args).to.deep.equal([]);
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  });

  it("add document does not recurse when the user picks files", async function () {
    const { invoke, addDocuments, showError } = await setUpIngestCommands();
    const file = vscode.Uri.file(path.join(os.tmpdir(), "ragnarok-ingest-missing", "notes.md"));
    sinon.stub(vscode.window, "showQuickPick").resolves({ label: "Files", value: "files" } as never);
    sinon.stub(vscode.window, "showOpenDialog").resolves([file]);

    await invoke(COMMANDS.ADD_DOCUMENT);

    expect(addDocuments.firstCall.args[1]).to.deep.equal([file.fsPath]);
    expect(addDocuments.firstCall.args[2].loaderOptions).to.deep.equal({ recursiveDirectory: false });
    expect(showError.args).to.deep.equal([]);
  });

  it("add web URL loads the page as a web document with its own title and label", async function () {
    const { invoke, addDocuments, progressOptions, reports, info, showError } = await setUpIngestCommands();
    sinon.stub(vscode.window, "showInputBox").resolves("  https://example.com/docs/page  ");

    await invoke(COMMANDS.ADD_WEB_URL);

    expect(progressOptions.map((options) => options.title)).to.deep.equal(["Loading web page..."]);
    expect(addDocuments.firstCall.args[1]).to.deep.equal(["https://example.com/docs/page"]);
    expect(addDocuments.firstCall.args[2].loaderOptions).to.deep.equal({ fileType: "web" });
    expect(reports).to.deep.equal([
      { message: "chunking", increment: 25 },
      { message: "embedding", increment: 25 },
      { message: "Complete!" },
    ]);
    expect(info.lastCall.args[0]).to.equal('Web page added to "Docs" successfully! Total: 2 documents, 9 chunks.');
    expect(showError.args).to.deep.equal([]);
  });

  it("add GitHub repository reserves the first 10% of the bar for the repository listing", async function () {
    const { invoke, addDocuments, progressOptions, reports, info, showError } = await setUpIngestCommands({
      listHosts: async () => ["github.com"],
      getToken: async () => "ghp_saved",
    });
    sinon.stub(vscode.window, "showQuickPick").resolves({ label: "github.com", value: "github.com" } as never);
    const input = sinon.stub(vscode.window, "showInputBox");
    input.onFirstCall().resolves("facebook/react");
    input.onSecondCall().resolves("develop");
    input.onThirdCall().resolves("*.test.*, docs/**");

    await invoke(COMMANDS.ADD_GITHUB_REPO);

    expect(progressOptions.map((options) => options.title)).to.deep.equal(["Processing GitHub repository..."]);
    expect(addDocuments.firstCall.args[1]).to.deep.equal(["https://github.com/facebook/react"]);
    expect(addDocuments.firstCall.args[2].loaderOptions).to.deep.equal({
      fileType: "github",
      branch: "develop",
      recursive: true,
      ignorePaths: ["*.test.*", "docs/**"],
      accessToken: "ghp_saved",
      maxConcurrency: 10,
    });
    // 10 for the listing, then the pipeline's movement scaled into the remaining 90.
    expect(reports).to.deep.equal([
      { message: "Fetching repository structure (this may take a while)...", increment: 10 },
      { message: "chunking", increment: 22.5 },
      { message: "embedding", increment: 22.5 },
      { message: "Complete!" },
    ]);
    expect(info.lastCall.args[0]).to.equal(
      'GitHub repository added to "Docs" successfully! Total: 2 documents, 9 chunks.',
    );
    expect(showError.args).to.deep.equal([]);
  });
});
