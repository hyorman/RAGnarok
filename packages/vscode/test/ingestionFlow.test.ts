import { expect } from "chai";
import sinon from "sinon";
import * as vscode from "vscode";
import type { Topic } from "@ragnarok/core";
import { ingestWithProgress, pickWritableTopic, supportedDocumentFilters } from "../src/ingestionFlow";

const topic = (id: string, name = id) => ({ id, name, documentCount: 0 }) as unknown as Topic;

describe("ingestion flow", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("uses the tree item's topic without prompting", async function () {
    const quickPick = sinon.stub(vscode.window, "showQuickPick").resolves(undefined);
    const picked = await pickWritableTopic(
      { topicManager: { getAllTopics: () => [], isSharedTopic: () => false }, createTopic: async () => undefined },
      { topic: topic("t1") },
    );
    expect(picked?.id).to.equal("t1");
    expect(quickPick.called).to.equal(false);
  });

  it("refuses a shared topic with a warning", async function () {
    const warning = sinon.stub(vscode.window, "showWarningMessage").resolves(undefined);
    const picked = await pickWritableTopic(
      { topicManager: { getAllTopics: () => [], isSharedTopic: () => true }, createTopic: async () => undefined },
      { topic: topic("shared", "Team docs") },
    );
    expect(picked).to.equal(undefined);
    expect(warning.args.map((call) => call[0])).to.deep.equal([
      'Cannot add documents to "Team docs": shared topics are read-only.',
    ]);
  });

  it("offers to create a topic when there are none, then picks from the new list", async function () {
    let topics: Topic[] = [];
    sinon.stub(vscode.window, "showInformationMessage").resolves("Create Topic" as never);
    sinon
      .stub(vscode.window, "showQuickPick")
      .callsFake((async (items: Promise<readonly unknown[]> | readonly unknown[]) => (await items)[0]) as never);
    const picked = await pickWritableTopic(
      {
        topicManager: { getAllTopics: () => topics, isSharedTopic: () => false },
        createTopic: async () => {
          topics = [topic("new")];
        },
      },
      undefined,
    );
    expect(picked?.id).to.equal("new");
  });

  it("returns nothing when the user declines to create a topic", async function () {
    sinon.stub(vscode.window, "showInformationMessage").resolves(undefined);
    let created = false;
    const picked = await pickWritableTopic(
      {
        topicManager: { getAllTopics: () => [], isSharedTopic: () => false },
        createTopic: async () => {
          created = true;
        },
      },
      undefined,
    );
    expect(picked).to.equal(undefined);
    expect(created).to.equal(false);
  });

  it("derives dialog filters from core's supported extensions", function () {
    const filters = supportedDocumentFilters();
    expect(filters["Supported Documents"]).to.deep.equal(["pdf", "md", "markdown", "html", "htm", "txt"]);
    expect(Object.keys(filters)).to.deep.equal(["All Files", "Supported Documents", "PDF", "Markdown", "HTML", "Text"]);
  });

  it("reports progress, announces the new totals and refreshes the tree", async function () {
    const reports: Array<{ message?: string; increment?: number }> = [];
    sinon
      .stub(vscode.window, "withProgress")
      .callsFake((async (_options: unknown, task: (progress: { report(value: unknown): void }) => Promise<unknown>) =>
        task({ report: (value) => reports.push(value as { message?: string; increment?: number }) })) as never);
    const info = sinon.stub(vscode.window, "showInformationMessage").resolves(undefined);
    let refreshed = 0;
    await ingestWithProgress(
      {
        topicManager: {
          addDocuments: async (_id: string, _sources: string[], options?: { onProgress?: (p: never) => void }) => {
            options?.onProgress?.({ message: "chunking", progress: 50 } as never);
            return [{ pipelineResult: { metadata: { chunksStored: 3, originalDocuments: 1 } } }] as never;
          },
          getTopicStats: async () => ({ documentCount: 2, chunkCount: 9 }) as never,
        },
        refresh: () => {
          refreshed += 1;
        },
      },
      topic("t1", "Docs"),
      ["/a.md"],
      { title: "Processing documents...", label: "Documents", loaderOptions: {}, progressShare: 0.01 },
    );
    expect(reports).to.deep.equal([{ message: "chunking", increment: 0.5 }, { message: "Complete!" }]);
    expect(info.args.map((call) => call[0])).to.deep.equal([
      'Documents added to "Docs" successfully! Total: 2 documents, 9 chunks.',
    ]);
    expect(refreshed).to.equal(1);
  });

  it("stays silent and does not refresh when the operation is aborted", async function () {
    sinon
      .stub(vscode.window, "withProgress")
      .callsFake((async (_options: unknown, task: (progress: { report(value: unknown): void }) => Promise<unknown>) =>
        task({ report: () => undefined })) as never);
    const info = sinon.stub(vscode.window, "showInformationMessage").resolves(undefined);
    const controller = new AbortController();
    let refreshed = false;
    let error: unknown;
    try {
      await ingestWithProgress(
        {
          topicManager: {
            addDocuments: async () => {
              controller.abort(new Error("shutdown"));
              return [{ pipelineResult: { metadata: { chunksStored: 1, originalDocuments: 1 } } }] as never;
            },
            getTopicStats: async () => null,
          },
          refresh: () => {
            refreshed = true;
          },
        },
        topic("t1"),
        ["/a.md"],
        { title: "t", label: "Documents", loaderOptions: {}, progressShare: 0.01 },
        controller.signal,
      );
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).to.equal("shutdown");
    expect(info.called).to.equal(false);
    expect(refreshed).to.equal(false);
  });
});
