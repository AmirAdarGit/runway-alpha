/**
 * The tool layer: the only path to a number.
 *
 * Each function is pure over (dataset, arguments) and returns values plus the
 * provenance needed to defend them. The chat agent may only report figures that
 * appear in one of these payloads; the API routes expose the same functions
 * directly so any answer can be checked without a model in the loop.
 */
import { loadDataset, provenanceLine } from "./data";
import { findMetro, findRegion, METROS, REGIONS, STATE_NAMES } from "./regions";
import { COMPONENT_LABELS, DEFAULT_WEIGHTS, scoreAirports } from "./scoring";
import type {
  AirportRecord,
  ComponentKey,
  ScoredAirport,
  Weights,
} from "./scoring/types";

/* --------------------------------------------------------------- helpers */

export interface RankFilters {
  /** Named region, e.g. "new_england". Resolved to states. */
  region?: string;
  /** Two-letter state codes. */
  states?: string[];
  /** Named metro, e.g. "la". Resolved to airport codes. */
  metro?: string;
  /** FAA hub classes to keep. */
  hubClasses?: ("L" | "M" | "S" | "N")[];
  /** Explicit airport codes; when set, other place filters are ignored. */
  codes?: string[];
  minEnplanements?: number;
  /** Include airports below the screening floor (default false). */
  includeSmall?: boolean;
}

export interface ToolContext {
  weights?: Partial<Weights>;
  crossClass?: boolean;
}

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? null : Math.round(v * 1000) / 10;
const round = (v: number | null | undefined, dp = 1) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? null
    : Math.round(v * 10 ** dp) / 10 ** dp;

/**
 * Resolve place words to a concrete airport set, and report how it was done —
 * the agent is required to show this so the user can challenge the reading.
 */
export function resolveScope(filters: RankFilters) {
  const notes: string[] = [];
  let states: string[] | null = null;
  let codes: string[] | null = null;
  let label = "all US airports with scheduled service";

  if (filters.codes?.length) {
    codes = filters.codes.map((c) => c.toUpperCase());
    label = codes.join(", ");
  } else if (filters.metro) {
    const m =
      METROS.find((x) => x.key === filters.metro) ?? findMetro(filters.metro);
    if (m) {
      codes = m.codes;
      label = m.label;
      notes.push(`"${filters.metro}" read as ${m.label}: ${m.codes.join(", ")}.`);
    } else notes.push(`Metro "${filters.metro}" not recognised; ignored.`);
  } else if (filters.region) {
    const r =
      REGIONS.find((x) => x.key === filters.region) ?? findRegion(filters.region);
    if (r) {
      states = r.states;
      label = r.label;
      notes.push(`"${r.label}" read as ${r.states.join(", ")}.`);
    } else notes.push(`Region "${filters.region}" not recognised; ignored.`);
  } else if (filters.states?.length) {
    states = filters.states.map((s) => s.toUpperCase());
    label = states.map((s) => STATE_NAMES[s] ?? s).join(", ");
  }

  return { states, codes, label, notes };
}

function selectAirports(all: AirportRecord[], filters: RankFilters) {
  const scope = resolveScope(filters);
  let rows = all;

  if (scope.codes) {
    rows = rows.filter((a) => scope.codes!.includes(a.code));
  } else {
    if (scope.states) rows = rows.filter((a) => a.state && scope.states!.includes(a.state));
    if (filters.hubClasses?.length)
      rows = rows.filter((a) => filters.hubClasses!.includes((a.hub ?? "N") as never));
    if (!filters.includeSmall) rows = rows.filter((a) => a.screened !== false);
    if (filters.minEnplanements)
      rows = rows.filter((a) => (a.enp_2024 ?? 0) >= filters.minEnplanements!);
  }
  return { rows, scope };
}

