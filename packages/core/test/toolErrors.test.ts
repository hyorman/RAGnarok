import { expect } from "chai";
import * as os from "os";
import { classifyToolError } from "../src/tools/toolErrors";
import { StorageBusyError } from "../src/utils/storageLock";
import { SharedTopicReadOnlyError } from "../src/sharedTopics/types";

describe("tool error classification", function () {
  it("classifies a busy storage lease with a retry message and the holder pid", function () {
    const error = new StorageBusyError("/tmp/x/.ragnarok.lock", {
      pid: 4242,
      hostname: os.hostname(),
      acquiredAt: Date.now(),
    });

    const classified = classifyToolError(error);

    expect(classified.kind).to.equal("storage-busy");
    expect(classified.holderPid).to.equal(4242);
    expect(classified.message.toLowerCase()).to.contain("busy");
    expect(classified.message.toLowerCase()).to.contain("retry");
  });

  it("classifies a shared-topic refusal and keeps the topic name in the message", function () {
    const error = new SharedTopicReadOnlyError("shared-abc123", "API Docs", "delete");

    const classified = classifyToolError(error);

    expect(classified.kind).to.equal("shared-topic-read-only");
    expect(classified.message).to.contain("API Docs");
  });

  it("passes an ordinary error through as generic, preserving its message", function () {
    const classified = classifyToolError(new Error("disk on fire"));

    expect(classified.kind).to.equal("generic");
    expect(classified.message).to.equal("disk on fire");
  });

  it("does not crash on a thrown non-Error", function () {
    // A string, null or undefined reaches an error path. The last case is a
    // plain object carrying a matching `name` on purpose: classification must
    // require a real Error, so a look-alike payload cannot claim a retryable
    // kind and talk a caller into retrying something that will never succeed.
    for (const thrown of ["a string", null, undefined, 42, { name: "StorageBusyError" }]) {
      const classified = classifyToolError(thrown);

      expect(classified.kind, String(thrown)).to.equal("generic");
      expect(typeof classified.message, String(thrown)).to.equal("string");
    }
  });
});
