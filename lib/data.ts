import { readFileSync } from "node:fs";
import path from "node:path";
import type { Dataset } from "./scoring/types";

/**
 * The whole dataset is one JSON file built offline by scripts/ingest.
 * It is small enough (well under a megabyte) to hold in module scope, so
 * every request reads from memory and no database is involved at runtime.
 */
let cached: Dataset | null = null;

export function loadDataset(): Dataset {
  if (cached) return cached;
  const file = path.join(process.cwd(), "data", "airports.json");
  cached = JSON.parse(readFileSync(file, "utf8")) as Dataset;
  return cached;
}

/** Source-and-vintage line the agent must attach to any answer using this data. */
export function provenanceLine(ds: Dataset = loadDataset()): string {
  const { flight_window, enplanement_years } = ds.meta;
  return (
    `Flight operations: BTS On-Time Performance, ${flight_window.first_date} to ${flight_window.last_date} ` +
    `(${flight_window.months} of 12 months, domestic scheduled service by reporting carriers). ` +
    `Passengers: FAA ACAIS CY${enplanement_years[0]}-CY${enplanement_years.at(-1)} ` +
    `(CY${enplanement_years.at(-1)} preliminary). Runways: OurAirports. Catchment: US Census.`
  );
}