/** Compact view of a scored airport, safe to hand to a model. */
function summarise(s: ScoredAirport) {
  const a = s.airport;
  return {
    code: a.code,
    name: a.name,
    city: a.city,
    state: a.state,
    hubClass: a.hub,
    rus: s.rus,
    band: s.band,
    confidence: s.confidence,
    peerGroup: s.peerGroup,
    peerCount: s.peerCount,
    driver: s.driver ? COMPONENT_LABELS[s.driver] : null,
    components: Object.fromEntries(
      s.components.map((c) => [c.key, { value: round(c.value, 3), points: round(c.points) }]),
    ) as Record<ComponentKey, { value: number | null; points: number | null }>,
    enplanements2024: a.enp_2024,
    excludedReason: s.excludedReason,
  };
}

/** Comparison against the peer median, without silly "below by 0%" phrasing. */
function describeVsMedian(raw: number | null, peerMedian: number | null): string {
  if (raw === null || peerMedian === null || peerMedian === 0) return "not measurable";
  const deltaPct = (raw / peerMedian - 1) * 100;
  if (Math.abs(deltaPct) < 1) return "at the peer median";
  return `${deltaPct > 0 ? "above" : "below"} peer median by ${round(Math.abs(deltaPct))}%`;
}

/* ------------------------------------------------------------------ tools */

/**
 * Rank airports by Renovation Upside Score inside a scope.
 * Scoring always runs over the FULL dataset so peer groups stay intact;
 * the filter is applied to the results, not to the normalisation.
 */
export function rankAirports(
  filters: RankFilters = {},
  ctx: ToolContext = {},
  limit = 10,
) {
  const ds = loadDataset();
  const scored = scoreAirports(ds.airports, {
    weights: ctx.weights,
    crossClass: ctx.crossClass,
  });
  const { rows, scope } = selectAirports(ds.airports, filters);
  const keep = new Set(rows.map((r) => r.code));

  const inScope = scored.filter((s) => keep.has(s.airport.code));
  const ranked = inScope
    .filter((s) => s.rus !== null)
    .sort((a, b) => b.rus! - a.rus!);
  const unscored = inScope.filter((s) => s.rus === null);

  return {
    tool: "rankAirports",
    scope: scope.label,
    scopeNotes: scope.notes,
    weights: { ...DEFAULT_WEIGHTS, ...ctx.weights },
    peerNormalisation: ctx.crossClass
      ? "all airports pooled into one peer group"
      : "within FAA hub class",
    counted: inScope.length,
    results: ranked.slice(0, limit).map((s, i) => ({ rank: i + 1, ...summarise(s) })),
    unscored: unscored.map((s) => ({
      code: s.airport.code,
      name: s.airport.name,
      reason: s.excludedReason,
    })),
    provenance: provenanceLine(ds),
    caveats: ds.meta.caveats,
  };
}

