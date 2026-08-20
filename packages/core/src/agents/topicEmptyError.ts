/**
 * Thrown when a topic exists but contains no documents.
 * Callers can catch this specifically to distinguish "empty topic" from real errors.
 *
 * Deliberately a leaf module with no imports. `tools/queryTool.ts` needs this class
 * as a value for its `instanceof` check, and importing it from `ragQueryService`
 * would pull the whole agent stack — LanceDB, transformers, langchain — into any
 * consumer that only wanted the tool contracts.
 */
export class TopicEmptyError extends Error {
  public readonly topicName: string;

  constructor(topicName: string) {
    super(`Topic "${topicName}" exists but has no documents. ` + `Add documents to the topic before querying.`);
    this.name = "TopicEmptyError";
    this.topicName = topicName;
  }
}
