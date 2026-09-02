/**
 * Stage 2 — turn data/raw/* into one compact artifact: data/airports.json
 *
 * DuckDB is used purely as an offline ETL engine. Nothing ships at runtime
 * except the JSON, which holds RAW MEASURED METRICS ONLY — no scores.
 * Scoring lives in lib/scoring so the app can recompute it live when an
 * analyst changes the weights.
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const RAW = path.resolve("data/raw");
const OUT = path.resolve("data/airports.json");

const MI_TO_KM = 1.609344;
/** Haul buckets, in km. Restated by the agent whenever it reports a haul figure. */
const HAUL_MEDIUM_KM = 1500;
const HAUL_LONG_KM = 4000;
/** Rule-of-thumb annual operations one runway can absorb before it binds. */
const OPS_PER_RUNWAY = 200_000;
/** Catchment radius. A stand-in for a drive-time isochrone. */
const CATCHMENT_KM = 100;

const db = await DuckDBInstance.create(":memory:");
const con = await db.connect();
const sql = async (q: string) => {
  await con.run(q);
};
const rows = async <T = Record<string, unknown>,>(q: string) =>
  (await (await con.run(q)).getRowObjectsJson()) as T[];

function ontimeFiles() {
  if (!existsSync(RAW)) return [];
  return readdirSync(RAW).filter((f) => /^ontime_\d{4}_\d+\.csv$/.test(f)).sort();
}

const months = ontimeFiles();
if (months.length === 0) {
  console.error("No ontime_*.csv in data/raw — run `npm run ingest:download` first.");
  process.exit(1);
}
console.log(`on-time months: ${months.length} (${months[0]} … ${months.at(-1)})`);

await sql("INSTALL excel; LOAD excel;");

/* ---------------------------------------------------------------- flights */
// union_by_name because BTS adds and drops trailing columns between years.
await sql(`
  CREATE VIEW flights AS
  SELECT * FROM read_csv(
    '${RAW}/ontime_*.csv',
    header = true, union_by_name = true, ignore_errors = true, sample_size = -1
  )
`);

const [{ n_flights, first_date, last_date }] = await rows<{
  n_flights: string; first_date: string; last_date: string;
}>(`SELECT count(*)::VARCHAR AS n_flights,
           min(FlightDate)::VARCHAR AS first_date,
           max(FlightDate)::VARCHAR AS last_date
    FROM flights`);
console.log(`flight rows: ${Number(n_flights).toLocaleString()}  ${first_date} → ${last_date}`);

/* ------------------------------------------------------- departure metrics */
await sql(`
  CREATE TABLE dep AS
  SELECT
    Origin AS code,
    count(*)                                              AS sched_departures,
    count(*) FILTER (WHERE Cancelled = 0)                 AS departures,
    avg(DepDelayMinutes) FILTER (WHERE Cancelled = 0)     AS avg_dep_delay_min,
    quantile_cont(DepDelayMinutes, 0.8)
      FILTER (WHERE Cancelled = 0)                        AS p80_dep_delay_min,
    avg(TaxiOut) FILTER (WHERE Cancelled = 0)             AS avg_taxi_out_min,
    quantile_cont(TaxiOut, 0.8) FILTER (WHERE Cancelled = 0) AS p80_taxi_out_min,
    avg(CASE WHEN Cancelled = 0 AND DepDel15 = 1 THEN 1.0
             WHEN Cancelled = 0 THEN 0.0 END)             AS share_dep_delayed_15,
    sum(Cancelled)::DOUBLE / nullif(count(*), 0)          AS cancel_rate,
    sum(Diverted)::DOUBLE / nullif(count(*), 0)           AS divert_rate,
    sum(coalesce(WeatherDelay, 0))                        AS weather_delay_min,
    sum(coalesce(NASDelay, 0))                            AS nas_delay_min,
    sum(coalesce(CarrierDelay, 0))                        AS carrier_delay_min,
    sum(coalesce(LateAircraftDelay, 0))                   AS late_aircraft_delay_min,
    sum(coalesce(SecurityDelay, 0))                       AS security_delay_min,
    count(DISTINCT Reporting_Airline)                     AS carriers,
    -- haul mix, on performed departures, distance converted mi → km
    avg(CASE WHEN Cancelled = 0 THEN
      CASE WHEN Distance * ${MI_TO_KM} < ${HAUL_MEDIUM_KM} THEN 1.0 ELSE 0.0 END END) AS share_short_haul,
    avg(CASE WHEN Cancelled = 0 THEN
      CASE WHEN Distance * ${MI_TO_KM} >= ${HAUL_MEDIUM_KM}
            AND Distance * ${MI_TO_KM} < ${HAUL_LONG_KM} THEN 1.0 ELSE 0.0 END END) AS share_medium_haul,
    avg(CASE WHEN Cancelled = 0 THEN
      CASE WHEN Distance * ${MI_TO_KM} >= ${HAUL_LONG_KM} THEN 1.0 ELSE 0.0 END END) AS share_long_haul,
    avg(Distance * ${MI_TO_KM}) FILTER (WHERE Cancelled = 0) AS avg_stage_length_km,
    max(Distance * ${MI_TO_KM}) FILTER (WHERE Cancelled = 0) AS max_stage_length_km
  FROM flights
  GROUP BY Origin
`);

