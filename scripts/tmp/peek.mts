import { readFileSync } from "node:fs";
import { scoreAirports } from "../../lib/scoring/index";
import type { Dataset } from "../../lib/scoring/types";

const ds: Dataset = JSON.parse(readFileSync("data/airports.json", "utf8"));
console.log("meta:", JSON.stringify(ds.meta.flight_window), "airports:", ds.airports.length);

const dupes = new Map<string, number>();
for (const a of ds.airports) dupes.set(a.code, (dupes.get(a.code) ?? 0) + 1);
console.log("duplicate codes:", [...dupes].filter(([, n]) => n > 1).slice(0, 10));

const rows = scoreAirports(ds.airports);
const scored = rows.filter((r) => r.rus !== null).sort((a, b) => b.rus! - a.rus!);
console.log(`\nscored ${scored.length} / ${rows.length}`);

const line = (r: (typeof rows)[number]) =>
  `${(r.airport.code ?? "?").padEnd(4)} ${String(r.airport.hub ?? "-")} ${String(r.rus).padStart(5)} ±${String(r.band).padStart(4)} ` +
  `${(r.driver ?? "-").padEnd(10)} dep=${String(r.airport.departures ?? "-").padStart(6)} ` +
  `delay=${(r.airport.avg_dep_delay_min ?? NaN).toFixed(1).padStart(5)} taxi80=${(r.airport.p80_taxi_out_min ?? NaN).toFixed(0).padStart(3)} ` +
  `rwy=${String(r.airport.runways ?? "-")} peak=${(r.airport.peak_hour_movements ?? NaN).toFixed(0).padStart(3)} ` +
  `enp24=${(r.airport.enp_2024 ?? 0).toLocaleString().padStart(11)} ${r.airport.name?.slice(0, 28)}`;

console.log("\n--- top 15 by RUS ---");
for (const r of scored.slice(0, 15)) console.log(line(r));

console.log("\n--- bottom 5 ---");
for (const r of scored.slice(-5)) console.log(line(r));

console.log("\n--- named airports ---");
for (const c of ["SFO", "LAX", "SNA", "BUR", "LGB", "ANC", "BOS", "BDL", "PVD", "MHT", "JFK", "EWR", "ATL"]) {
  const r = rows.find((x) => x.airport.code === c);
  console.log(r ? line(r) : `${c}  MISSING`);
}

const anc = ds.airports.find((a) => a.code === "ANC")!;
console.log(
  "\nANC haul mix (domestic departures): short",
  (anc.share_short_haul! * 100).toFixed(1) + "%",
  "medium",
  (anc.share_medium_haul! * 100).toFixed(1) + "%",
  "long",
  (anc.share_long_haul! * 100).toFixed(1) + "%",
  "| avg stage",
  anc.avg_stage_length_km?.toFixed(0),
  "km",
);

const sfo = rows.find((r) => r.airport.code === "SFO")!;
console.log("\nSFO components:");
for (const c of sfo.components) {
  console.log(
    ` ${c.label.padEnd(22)} value=${c.value === null ? "null" : c.value.toFixed(3)} points=${c.points.toFixed(1)}`,
  );
  for (const i of c.inputs) {
    console.log(
      `   ${i.label.padEnd(42)} raw=${i.raw === null ? "null" : Number(i.raw).toFixed(3).padStart(12)} norm=${
        i.normalized === null ? "null" : i.normalized.toFixed(3)
      } peerMed=${i.peerMedian === null ? "null" : Number(i.peerMedian).toFixed(3)}`,
    );
  }
}