/** Full component detail for one airport, including every raw input. */
export function airportProfile(code: string, ctx: ToolContext = {}) {
  const ds = loadDataset();
  const scored = scoreAirports(ds.airports, ctx);
  const s = scored.find((x) => x.airport.code === code.toUpperCase());
  if (!s) {
    return {
      tool: "airportProfile",
      error: `No airport with code ${code.toUpperCase()} in the dataset.`,
      hint: "Codes are IATA three-letter codes for US airports with scheduled service.",
    };
  }
  const a = s.airport;
  const rankAll = scored
    .filter((x) => x.rus !== null && x.airport.hub === a.hub)
    .sort((x, y) => y.rus! - x.rus!);
  const positionInClass = rankAll.findIndex((x) => x.airport.code === a.code) + 1;

  return {
    tool: "airportProfile",
    ...summarise(s),
    positionInHubClass: positionInClass || null,
    hubClassSize: rankAll.length,
    physical: {
      runways: a.runways,
      longestRunwayFt: a.longest_runway_ft,
      lat: a.lat,
      lon: a.lon,
    },
    traffic: {
      departuresInWindow: a.departures,
      departuresAnnualised: round(a.departures_annualised, 0),
      movementsAnnualised: round(a.movements_annualised, 0),
      peakHourMovements: round(a.peak_hour_movements),
      runwayUtilisation: round(a.runway_utilisation, 3),
      enplanements: { 2023: a.enp_2023, 2024: a.enp_2024, 2025: a.enp_2025 },
      enplanementCagr2yrPct: pct(a.enp_cagr_2yr),
      paxPerDeparture: round(a.pax_per_departure),
    },
    performance: {
      avgDepartureDelayMin: round(a.avg_dep_delay_min),
      p80DepartureDelayMin: round(a.p80_dep_delay_min),
      shareDelayedOver15Pct: pct(a.share_dep_delayed_15),
      avgTaxiOutMin: round(a.avg_taxi_out_min),
      p80TaxiOutMin: round(a.p80_taxi_out_min),
      cancelRatePct: pct(a.cancel_rate),
      divertRatePct: pct(a.divert_rate),
      weatherAndAirspaceShareOfDelayPct: pct(a.weather_nas_delay_share),
    },
    market: {
      topCarrier: a.top_carrier,
      topCarrierSharePct: pct(a.top_carrier_share),
      carriers: a.carriers,
      carrierHhi: round(a.carrier_hhi, 3),
      catchmentPopulation: a.catchment_pop,
    },
    componentDetail: s.components.map((c) => ({
      key: c.key,
      label: c.label,
      value: round(c.value, 3),
      weight: c.weight,
      points: round(c.points),
      coverage: round(c.coverage, 2),
      inputs: c.inputs.map((i) => ({
        label: i.label,
        raw: round(i.raw, 3),
        unit: i.unit,
        normalized: round(i.normalized, 3),
        peerMedian: round(i.peerMedian, 3),
        weightWithinComponent: i.weight,
      })),
    })),
    provenance: provenanceLine(ds),
  };
}

export type CompareFocus = "overall" | "congestion" | "capacity" | "growth" | "demand";

/** Head-to-head comparison across a chosen lens. */
export function compareAirports(
  codes: string[],
  focus: CompareFocus = "overall",
  ctx: ToolContext = {},
) {
  const ds = loadDataset();
  const scored = scoreAirports(ds.airports, ctx);
  const wanted = codes.map((c) => c.toUpperCase());
  const found = wanted
    .map((c) => scored.find((s) => s.airport.code === c))
    .filter((s): s is ScoredAirport => Boolean(s));
  const missing = wanted.filter((c) => !found.some((s) => s.airport.code === c));

  const metricsFor = (s: ScoredAirport) => {
    const a = s.airport;
    const common = { code: a.code, name: a.name, hubClass: a.hub, rus: s.rus, band: s.band };
    switch (focus) {
      case "congestion":
        return {
          ...common,
          avgDepartureDelayMin: round(a.avg_dep_delay_min),
          p80DepartureDelayMin: round(a.p80_dep_delay_min),
          shareDelayedOver15Pct: pct(a.share_dep_delayed_15),
          p80TaxiOutMin: round(a.p80_taxi_out_min),
          peakHourMovements: round(a.peak_hour_movements),
          peakMovementsPerRunway:
            a.peak_hour_movements && a.runways
              ? round(a.peak_hour_movements / a.runways)
              : null,
          runways: a.runways,
          cancelRatePct: pct(a.cancel_rate),
          congestionComponent: round(
            s.components.find((c) => c.key === "congestion")?.value ?? null,
            3,
          ),
        };
      case "capacity":
        return {
          ...common,
          runways: a.runways,
          longestRunwayFt: a.longest_runway_ft,
          movementsAnnualised: round(a.movements_annualised, 0),
          runwayUtilisation: round(a.runway_utilisation, 3),
          enplanements2024: a.enp_2024,
          enplanementsPerRunway:
            a.enp_2024 && a.runways ? round(a.enp_2024 / a.runways, 0) : null,
          headroomComponent: round(
            s.components.find((c) => c.key === "headroom")?.value ?? null,
            3,
          ),
        };
      case "growth":
        return {
          ...common,
          enplanements: { 2023: a.enp_2023, 2024: a.enp_2024, 2025: a.enp_2025 },
          cagr2yrPct: pct(a.enp_cagr_2yr),
          growthLastYearPct: pct(a.enp_growth_last_yr),
          momentumComponent: round(
            s.components.find((c) => c.key === "momentum")?.value ?? null,
            3,
          ),
        };
      case "demand":
        return {
          ...common,
          paxPerDeparture: round(a.pax_per_departure),
          cancelRatePct: pct(a.cancel_rate),
          divertRatePct: pct(a.divert_rate),
          catchmentPopulation: a.catchment_pop,
          populationPerEnplanement:
            a.catchment_pop && a.enp_2024 ? round(a.catchment_pop / a.enp_2024, 2) : null,
          unmetComponent: round(s.components.find((c) => c.key === "unmet")?.value ?? null, 3),
        };
      default:
        return { ...common, ...summarise(s).components };
    }
  };

  return {
    tool: "compareAirports",
    focus,
    airports: found.map(metricsFor),
    missing,
    // Comparing across hub classes mixes two different normalisation scales.
    comparabilityNote:
      new Set(found.map((s) => s.airport.hub)).size > 1
        ? "These airports sit in different FAA hub classes, so their RUS values were normalised against different peer groups. The raw metrics below are directly comparable; the scores are not."
        : "All airports here share one hub class, so scores and raw metrics are both directly comparable.",
    provenance: provenanceLine(ds),
  };
}