/* --------------------------------------------------------- arrival metrics */
await sql(`
  CREATE TABLE arr AS
  SELECT Dest AS code,
         count(*) FILTER (WHERE Cancelled = 0)         AS arrivals,
         avg(ArrDelayMinutes) FILTER (WHERE Cancelled = 0) AS avg_arr_delay_min,
         avg(TaxiIn) FILTER (WHERE Cancelled = 0)      AS avg_taxi_in_min
  FROM flights GROUP BY Dest
`);

/* -------------------------------------------- peak-hour movement intensity */
// Scheduled hour from CRSDepTime/CRSArrTime (hhmm as an integer).
// p95 of hourly movement counts across the year: the level the airport
// actually sustains at its busiest, not a one-off outlier hour.
await sql(`
  CREATE TABLE peak AS
  WITH mv AS (
    SELECT Origin AS code, FlightDate AS d, TRY_CAST(CRSDepTime AS INTEGER) // 100 AS hr
    FROM flights WHERE Cancelled = 0 AND TRY_CAST(CRSDepTime AS INTEGER) IS NOT NULL
    UNION ALL
    SELECT Dest AS code, FlightDate AS d, TRY_CAST(CRSArrTime AS INTEGER) // 100 AS hr
    FROM flights WHERE Cancelled = 0 AND TRY_CAST(CRSArrTime AS INTEGER) IS NOT NULL
  ),
  hourly AS (
    SELECT code, d, hr, count(*) AS movements FROM mv GROUP BY code, d, hr
  )
  SELECT code,
         quantile_cont(movements, 0.95) AS peak_hour_movements,
         max(movements)                 AS max_hour_movements,
         avg(movements)                 AS avg_hour_movements
  FROM hourly GROUP BY code
`);

/* ------------------------------------------------- carrier concentration */
await sql(`
  CREATE TABLE hhi AS
  WITH shares AS (
    SELECT Origin AS code, Reporting_Airline AS carrier,
           count(*)::DOUBLE / sum(count(*)) OVER (PARTITION BY Origin) AS s
    FROM flights WHERE Cancelled = 0 GROUP BY Origin, Reporting_Airline
  )
  SELECT code, sum(s * s) AS carrier_hhi, max(s) AS top_carrier_share,
         arg_max(carrier, s) AS top_carrier
  FROM shares GROUP BY code
`);

/* ---------------------------------------------------- physical plant */
await sql(`
  CREATE TABLE ap AS
  SELECT iata_code AS code, ident, local_code, name, municipality AS city,
         replace(iso_region, 'US-', '') AS state,
         latitude_deg AS lat, longitude_deg AS lon, type
  FROM read_csv('${RAW}/airports.csv', header = true, sample_size = -1)
  WHERE iso_country = 'US'
    AND iata_code IS NOT NULL AND length(iata_code) = 3
    AND type IN ('large_airport', 'medium_airport', 'small_airport')
`);

await sql(`
  CREATE TABLE rw AS
  SELECT a.code,
         count(*)                                   AS runways,
         count(*) FILTER (WHERE r.closed = 0)       AS runways_open,
         max(r.length_ft)                           AS longest_runway_ft,
         sum(r.length_ft * r.width_ft)              AS runway_area_sqft
  FROM read_csv('${RAW}/runways.csv', header = true, sample_size = -1) r
  JOIN ap a ON a.ident = r.airport_ident
  GROUP BY a.code
`);

