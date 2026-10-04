import { expect } from "chai";
import { isFiniteNumber, isRecord } from "../src/utils/typeGuards";

describe("type guards", function () {
  it("isRecord accepts plain objects only", function () {
    expect(isRecord({})).to.equal(true);
    expect(isRecord({ a: 1 })).to.equal(true);
    for (const value of [null, undefined, [], [{}], "x", 1, true]) {
      expect(isRecord(value), `isRecord(${String(value)})`).to.equal(false);
    }
  });

  it("isFiniteNumber accepts finite numbers only", function () {
    for (const value of [0, -1, 1.5]) {
      expect(isFiniteNumber(value), `isFiniteNumber(${value})`).to.equal(true);
    }
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1", null, undefined]) {
      expect(isFiniteNumber(value), `isFiniteNumber(${String(value)})`).to.equal(false);
    }
  });
});
