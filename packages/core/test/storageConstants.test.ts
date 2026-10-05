import { expect } from "chai";
import * as constants from "../src/constants";
import * as embeddingService from "../src/embeddings/embeddingService";
import * as storage from "../src/utils/storage";
import * as storageDirectoryWatcher from "../src/utils/storageDirectoryWatcher";
import * as storageLock from "../src/utils/storageLock";
import * as storageTransactionCoordinator from "../src/utils/storageTransactionCoordinator";
import * as topicArchive from "../src/utils/topicArchive";

// Renaming any of these names orphans every existing store, reset backup or
// .rag archive, so each is pinned where the code reads it.
describe("storage names and shared timings", function () {
  it("names each on-disk and archive entry once", function () {
    expect(constants.EXTENSION).to.include({
      DATABASE_DIR: "database",
      TOPICS_INDEX_FILENAME: "topics.json",
      LANCEDB_DIR: "lancedb",
    });
    expect(topicArchive)
      .to.have.property("TOPIC_ARCHIVE_ENTRIES")
      .that.deep.equals({ MANIFEST: "manifest.json", TOPIC: "topic.json" });
    expect(storageTransactionCoordinator).to.have.property("TRANSACTIONS_DIRNAME", ".transactions");
    expect(storage).to.have.property("STORAGE_BACKUP_DIR_PREFIX", "backup-v1-");
  });

  it("shares one lease wait, one watch debounce and one fingerprint probe", function () {
    expect(storageLock).to.have.property("DEFAULT_LEASE_WAIT_MS", 5_000);
    expect(storageDirectoryWatcher).to.have.property("STORAGE_WATCH_DEBOUNCE_MS", 250);
    expect(embeddingService).to.have.property(
      "EMBEDDING_FINGERPRINT_PROBE_TEXT",
      "RAGnarok embedding fingerprint probe",
    );
  });
});
