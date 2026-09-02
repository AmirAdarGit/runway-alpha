/**
 * Stage 1 — fetch every raw source into data/raw/.
 * Idempotent: an existing, non-empty target file is left alone unless FORCE=1.
 *
 * Sources and why (see docs/plan.html §02):
 *   BTS On-Time      congestion, movement counts, haul mix, cancel/divert
 *   FAA ACAIS        enplanements + official hub class, CY2022..CY2025
 *   OurAirports      runways, coordinates, state
 *   Census bulk      county population + centroid for catchment
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const RAW = path.resolve("data/raw");
const FORCE = process.env.FORCE === "1";
const ONTIME_YEAR = Number(process.env.ONTIME_YEAR ?? 2024);
const ONTIME_MONTHS = (process.env.ONTIME_MONTHS ?? "1,2,3,4,5,6,7,8,9,10,11,12")
  .split(",")
  .map(Number);

const BTS_PREZIP =
  "https://transtats.bts.gov/PREZIP/On_Time_Reporting_Carrier_On_Time_Performance_1987_present";
const FAA_ENPLANE =
  "https://www.faa.gov/airports/planning_capacity/passenger_allcargo_stats/passenger";
const OURAIRPORTS = "https://davidmegginson.github.io/ourairports-data";

function have(file: string, minBytes = 1024) {
  return !FORCE && existsSync(file) && statSync(file).size >= minBytes;
}

async function get(url: string, dest: string, minBytes = 1024) {
  if (have(dest, minBytes)) {
    console.log(`  skip   ${path.basename(dest)} (already present)`);
    return true;
  }
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (!res.ok) {
    console.log(`  MISS   ${path.basename(dest)} — HTTP ${res.status}`);
    return false;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < minBytes) {
    console.log(`  MISS   ${path.basename(dest)} — only ${buf.length} bytes, looks like an error page`);
    return false;
  }
  await writeFile(dest, buf);
  console.log(`  ok     ${path.basename(dest)} (${(buf.length / 1e6).toFixed(1)} MB)`);
  return true;
}

/** BTS ships one zip per month; we keep only the extracted CSV. */
async function ontime(year: number, month: number) {
  const csv = path.join(RAW, `ontime_${year}_${month}.csv`);
  if (have(csv, 1e6)) {
    console.log(`  skip   ontime_${year}_${month}.csv (already extracted)`);
    return true;
  }
  const zip = path.join(RAW, `ontime_${year}_${month}.zip`);
  const got = await get(`${BTS_PREZIP}_${year}_${month}.zip`, zip, 1e6);
  if (!got) return false;
  // BTS names the inner file with spaces and a "(1)" suffix that varies by month,
  // so extract whatever single CSV is inside and rename it deterministically.
  const listing = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" })
    .split("\n")
    .filter((n) => n.toLowerCase().endsWith(".csv"));
  if (listing.length !== 1) {
    console.log(`  MISS   ${path.basename(zip)} — expected 1 CSV inside, found ${listing.length}`);
    return false;
  }
  execFileSync("unzip", ["-o", "-j", zip, listing[0], "-d", RAW], { stdio: "ignore" });
  execFileSync("mv", [path.join(RAW, path.basename(listing[0])), csv]);
  rmSync(zip);
  console.log(`  ok     ontime_${year}_${month}.csv (${(statSync(csv).size / 1e6).toFixed(0)} MB)`);
  return true;
}

/**
 * County population + county centroid, both from static Census files.
 * The ACS JSON API now requires a registered key; these bulk files do not,
 * which keeps the whole ingest runnable with zero credentials.
 */
async function census() {
  const pop = path.join(RAW, "county_population.csv");
  const gaz = path.join(RAW, "county_centroids.txt");
  let ok = true;

  if (!have(pop, 1e5)) {
    ok =
      (await get(
        "https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/counties/totals/co-est2024-alldata.csv",
        pop,
        1e5,
      )) && ok;
  } else console.log("  skip   county_population.csv (already present)");

  if (!have(gaz, 1e5)) {
    const zip = path.join(RAW, "gaz_counties.zip");
    if (
      await get(
        "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_counties_national.zip",
        zip,
        1e4,
      )
    ) {
      const inner = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean)[0];
      execFileSync("unzip", ["-o", "-j", zip, inner, "-d", RAW], { stdio: "ignore" });
      execFileSync("mv", [path.join(RAW, path.basename(inner)), gaz]);
      rmSync(zip);
      console.log("  ok     county_centroids.txt");
    } else ok = false;
  } else console.log("  skip   county_centroids.txt (already present)");

  return ok;
}

async function main() {
  mkdirSync(RAW, { recursive: true });
  const missing: string[] = [];

  console.log("OurAirports");
  for (const f of ["airports.csv", "runways.csv", "countries.csv", "regions.csv"]) {
    if (!(await get(`${OURAIRPORTS}/${f}`, path.join(RAW, f)))) missing.push(f);
  }

  console.log("FAA ACAIS enplanements");
  // Final years are published as arp-cyYYYY-...; the latest year is preliminary.
  const faa: [string, string][] = [
    ["arp-cy2024-commercial-service-enplanements.xlsx", "enplanements_2024.xlsx"],
    ["arp-cy2025-commercial-service-enplanements-preliminary.xlsx", "enplanements_2025.xlsx"],
    ["cy2023-commercial-service-enplanements.xlsx", "enplanements_2023.xlsx"],
    ["cy2022-commercial-service-enplanements.xlsx", "enplanements_2022.xlsx"],
  ];
  for (const [remote, local] of faa) {
    if (!(await get(`${FAA_ENPLANE}/${remote}`, path.join(RAW, local)))) missing.push(local);
  }

  console.log("Census");
  if (!(await census())) missing.push("census county files");

  console.log(`BTS On-Time ${ONTIME_YEAR} (${ONTIME_MONTHS.length} months, ~27 MB each)`);
  for (const m of ONTIME_MONTHS) {
    if (!(await ontime(ONTIME_YEAR, m))) missing.push(`ontime_${ONTIME_YEAR}_${m}`);
  }

  console.log("\n--- download summary ---");
  if (missing.length === 0) {
    console.log("all sources present");
  } else {
    // Missing sources are survivable: the build stage degrades the affected
    // component and marks the airport's confidence down rather than guessing.
    console.log(`missing (${missing.length}): ${missing.join(", ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