/* -------------------------------------------------------- enplanements */
// FAA publishes each year's file with the prior year alongside, so two files
// give three calendar years of boardings plus the official hub class.
const enp2024 = path.join(RAW, "enplanements_2024.xlsx");
const enp2025 = path.join(RAW, "enplanements_2025.xlsx");
await sql(`
  CREATE TABLE enp AS
  WITH y24 AS (
    SELECT "Locid" AS code,
           -- FAA writes "None" for commercial-service airports below nonhub
           -- thresholds; fold everything that is not L/M/S into N.
           CASE WHEN "Hub" IN ('L', 'M', 'S') THEN "Hub" ELSE 'N' END AS hub,
           "ST" AS faa_state,
           "Airport Name" AS faa_name,
           TRY_CAST("CY 24 Enplanements" AS DOUBLE) AS enp_2024,
           TRY_CAST("CY 23 Enplanements" AS DOUBLE) AS enp_2023
    FROM read_xlsx('${enp2024}', all_varchar = true)
  ),
  y25 AS (
    SELECT "Locid" AS code,
           TRY_CAST("CY 25 Enplanements" AS DOUBLE) AS enp_2025
    FROM read_xlsx('${enp2025}', all_varchar = true)
  )
  SELECT y24.*, y25.enp_2025 FROM y24 LEFT JOIN y25 USING (code)
`);

// FAA keys its file on the FAA location identifier, which for a handful of
// airports differs from the IATA code (Mesa Gateway is AZA to travellers and
// IWA to the FAA). Match on either, preferring an exact IATA match.
await sql(`
  CREATE TABLE enp_j AS
  SELECT * EXCLUDE (rn) FROM (
    SELECT ap.code AS ap_code, e.* EXCLUDE (code),
           row_number() OVER (
             PARTITION BY ap.code ORDER BY CASE WHEN e.code = ap.code THEN 1 ELSE 2 END
           ) AS rn
    FROM ap
    JOIN enp e ON e.code = ap.code OR e.code = ap.local_code
  ) WHERE rn = 1
`);

/* ------------------------------------------------------------ catchment */
// Population within CATCHMENT_KM of the field, summed over county centroids.
await sql(`
  CREATE TABLE pop AS
  SELECT
    TRY_CAST(g.INTPTLAT AS DOUBLE) AS lat,
    TRY_CAST(g.INTPTLONG AS DOUBLE) AS lon,
    TRY_CAST(p.POPESTIMATE2024 AS DOUBLE) AS population
  FROM read_csv('${RAW}/county_centroids.txt', header = true, delim = '\t',
                sample_size = -1, ignore_errors = true) g
  JOIN read_csv('${RAW}/county_population.csv', header = true, sample_size = -1,
                ignore_errors = true) p
    ON lpad(TRY_CAST(p.STATE AS VARCHAR), 2, '0') || lpad(TRY_CAST(p.COUNTY AS VARCHAR), 3, '0')
       = lpad(TRY_CAST(g.GEOID AS VARCHAR), 5, '0')
  WHERE TRY_CAST(p.COUNTY AS INTEGER) <> 0
`);

await sql(`
  CREATE TABLE catchment AS
  SELECT a.code,
         sum(p.population) FILTER (
           WHERE 6371 * acos(least(1, greatest(-1,
             sin(radians(a.lat)) * sin(radians(p.lat)) +
             cos(radians(a.lat)) * cos(radians(p.lat)) * cos(radians(p.lon - a.lon))
           ))) <= ${CATCHMENT_KM}
         ) AS catchment_pop
  FROM ap a CROSS JOIN pop p
  GROUP BY a.code
`);

/* ------------------------------------------------------------- assemble */
// Flight metrics cover `months` of the year; enplanements are annual. Scale the
// counters to a full year before mixing the two, and say so in the metadata.
const ANNUALISE = 12 / months.length;

