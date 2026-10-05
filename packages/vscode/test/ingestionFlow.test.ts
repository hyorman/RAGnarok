import { expect } from "chai";
import sinon from "sinon";
import * as vscode from "vscode";
import { DocumentLoaderFactory, type Topic } from "@ragnarok/core";
import {
  ingestWithProgress,
  pickWritableTopic,
  supportedDocumentFilters,
  type IngestionRequest,
} from "../src/ingestionFlow";

const topic = (id: string, name = id) => ({ id, name, documentCount: 0 }) as unknown as Topic;

type Report = { message?: string; increment?: number };

/** The progress the pipeline reports for one successfully ingested source (`documentPipeline.ts`): absolute, 0 to 100. */
const PIPELINE_STAGES = [0, 10, 25, 50, 70, 70, 90, 100, 100];

/**
 * Runs `ingestWithProgress` against a pipeline that reports `PIPELINE_STAGES` once per source, restarting at 0 for
 * each source as the real one does, and returns what the progress notification was told.
 */
async function reportsFor(sources: string[], request: Partial<IngestionRequest> = {}): Promise<Report[]> {
  const reports: Report[] = [];
  sinon
    .stub(vscode.window, "withProgress")
    .callsFake((async (_options: unknown, task: (progress: { report(value: unknown): void }) => Promise<unknown>) =>
      task({ report: (value) => reports.push(value as Report) })) as never);
  sinon.stub(vscode.window, "showInformationMessage").resolves(undefined);
  await ingestWithProgress(
    {
      topicManager: {
        addDocuments: async (_id: string, filePaths: string[], options?: { onProgress?: (p: never) => void }) => {
          for (const source of filePaths) {
            for (const progress of PIPELINE_STAGES) {
              options?.onProgress?.({ message: `${source} at ${progress}`, progress } as never);
            }
          }
          return filePaths.map(() => ({
            pipelineResult: { metadata: { chunksStored: 1, originalDocuments: 1 } },
          })) as never;
        },
        getTopicStats: async () => null,
      },
      refresh: () => undefined,
    },
    topic("t1"),
    sources,
    { title: "t", label: "Documents", loaderOptions: {}, progressShare: 1, ...request },
  );
  return reports;
}

const increments = (reports: Report[]): number[] => reports.map((report) => report.increment ?? 0);
const total = (values: number[]): number => values.reduce((sum, value) => sum + value, 0);

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

  it("derives the per-type groups from core too, so an extension core adds to a type reaches its group", function () {
    expect(supportedDocumentFilters()).to.deep.include({
      PDF: ["pdf"],
      Markdown: ["md", "markdown"],
      HTML: ["html", "htm"],
      Text: ["txt"],
    });

    sinon.stub(DocumentLoaderFactory, "getSupportedExtensionsByType").returns({
      pdf: [".pdf"],
      markdown: [".md", ".markdown", ".mdx"],
      html: [".html", ".htm"],
      text: [".txt"],
    });
    expect(supportedDocumentFilters().Markdown).to.deep.equal(["md", "markdown", "mdx"]);
  });

  it("offers no group for a labelled type that has no extensions", function () {
    sinon.stub(DocumentLoaderFactory, "getSupportedExtensionsByType").returns({
      pdf: [".pdf"],
      markdown: [],
      html: [".html", ".htm"],
      text: [".txt"],
    });
    expect(Object.keys(supportedDocumentFilters())).to.deep.equal([
      "All Files",
      "Supported Documents",
      "PDF",
      "HTML",
      "Text",
    ]);
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
      { title: "Processing documents...", label: "Documents", loaderOptions: {}, progressShare: 1 },
    );
    expect(reports).to.deep.equal([{ message: "chunking", increment: 50 }, { message: "Complete!" }]);
    expect(info.args.map((call) => call[0])).to.deep.equal([
      'Documents added to "Docs" successfully! Total: 2 documents, 9 chunks.',
    ]);
    expect(refreshed).to.equal(1);
  });

  // Progress.report takes increments, and the pipeline reports where it is, so the notification has to be told how
  // far it moved. Summing the raw stage numbers filled a 0.9 share about five times over.
  it("reports the movement between pipeline stages, not the stage numbers themselves", async function () {
    const reports = await reportsFor(["/a.md"]);
    expect(increments(reports).slice(0, PIPELINE_STAGES.length)).to.deep.equal([0, 10, 15, 25, 20, 0, 20, 10, 0]);
  });

  it("fills exactly the request's share of the bar, on top of the initial step", async function () {
    const reports = await reportsFor(["/a.md"], {
      progressShare: 0.9,
      initialProgress: { message: "Fetching repository structure...", increment: 10 },
    });
    expect(reports[0]).to.deep.equal({ message: "Fetching repository structure...", increment: 10 });
    expect(total(increments(reports))).to.be.closeTo(100, 1e-9);
  });

  it("splits the share across sources, because the pipeline starts again at 0 for each one", async function () {
    const reports = await reportsFor(["/a.md", "/b.md"]);
    const moved = increments(reports);
    expect(total(moved)).to.be.closeTo(100, 1e-9);
    expect(moved.every((value) => value >= 0)).to.equal(true);
    // The second source's first report restarts at 0 and must not move the bar.
    expect(moved[PIPELINE_STAGES.length]).to.equal(0);
  });

  // Review Focus 1: a bad file among good ones stops its pipeline part-way; the next source starts again at 0.
  it("never overfills the bar when a source stops part-way", async function () {
    const reports: Report[] = [];
    sinon
      .stub(vscode.window, "withProgress")
      .callsFake((async (_options: unknown, task: (progress: { report(value: unknown): void }) => Promise<unknown>) =>
        task({ report: (value) => reports.push(value as Report) })) as never);
    sinon.stub(vscode.window, "showInformationMessage").resolves(undefined);
    await ingestWithProgress(
      {
        topicManager: {
          addDocuments: async (_id: string, filePaths: string[], options?: { onProgress?: (p: never) => void }) => {
            // The first source fails after chunking; the second completes.
            for (const progress of [0, 10, 25, 50]) {
              options?.onProgress?.({ message: `a at ${progress}`, progress } as never);
            }
            for (const progress of PIPELINE_STAGES) {
              options?.onProgress?.({ message: `b at ${progress}`, progress } as never);
            }
            return filePaths.slice(1).map(() => ({
              pipelineResult: { metadata: { chunksStored: 1, originalDocuments: 1 } },
            })) as never;
          },
          getTopicStats: async () => null,
        },
        refresh: () => undefined,
      },
      topic("t1"),
      ["/a.md", "/b.md"],
      { title: "t", label: "Documents", loaderOptions: {}, progressShare: 1 },
    );
    const moved = increments(reports);
    expect(moved.every((value) => value >= 0)).to.equal(true);
    expect(total(moved)).to.be.at.most(100 + 1e-9);
    expect(reports[reports.length - 1]).to.deep.equal({ message: "Complete!" });
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
