import { expect } from "chai";
import { startStallWatchdog, suiteHooks, type StallReport } from "./helpers/suiteDiagnostics";

describe("suite diagnostics", function () {
  it("stays off unless RAGNAROK_REPORT_ACTIVE_RESOURCES is exactly 1, outside Windows", function () {
    for (const value of [undefined, "", "0", "false", "yes"]) {
      expect(suiteHooks({ RAGNAROK_REPORT_ACTIVE_RESOURCES: value }, "linux"), `value ${String(value)}`).to.deep.equal(
        {},
      );
    }
    expect(Object.keys(suiteHooks({ RAGNAROK_REPORT_ACTIVE_RESOURCES: "1" }, "linux")).sort()).to.deep.equal([
      "afterAll",
      "beforeAll",
      "beforeEach",
    ]);
  });

  it("arms the grace exit on Windows, and elsewhere only on request", function () {
    expect(Object.keys(suiteHooks({}, "win32"))).to.deep.equal(["afterAll"]);
    expect(Object.keys(suiteHooks({ RAGNAROK_TEST_FORCE_EXIT_GRACE: "1" }, "darwin"))).to.deep.equal(["afterAll"]);
    expect(suiteHooks({ RAGNAROK_TEST_FORCE_EXIT_GRACE: "0" }, "darwin")).to.deep.equal({});
  });

  it("names the test that blocks the event loop", async function () {
    this.timeout(5000);
    let resolveStall: (report: StallReport) => void = () => undefined;
    const stalled = new Promise<StallReport>((resolve) => {
      resolveStall = resolve;
    });
    const watchdog = startStallWatchdog({ stallMs: 300, heartbeatMs: 50, onStall: resolveStall, writeToStderr: false });
    try {
      await watchdog.ready;
      watchdog.testStarted("probe blocks the event loop");
      const end = Date.now() + 1000;
      while (Date.now() < end) {
        // Hold the main thread the way a native deadlock would: no timer on it can run.
      }
      const report = await stalled;
      expect(report.test).to.equal("probe blocks the event loop");
      expect(report.blockedMs).to.be.at.least(300);
    } finally {
      await watchdog.stop();
    }
  });
});