const out = await rows(`
  SELECT
    ap.code, ap.ident, ap.name, ap.city, ap.state, ap.lat, ap.lon, ap.type,
    enp.hub, enp.faa_name,
    enp.enp_2023, enp.enp_2024, enp.enp_2025,
    rw.runways_open AS runways, rw.longest_runway_ft,
    dep.sched_departures, dep.departures, arr.arrivals,
    dep.departures + coalesce(arr.arrivals, 0) AS movements,
    dep.departures * ${ANNUALISE} AS departures_annualised,
    (dep.departures + coalesce(arr.arrivals, 0)) * ${ANNUALISE} AS movements_annualised,
    dep.avg_dep_delay_min, dep.p80_dep_delay_min, dep.share_dep_delayed_15,
    arr.avg_arr_delay_min,
    dep.avg_taxi_out_min, dep.p80_taxi_out_min,
    dep.cancel_rate, dep.divert_rate,
    peak.peak_hour_movements, peak.max_hour_movements,
    hhi.carrier_hhi, hhi.top_carrier, hhi.top_carrier_share, dep.carriers,
    dep.share_short_haul, dep.share_medium_haul, dep.share_long_haul,
    dep.avg_stage_length_km, dep.max_stage_length_km,
    (dep.weather_delay_min + dep.nas_delay_min) / nullif(
      dep.weather_delay_min + dep.nas_delay_min + dep.carrier_delay_min +
      dep.late_aircraft_delay_min + dep.security_delay_min, 0)             AS weather_nas_delay_share,
    catchment.catchment_pop,
    enp.enp_2024 / nullif(dep.departures * ${ANNUALISE}, 0)                AS pax_per_departure,
    enp.enp_2024 / nullif(catchment.catchment_pop, 0)                      AS enp_per_capita,
    (dep.departures + coalesce(arr.arrivals, 0))::DOUBLE * ${ANNUALISE}
      / nullif(rw.runways_open * ${OPS_PER_RUNWAY}, 0)                     AS runway_utilisation,
    -- Screening floor: below this an airport is scored but kept out of the
    -- default ranking, because a handful of flights cannot support a thesis.
    -- Either real passenger volume, or real scheduled activity, qualifies.
    (coalesce(enp.enp_2024, 0) >= 100000
       OR coalesce(dep.departures, 0) * ${ANNUALISE} >= 5000)                AS screened,
    CASE WHEN enp.enp_2023 > 0 AND enp.enp_2025 > 0
         THEN pow(enp.enp_2025 / enp.enp_2023, 0.5) - 1 END                AS enp_cagr_2yr,
    CASE WHEN enp.enp_2024 > 0 AND enp.enp_2025 > 0
         THEN enp.enp_2025 / enp.enp_2024 - 1 END                          AS enp_growth_last_yr
  FROM ap
  LEFT JOIN dep       ON dep.code = ap.code
  LEFT JOIN arr       ON arr.code = ap.code
  LEFT JOIN peak      ON peak.code = ap.code
  LEFT JOIN hhi       ON hhi.code = ap.code
  LEFT JOIN rw        ON rw.code = ap.code
  LEFT JOIN enp_j AS enp ON enp.ap_code = ap.code
  LEFT JOIN catchment ON catchment.code = ap.code
  WHERE dep.departures IS NOT NULL OR enp.enp_2024 > 10000
  ORDER BY enp.enp_2024 DESC NULLS LAST
`);

const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const airports = out.map((r) => {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    o[k] =
      typeof v === "string" && /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(v) ? num(v) : v;
  }
  return o;
});

const meta = {
  generated_at: new Date().toISOString(),
  flight_window: { first_date, last_date, months: months.length },
  flight_rows: Number(n_flights),
  enplanement_years: [2023, 2024, 2025],
  annualisation_factor: ANNUALISE,
  constants: { OPS_PER_RUNWAY, CATCHMENT_KM, HAUL_MEDIUM_KM, HAUL_LONG_KM },
  caveats: [
    "BTS On-Time covers scheduled DOMESTIC service by reporting carriers only. International departures are absent, so haul-mix shares are domestic shares.",
    "Enplanements are FAA ACAIS; CY2025 is preliminary.",
    "Runway counts are OurAirports (community-maintained).",
    "Catchment is population within 100 km of the field, not a drive-time isochrone.",
    months.length < 12
      ? `Flight metrics cover ${months.length} of 12 months and are scaled to a full year; seasonal bias is not corrected.`
      : "Flight metrics cover a full calendar year.",
  ],
};

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ meta, airports }, null, 0));
const withFlights = airports.filter((a) => a.departures).length;
console.log(
  `wrote ${OUT}\n  airports: ${airports.length} (${withFlights} with flight data)\n  size: ${(
    JSON.stringify({ meta, airports }).length / 1e6
  ).toFixed(2)} MB`,
);
