/**
 * Tests for the deterministic core. Fixtures are synthetic on purpose: the
 * point is that the arithmetic is right, not that a particular airport ranks
 * where we expect. Run with `npm test`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_WEIGHTS, median, scoreAirports } from "./index";
import type { AirportRecord } from "./types";

/** A fully-measured airport; individual tests override the fields they care about. */
function airport(code: string, over: Partial<AirportRecord> = {}): AirportRecord {
  return {
    code,
    ident: `K${code}`,
    name: `${code} Field`,
    city: "Somewhere",
    state: "XX",
    lat: 40,
    lon: -100,
    type: "medium_airport",
    hub: "M",
    faa_name: null,
    enp_2023: 1_000_000,
    enp_2024: 1_050_000,
    enp_2025: 1_100_000,
    runways: 2,
    longest_runway_ft: 9000,
    sched_departures: 20_000,
    departures: 19_500,
    arrivals: 19_400,
    movements: 38_900,
    departures_annualised: 19_500,
    movements_annualised: 38_900,
    screened: true,
    avg_dep_delay_min: 12,
    p80_dep_delay_min: 20,
    share_dep_delayed_15: 0.2,
    avg_arr_delay_min: 10,
    avg_taxi_out_min: 15,
    p80_taxi_out_min: 19,
    cancel_rate: 0.02,
    divert_rate: 0.003,
    peak_hour_movements: 30,
    max_hour_movements: 45,
    carrier_hhi: 0.3,
    top_carrier: "AA",
    top_carrier_share: 0.5,
    carriers: 6,
    share_short_haul: 0.6,
    share_medium_haul: 0.35,
    share_long_haul: 0.05,
    avg_stage_length_km: 1200,
    max_stage_length_km: 4200,
    weather_nas_delay_share: 0.4,
    catchment_pop: 2_000_000,
    pax_per_departure: 53.8,
    enp_per_capita: 0.52,
    runway_utilisation: 0.097,
    enp_cagr_2yr: 0.049,
    enp_growth_last_yr: 0.048,
    ...over,
  };
}

/** Ten peers spread across the input ranges, so scales are well defined. */
function peerGroup(n = 10): AirportRecord[] {
  return Array.from({ length: n }, (_, i) =>
    airport(`P${i.toString().padStart(2, "0")}`, {
      avg_dep_delay_min: 5 + i * 2,
      p80_taxi_out_min: 12 + i * 2,
      peak_hour_movements: 10 + i * 5,
      runway_utilisation: 0.05 + i * 0.02,
      enp_2024: 500_000 + i * 200_000,
      enp_cagr_2yr: -0.02 + i * 0.01,
      enp_growth_last_yr: -0.01 + i * 0.008,
      pax_per_departure: 40 + i * 4,
      cancel_rate: 0.005 + i * 0.004,
      catchment_pop: 500_000 + i * 400_000,
      carrier_hhi: 0.15 + i * 0.05,
      weather_nas_delay_share: 0.2 + i * 0.04,
    }),
  );
}

const byCode = (rows: ReturnType<typeof scoreAirports>, code: string) =>
  rows.find((r) => r.airport.code === code)!;

test("every scored airport lands in 0-100", () => {
  for (const r of scoreAirports(peerGroup())) {
    assert.ok(r.rus !== null, `${r.airport.code} should be scored`);
    assert.ok(r.rus! >= 0 && r.rus! <= 100, `${r.airport.code} = ${r.rus}`);
  }
});

test("scoring is deterministic across runs", () => {
  const a = scoreAirports(peerGroup()).map((r) => r.rus);
  const b = scoreAirports(peerGroup()).map((r) => r.rus);
  assert.deepEqual(a, b);
});

test("more congestion raises the score, all else equal", () => {
  const peers = peerGroup();
  const calm = airport("CLM", {
    avg_dep_delay_min: 4,
    p80_taxi_out_min: 10,
    peak_hour_movements: 8,
  });
  const jammed = airport("JAM", {
    avg_dep_delay_min: 40,
    p80_taxi_out_min: 45,
    peak_hour_movements: 70,
  });
  const rows = scoreAirports([...peers, calm, jammed]);
  assert.ok(byCode(rows, "JAM").rus! > byCode(rows, "CLM").rus!);
});

test("the risk component is subtracted, not added", () => {
  const peers = peerGroup();
  const clean = airport("CLN", { carrier_hhi: 0.1, weather_nas_delay_share: 0.1 });
  const risky = airport("RSK", { carrier_hhi: 0.9, weather_nas_delay_share: 0.9 });
  const rows = scoreAirports([...peers, clean, risky]);
  assert.ok(byCode(rows, "RSK").rus! < byCode(rows, "CLN").rus!);
  assert.ok(byCode(rows, "RSK").components.find((c) => c.key === "risk")!.points < 0);
});