/** Distance mix of departures, with the thresholds restated every time. */
export function haulMix(code: string) {
  const ds = loadDataset();
  const a = ds.airports.find((x) => x.code === code.toUpperCase());
  if (!a) return { tool: "haulMix", error: `No airport with code ${code.toUpperCase()}.` };

  const { HAUL_MEDIUM_KM, HAUL_LONG_KM } = ds.meta.constants;
  // Departure-weighted, so the national figure is a share of flights and not
  // an average across airports of wildly different size.
  const nationalDeps = ds.airports.reduce((s, x) => s + (x.departures ?? 0), 0);
  const nationalLong = ds.airports.reduce(
    (s, x) => s + (x.departures ?? 0) * (x.share_long_haul ?? 0),
    0,
  );

  return {
    tool: "haulMix",
    code: a.code,
    name: a.name,
    definition: {
      shortHaul: `under ${HAUL_MEDIUM_KM} km`,
      mediumHaul: `${HAUL_MEDIUM_KM} to ${HAUL_LONG_KM} km`,
      longHaul: `over ${HAUL_LONG_KM} km`,
      basis: "performed departures, great-circle distance from BTS",
    },
    shortHaulPct: pct(a.share_short_haul),
    mediumHaulPct: pct(a.share_medium_haul),
    longHaulPct: pct(a.share_long_haul),
    avgStageLengthKm: round(a.avg_stage_length_km, 0),
    longestDomesticStageKm: round(a.max_stage_length_km, 0),
    departuresInWindow: a.departures,
    nationalLongHaulPct: round((nationalLong / nationalDeps) * 100, 1),
    nationalLongHaulBasis: "share of all departures in the dataset, departure-weighted",
    // The single most important caveat on this particular question.
    scopeWarning:
      "BTS On-Time covers scheduled DOMESTIC passenger service by reporting carriers. " +
      "International passenger flights and all-cargo operations are NOT included, so these " +
      "shares describe the domestic passenger network only. For Anchorage in particular, " +
      "excluded cargo and transpacific traffic would change the picture substantially.",
    provenance: provenanceLine(ds),
  };
}

