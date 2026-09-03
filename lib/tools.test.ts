/**
 * Integration tests over the real built dataset.
 *
 * These deliberately assert invariants rather than specific figures — the
 * numbers move when the ingest window changes, but "shares sum to 100" and
 * "results come back sorted" must hold for any vintage.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadDataset } from "./data";
import { findMetros, findRegion, findStates } from "./regions";
import {
  airportProfile,
  compareAirports,
  datasetInfo,
  explainScore,
  haulMix,
  rankAirports,
  resolveScope,
} from "./tools";

test("the dataset loaded and covers the airports we claim", () => {
  const ds = loadDataset();
  assert.ok(ds.airports.length > 300, `only ${ds.airports.length} airports`);
  assert.ok(ds.meta.flight_rows > 100_000);
  const codes = new Set(ds.airports.map((a) => a.code));
  for (const c of ["ATL", "LAX", "SFO", "JFK", "ANC", "BOS", "SNA", "BDL"]) {
    assert.ok(codes.has(c), `${c} missing from dataset`);
  }
  assert.equal(new Set(ds.airports.map((a) => a.code)).size, ds.airports.length, "duplicate codes");
});

test("hub classes are normalised to L/M/S/N", () => {
  for (const a of loadDataset().airports) {
    assert.ok(["L", "M", "S", "N", null].includes(a.hub), `${a.code} has hub ${a.hub}`);
  }
});

test('"New England" resolves to exactly the six states', () => {
  const r = findRegion("which airports in New England are candidates");
  assert.equal(r?.key, "new_england");
  assert.deepEqual(r?.states, ["ME", "NH", "VT", "MA", "RI", "CT"]);
});

test('"LA and Santa Ana" resolves to two distinct metros in the order asked', () => {
  const metros = findMetros("Compare LA and Santa Ana airport congestion levels.");
  assert.deepEqual(
    metros.map((m) => m.key),
    ["la", "orange_county"],
  );
  assert.equal(metros[0].codes[0], "LAX");
  assert.equal(metros[1].codes[0], "SNA");
});

test("state names and codes both resolve", () => {
  assert.deepEqual(findStates("airports in Maine").sort(), ["ME"]);
  assert.ok(findStates("airports in TX and NM").includes("TX"));
});

test("scope resolution reports how it read the question", () => {
  const scope = resolveScope({ region: "new_england" });
  assert.equal(scope.label, "New England");
  assert.match(scope.notes.join(" "), /ME, NH, VT, MA, RI, CT/);
});

test("ranking returns scored airports in descending order, inside scope", () => {
  const r = rankAirports({ region: "new_england" }, {}, 5);
  assert.ok(r.results.length > 0);
  const states = ["ME", "NH", "VT", "MA", "RI", "CT"];
  const ds = loadDataset();
  for (const row of r.results) {
    const a = ds.airports.find((x) => x.code === row.code)!;
    assert.ok(states.includes(a.state!), `${row.code} is in ${a.state}, outside New England`);
  }
  const scores = r.results.map((x) => x.rus!);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.ok(r.results.every((x) => x.rus! >= 0 && x.rus! <= 100));
});

test("weights change the ranking, and the payload says which weights were used", () => {
  const base = rankAirports({}, {}, 10);
  const growthOnly = rankAirports(
    {},
    { weights: { congestion: 0, headroom: 0, momentum: 1, unmet: 0, risk: 0 } },
    10,
  );
  assert.equal(base.weights.congestion, 0.3);
  assert.equal(growthOnly.weights.momentum, 1);
  assert.notDeepEqual(
    base.results.map((r) => r.code),
    growthOnly.results.map((r) => r.code),
  );
});

test("the screening floor keeps tiny airports out unless asked for", () => {
  const screened = rankAirports({}, {}, 500);
  const all = rankAirports({ includeSmall: true }, {}, 500);
  assert.ok(all.counted > screened.counted);
  const ds = loadDataset();
  for (const row of screened.results) {
    const a = ds.airports.find((x) => x.code === row.code)!;
    assert.ok((a.enp_2024 ?? 0) >= 100_000, `${row.code} is below the floor`);
  }
});

test("comparison returns every requested airport and flags cross-class scoring", () => {
  const r = compareAirports(["LAX", "SNA"], "congestion");
  assert.deepEqual(
    r.airports.map((a) => a.code),
    ["LAX", "SNA"],
  );
  assert.equal(r.missing.length, 0);
  // LAX is a large hub, SNA a medium hub: the payload must warn that their
  // scores were measured on different scales, and say so without jargon.
  assert.match(r.comparabilityNote, /different sizes/);
  assert.match(r.comparabilityNote, /Compare the raw figures, not the scores/);
  assert.doesNotMatch(r.comparabilityNote, /hub class|normalis/i);
});

test("comparison reports unknown codes instead of inventing them", () => {
  const r = compareAirports(["SFO", "ZZZ"], "overall");
  assert.deepEqual(r.missing, ["ZZZ"]);
  assert.equal(r.airports.length, 1);
});

test("haul mix shares sum to 100% and carry the domestic-only warning", () => {
  const r = haulMix("ANC");
  assert.ok(!("error" in r));
  const sum = (r.shortHaulPct ?? 0) + (r.mediumHaulPct ?? 0) + (r.longHaulPct ?? 0);
  assert.ok(Math.abs(sum - 100) < 0.5, `shares sum to ${sum}`);
  assert.match(r.scopeWarning!, /DOMESTIC/);
  assert.match(r.definition!.longHaul, /4000 km/);
});

test("explainScore returns raw inputs and peer medians, plus its own limits", () => {
  const r = explainScore("SFO", "unmet");
  assert.ok(!("error" in r));
  assert.equal(r.explanation!.length, 1);
  const c = r.explanation![0];
  assert.equal(c.key, "unmet");
  assert.ok(c.inputs.length >= 3);
  assert.ok(c.inputs.some((i) => i.raw !== null && i.peerMedian !== null));
  assert.ok(r.limits!.some((l) => /terminal or gate square footage/.test(l)));
});

test("the risk component is reported as subtracted", () => {
  const r = explainScore("SFO", "risk");
  assert.equal(r.explanation![0].direction, "subtracted from the score");
});

test("unknown airports produce an error, never a fabricated profile", () => {
  const r = airportProfile("ZZZ");
  assert.ok("error" in r);
  assert.match(r.error as string, /No airport with code ZZZ/);
});

test("every tool payload carries provenance", () => {
  const payloads: Record<string, unknown>[] = [
    rankAirports({}, {}, 1) as unknown as Record<string, unknown>,
    airportProfile("SFO") as unknown as Record<string, unknown>,
    compareAirports(["SFO", "LAX"]) as unknown as Record<string, unknown>,
    haulMix("ANC") as unknown as Record<string, unknown>,
    explainScore("SFO") as unknown as Record<string, unknown>,
    datasetInfo() as unknown as Record<string, unknown>,
  ];
  for (const p of payloads) {
    assert.ok(typeof p.provenance === "string" && p.provenance.length > 40, `${p.tool} lacks provenance`);
    assert.match(p.provenance as string, /BTS On-Time Performance/);
  }
});

test("datasetInfo states the window and the documented caveats", () => {
  const r = datasetInfo();
  assert.ok(r.window.months >= 1 && r.window.months <= 12);
  assert.ok(r.caveats.length >= 4);
  assert.ok(r.scored <= r.airports);
});
