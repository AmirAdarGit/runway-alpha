/**
 * The number check is what stands between a fluent answer and a wrong one, so
 * its false positives matter as much as its catches: an alarm that cries wolf
 * on every date gets ignored, and then it protects nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { verifyNumbers } from "./verify";

const payload = [
  {
    tool: "rankAirports",
    results: [
      { code: "BGR", rus: 56.7, enplanements2024: 376456 },
      { code: "PVD", rus: 50.5, enplanements2024: 1984916 },
    ],
    provenance: "BTS On-Time Performance, 2024-01-01 to 2024-12-31",
  },
];

test("a figure taken from the tool payload verifies", () => {
  const r = verifyNumbers("BGR scores 56.7 on 376,456 enplanements.", payload);
  assert.deepEqual(r.unverified, []);
  assert.ok(r.checked >= 2);
});

test("an invented figure is caught", () => {
  const r = verifyNumbers("BGR scores 91.4 and handled 8,300,000 passengers.", payload);
  assert.ok(r.unverified.includes("91.4"), `caught: ${r.unverified.join(", ")}`);
  assert.ok(r.unverified.some((u) => u.replace(/,/g, "") === "8300000"));
});

test("dates are not treated as claims", () => {
  const r = verifyNumbers("Data vintage: 2024-01-01 to 2024-12-31.", payload);
  assert.deepEqual(r.unverified, [], "a date should never be flagged");
});

test("thousands grouped with spaces read as one figure, not several", () => {
  // Models write "376 456" as often as "376,456"; splitting it invents numbers.
  for (const sep of [" ", " ", " "]) {
    const r = verifyNumbers(`BGR handled 376${sep}456 enplanements.`, payload);
    assert.deepEqual(r.unverified, [], `separator ${JSON.stringify(sep)} was mishandled`);
  }
});

test("rounding against a longer stored value still verifies", () => {
  const stored = [{ value: 18.723145 }];
  assert.deepEqual(verifyNumbers("Taxi-out was 18.7 minutes.", stored).unverified, []);
  assert.deepEqual(verifyNumbers("Taxi-out was 18.72 minutes.", stored).unverified, []);
});

test("a share stated as a percentage matches the stored fraction", () => {
  const stored = [{ cancel_rate: 0.0163 }];
  assert.deepEqual(verifyNumbers("Cancellations ran at 1.63%.", stored).unverified, []);
});

test("figures the user supplied are not held against the answer", () => {
  const r = verifyNumbers("Yes, above your 45.5 threshold.", payload, "is it above 45.5?");
  assert.deepEqual(r.unverified, []);
});

test("small integers and the documented weights are ignored as structural", () => {
  const r = verifyNumbers("The top 5 airports; congestion is weighted 0.3.", payload);
  assert.equal(r.unverified.length, 0);
});