/** Why a component scores the way it does, input by input. */
export function explainScore(
  code: string,
  component?: ComponentKey,
  ctx: ToolContext = {},
) {
  const ds = loadDataset();
  const scored = scoreAirports(ds.airports, ctx);
  const s = scored.find((x) => x.airport.code === code.toUpperCase());
  if (!s) return { tool: "explainScore", error: `No airport with code ${code.toUpperCase()}.` };

  const parts = component ? s.components.filter((c) => c.key === component) : s.components;

  return {
    tool: "explainScore",
    code: s.airport.code,
    name: s.airport.name,
    rus: s.rus,
    band: s.band,
    confidence: s.confidence,
    peerGroup: s.peerGroup,
    peerCount: s.peerCount,
    excludedReason: s.excludedReason,
    explanation: parts.map((c) => ({
      component: c.label,
      key: c.key,
      value: round(c.value, 3),
      weight: c.weight,
      pointsContributed: round(c.points),
      direction: c.key === "risk" ? "subtracted from the score" : "added to the score",
      coverage: round(c.coverage, 2),
      inputs: c.inputs.map((i) => ({
        label: i.label,
        raw: round(i.raw, 3),
        unit: i.unit,
        peerMedian: round(i.peerMedian, 3),
        vsPeerMedian: describeVsMedian(i.raw, i.peerMedian),
        normalized: round(i.normalized, 3),
        weightWithinComponent: i.weight,
      })),
    })),
    method:
      "Each input is winsorised at the 5th/95th percentile of the peer group, min-max scaled to 0-1, " +
      "then weighted within its component. Components are weighted into the score; the risk component " +
      "is subtracted. Missing inputs are dropped and the remainder re-weighted, which lowers confidence.",
    limits: [
      "This measures REVEALED pressure in historical operations, not modelled demand.",
      "There is no free national dataset for terminal or gate square footage, so terminal-side capacity is inferred from movement and passenger throughput, never measured.",
      "No construction cost, land availability, or political feasibility is considered.",
    ],
    provenance: provenanceLine(ds),
  };
}

/** Live FAA delay programmes. The only request-time network call. */
export async function liveStatus(codes: string[]) {
  const wanted = codes.map((c) => c.toUpperCase());
  try {
    const res = await fetch("https://nasstatus.faa.gov/api/airport-status-information", {
      signal: AbortSignal.timeout(6000),
      headers: { accept: "application/xml" },
    });
    if (!res.ok) throw new Error(`FAA NAS Status returned HTTP ${res.status}`);
    const xml = await res.text();

    // The feed is a small XML document; a targeted scan beats a parser here.
    const found = wanted.map((code) => {
      const re = new RegExp(`<ARPT>${code}</ARPT>([\\s\\S]{0,400})`, "g");
      const hits = [...xml.matchAll(re)].map((m) =>
        m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200),
      );
      return { code, active: hits.length > 0, detail: hits };
    });

    return {
      tool: "liveStatus",
      checkedAt: new Date().toISOString(),
      source: "FAA NAS Status (nasstatus.faa.gov), live",
      airports: found,
      note: "Absence of an entry means no ground stop or ground delay programme is active right now. This is a snapshot, not a history.",
    };
  } catch (e) {
    return {
      tool: "liveStatus",
      error: `Live FAA status unavailable: ${e instanceof Error ? e.message : String(e)}`,
      note: "Historical figures in this answer are unaffected; only the live line is missing.",
    };
  }
}

/** Dataset-level facts, so the agent can answer "what data do you have". */
export function datasetInfo() {
  const ds = loadDataset();
  const scored = scoreAirports(ds.airports);
  const byHub = new Map<string, number>();
  for (const a of ds.airports) byHub.set(a.hub ?? "N", (byHub.get(a.hub ?? "N") ?? 0) + 1);
  return {
    tool: "datasetInfo",
    airports: ds.airports.length,
    scored: scored.filter((s) => s.rus !== null).length,
    screened: ds.airports.filter((a) => a.screened).length,
    byHubClass: Object.fromEntries(byHub),
    window: ds.meta.flight_window,
    flightRows: ds.meta.flight_rows,
    constants: ds.meta.constants,
    defaultWeights: DEFAULT_WEIGHTS,
    caveats: ds.meta.caveats,
    provenance: provenanceLine(ds),
  };
}
