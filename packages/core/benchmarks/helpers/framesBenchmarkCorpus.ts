import { Document as LangChainDocument } from "@langchain/core/documents";
import { formatSampleSelection, sampleDeterministically } from "./benchmarkSampling";
import { downloadFrames, fetchWikipediaArticle, FramesEntry, loadFramesEntries } from "./framesLoader";

export interface PreparedFramesBenchmarkCorpus {
  allEntriesCount: number;
  eligibleEntriesCount: number;
  sampledEntries: FramesEntry[];
  docs: LangChainDocument[];
  entryQrels: Map<number, Map<string, number>>;
  uniqueUrlCount: number;
  fetchedArticleCount: number;
}

export async function prepareFramesBenchmarkCorpus(options: {
  cacheDir: string;
  articleCacheDir: string;
  sampleSize: number | null;
  sampleEnvVarName: string;
  log?: (message: string) => void;
}): Promise<PreparedFramesBenchmarkCorpus> {
  const { cacheDir, articleCacheDir, sampleSize, sampleEnvVarName, log = console.log } = options;

  const tsvPath = await downloadFrames(cacheDir);
  const allEntries = await loadFramesEntries(tsvPath);
  const eligibleEntries = allEntries.filter((entry) => entry.wikiLinks.length > 0);
  const sampledEntries = sampleDeterministically(eligibleEntries, sampleSize);

  const allUrls = new Set<string>();
  for (const entry of sampledEntries) {
    for (const url of entry.wikiLinks) {
      allUrls.add(url);
    }
  }

  log(
    `FRAMES: ${allEntries.length} total entries, ${eligibleEntries.length} eligible, ${formatSampleSelection(
      eligibleEntries.length,
      sampledEntries.length,
      sampleEnvVarName,
      sampleSize,
    )}, ${allUrls.size} unique Wikipedia URLs`,
  );

  const articleMap = new Map<string, { title: string; text: string }>();
  const urls = Array.from(allUrls);
  let completed = 0;
  const CONCURRENCY = 10;

  async function fetchOne(url: string): Promise<void> {
    const article = await fetchWikipediaArticle(url, articleCacheDir);
    if (article && article.text.length > 0) {
      articleMap.set(url, article);
    }
    completed++;
    if (completed % 100 === 0) {
      log(`  Fetched ${completed}/${urls.length} articles (${articleMap.size} ok)...`);
    }
  }

  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(fetchOne));
  }

  log(`  Fetched ${articleMap.size} articles (${urls.length - articleMap.size} failed/empty)`);

  const docs = Array.from(articleMap.entries()).map(
    ([url, article]) =>
      new LangChainDocument({
        pageContent: `${article.title}\n\n${article.text}`,
        metadata: { id: url, source: url, title: article.title },
      }),
  );

  const entryQrels = new Map<number, Map<string, number>>();
  for (const entry of sampledEntries) {
    const qrels = new Map<string, number>();
    for (const url of entry.wikiLinks) {
      if (articleMap.has(url)) {
        qrels.set(url, 1);
      }
    }
    entryQrels.set(entry.id, qrels);
  }

  return {
    allEntriesCount: allEntries.length,
    eligibleEntriesCount: eligibleEntries.length,
    sampledEntries,
    docs,
    entryQrels,
    uniqueUrlCount: allUrls.size,
    fetchedArticleCount: articleMap.size,
  };
}
