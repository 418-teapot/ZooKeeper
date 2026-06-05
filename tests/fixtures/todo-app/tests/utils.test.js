const { describe, it } = require("node:test");
const assert = require("node:assert");
const { calculateTotal } = require("../src/utils.js");

describe("calculateTotal", () => {
  it("returns 0 for empty array", () => {
    assert.strictEqual(calculateTotal([]), 0);
  });

  it("sums item prices", () => {
    assert.strictEqual(
      calculateTotal([{ price: 10 }, { price: 20 }]),
      30
    );
  });

  it("returns 0 when called with no arguments", () => {
    // This test fails: calculateTotal() throws on undefined.reduce
    assert.strictEqual(calculateTotal(), 0);
  });
});