test("an airport missing two or more components is not scored", () => {
  const peers = peerGroup();
  const sparse = airport("SPR", {
    // No flight data at all: congestion and unmet both lose their inputs.
    departures: null,
    arrivals: null,
    avg_dep_delay_min: null,
    p80_taxi_out_min: null,
    peak_hour_movements: null,
    cancel_rate: null,
    divert_rate: null,
    pax_per_departure: null,
    catchment_pop: null,
    carrier_hhi: null,
    weather_nas_delay_share: null,
    runway_utilisation: null,
  });
  const row = byCode(scoreAirports([...peers, sparse]), "SPR");
  assert.equal(row.rus, null);
  assert.match(row.excludedReason ?? "", /insufficient data/);
});

test("thin flight samples drop delay inputs rather than trusting them", () => {
  const peers = peerGroup();
  // 40 departures in a year: the delay average is real but statistically empty.
  const tiny = airport("TNY", { departures: 40, avg_dep_delay_min: 90 });
  const row = byCode(scoreAirports([...peers, tiny]), "TNY");
  const congestion = row.components.find((c) => c.key === "congestion")!;
  assert.equal(congestion.inputs.find((i) => i.key === "avg_dep_delay_min")!.normalized, null);
  assert.ok(row.confidence < 0.8);
});

test("confidence and band move in opposite directions", () => {
  const rows = scoreAirports([
    ...peerGroup(),
    airport("FUL"),
    airport("PRT", { catchment_pop: null, enp_2025: null, enp_cagr_2yr: null }),
  ]);
  const full = byCode(rows, "FUL");
  const partial = byCode(rows, "PRT");
  assert.ok(full.confidence > partial.confidence);
  assert.ok(full.band < partial.band);
});

test("outliers are winsorised, so one extreme airport cannot flatten the scale", () => {
  const peers = peerGroup();
  const normal = scoreAirports([...peers, airport("MID", { avg_dep_delay_min: 15 })]);
  const withMonster = scoreAirports([
    ...peers,
    airport("MID", { avg_dep_delay_min: 15 }),
    airport("MON", { avg_dep_delay_min: 100_000 }),
  ]);
  const before = byCode(normal, "MID").components.find((c) => c.key === "congestion")!;
  const after = byCode(withMonster, "MID").components.find((c) => c.key === "congestion")!;
  const delta = Math.abs(before.value! - after.value!);
  assert.ok(delta < 0.15, `outlier moved MID's congestion by ${delta.toFixed(3)}`);
});

test("weights are honoured — a congestion-only thesis reorders the board", () => {
  const peers = peerGroup();
  const jammedButShrinking = airport("JBS", {
    avg_dep_delay_min: 40,
    p80_taxi_out_min: 45,
    peak_hour_movements: 70,
    enp_cagr_2yr: -0.05,
    enp_growth_last_yr: -0.04,
  });
  const calmButGrowing = airport("CBG", {
    avg_dep_delay_min: 4,
    p80_taxi_out_min: 10,
    peak_hour_movements: 8,
    enp_cagr_2yr: 0.09,
    enp_growth_last_yr: 0.08,
  });
  const pool = [...peers, jammedButShrinking, calmButGrowing];

  const growthThesis = scoreAirports(pool, {
    weights: { congestion: 0, headroom: 0, momentum: 1, unmet: 0, risk: 0 },
  });
  const congestionThesis = scoreAirports(pool, {
    weights: { congestion: 1, headroom: 0, momentum: 0, unmet: 0, risk: 0 },
  });

  assert.ok(byCode(growthThesis, "CBG").rus! > byCode(growthThesis, "JBS").rus!);
  assert.ok(byCode(congestionThesis, "JBS").rus! > byCode(congestionThesis, "CBG").rus!);
});

test("component points sum to the reported score", () => {
  for (const r of scoreAirports(peerGroup())) {
    const sum = r.components
      .filter((c) => c.value !== null)
      .reduce((s, c) => s + c.points, 0);
    assert.ok(Math.abs(sum - r.rus!) < 0.06, `${r.airport.code}: ${sum} vs ${r.rus}`);
  }
});

test("small peer groups are pooled instead of scaled on their own", () => {
  const rows = scoreAirports([
    ...peerGroup(),
    airport("SOL", { hub: "L" }), // the only large hub present
  ]);
  assert.equal(byCode(rows, "SOL").peerGroup, "All airports");
});

test("default weights are the documented thesis", () => {
  assert.deepEqual(DEFAULT_WEIGHTS, {
    congestion: 0.3,
    headroom: 0.25,
    momentum: 0.2,
    unmet: 0.15,
    risk: 0.1,
  });
  const positive =
    DEFAULT_WEIGHTS.congestion +
    DEFAULT_WEIGHTS.headroom +
    DEFAULT_WEIGHTS.momentum +
    DEFAULT_WEIGHTS.unmet;
  assert.equal(Math.round(positive * 100) / 100, 0.9);
});

test("median handles empties and evens", () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});
