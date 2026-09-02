/**
 * Renovation Upside Score (RUS) — the deterministic core.
 *
 * Nothing in this file calls a model. Given the same dataset and the same
 * weights it returns the same numbers, and every number it returns traces back
 * to a measured input and a peer-group comparison.
 *
 * Method, in order:
 *   1. Group airports by FAA hub class, so a nonhub is ranked against nonhubs.
 *   2. Winsorise each input at the 5th/95th percentile of its peer group, so
 *      one outlier airport cannot flatten the scale for everyone else.
 *   3. Min-max scale the winsorised value to 0-1 inside the peer group.
 *   4. Combine inputs into five components, then components into one score.
 *   5. Refuse to score an airport that is missing too much. No guessing.
 */
import type {
  AirportRecord,
  ComponentKey,
  ComponentScore,
  InputContribution,
  ScoredAirport,
  Weights,
} from "./types";

export const DEFAULT_WEIGHTS: Weights = {
  congestion: 0.3,
  headroom: 0.25,
  momentum: 0.2,
  unmet: 0.15,
  risk: 0.1,
};

export const COMPONENT_LABELS: Record<ComponentKey, string> = {
  congestion: "Congestion pressure",
  headroom: "Headroom deficit",
  momentum: "Demand momentum",
  unmet: "Unmet demand",
  risk: "Risk penalty",
};

export const HUB_LABELS: Record<string, string> = {
  L: "Large hub",
  M: "Medium hub",
  S: "Small hub",
  N: "Nonhub / other",
};

/** Minimum peers before a peer group is trustworthy; below this we pool. */
const MIN_PEERS = 8;
/** An airport needs this many of its five components before it is scored. */
const MIN_COMPONENTS = 4;
/** Departures below this make delay statistics too noisy to trust. */
const MIN_DEPARTURES_FOR_DELAY = 500;

interface InputSpec {
  key: string;
  label: string;
  unit: string;
  weight: number;
  get: (a: AirportRecord) => number | null;
  /** true when a LOWER raw value means MORE of the component. */
  invert?: boolean;
}

const finite = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : v;

/** Delay statistics are only meaningful with enough flights behind them. */
const ifEnoughFlights = (a: AirportRecord, v: number | null) =>
  (a.departures ?? 0) >= MIN_DEPARTURES_FOR_DELAY ? finite(v) : null;

const COMPONENTS: Record<ComponentKey, InputSpec[]> = {
  congestion: [
    {
      key: "avg_dep_delay_min",
      label: "Average departure delay",
      unit: "min",
      weight: 0.35,
      get: (a) => ifEnoughFlights(a, a.avg_dep_delay_min),
    },
    {
      key: "p80_taxi_out_min",
      label: "Taxi-out time, 80th percentile",
      unit: "min",
      weight: 0.3,
      get: (a) => ifEnoughFlights(a, a.p80_taxi_out_min),
    },
    {
      key: "peak_movements_per_runway",
      label: "Peak-hour movements per runway",
      unit: "mv/hr/rwy",
      weight: 0.35,
      get: (a) =>
        a.peak_hour_movements && a.runways
          ? finite(a.peak_hour_movements / a.runways)
          : null,
    },
  ],
  headroom: [
    {
      key: "runway_utilisation",
      label: "Annual movements vs runway capacity",
      unit: "x capacity",
      weight: 0.5,
      get: (a) => finite(a.runway_utilisation),
    },
    {
      key: "enp_per_runway",
      label: "Enplanements per open runway",
      unit: "pax/rwy",
      weight: 0.5,
      get: (a) => (a.enp_2024 && a.runways ? finite(a.enp_2024 / a.runways) : null),
    },
  ],
  momentum: [
    {
      key: "enp_cagr_2yr",
      label: "Enplanement CAGR, 2023 to 2025",
      unit: "%/yr",
      weight: 0.6,
      get: (a) => finite(a.enp_cagr_2yr),
    },
    {
      key: "enp_growth_last_yr",
      label: "Enplanement growth, 2024 to 2025",
      unit: "%",
      weight: 0.4,
      get: (a) => finite(a.enp_growth_last_yr),
    },
  ],
  unmet: [
    {
      key: "pax_per_departure",
      label: "Passengers per departure",
      unit: "pax",
      weight: 0.4,
      get: (a) => finite(a.pax_per_departure),
    },
    {
      key: "disruption_rate",
      label: "Cancelled + diverted share",
      unit: "share",
      weight: 0.3,
      get: (a) => ifEnoughFlights(a, (a.cancel_rate ?? 0) + (a.divert_rate ?? 0)),
    },
    {
      key: "pop_per_enplanement",
      label: "Catchment population per enplanement",
      unit: "people/pax",
      weight: 0.3,
      get: (a) =>
        a.catchment_pop && a.enp_2024 ? finite(a.catchment_pop / a.enp_2024) : null,
    },
  ],
  risk: [
    {
      key: "carrier_hhi",
      label: "Carrier concentration (HHI)",
      unit: "index",
      weight: 0.5,
      get: (a) => finite(a.carrier_hhi),
    },
    {
      key: "weather_nas_delay_share",
      label: "Delay minutes from weather / airspace",
      unit: "share",
      weight: 0.5,
      get: (a) => ifEnoughFlights(a, a.weather_nas_delay_share),
    },
  ],
};

/* ------------------------------------------------------------- statistics */

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values: number[]): number | null {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? quantile(s, 0.5) : null;
}

/**
 * Nearest-rank quantile: picks an observed value rather than interpolating
 * toward the next one. Interpolation would drag the 95th percentile of a small
 * peer group most of the way to its largest member, which is exactly the
 * outlier the winsorising is meant to fence off.
 */
function rankQuantile(sorted: number[], q: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx];
}

/** Winsorised min-max scale, built once per peer group so all members share it. */
function scaler(values: number[], invert = false) {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length === 0) return () => null;
  const lo = rankQuantile(s, 0.05);
  const hi = rankQuantile(s, 0.95);
  const span = hi - lo;
  return (v: number | null): number | null => {
    if (v === null || !Number.isFinite(v)) return null;
    // A flat distribution carries no ranking information; everyone sits mid.
    if (span <= 0) return 0.5;
    const clamped = Math.min(hi, Math.max(lo, v));
    const scaled = (clamped - lo) / span;
    return invert ? 1 - scaled : scaled;
  };
}

/* ---------------------------------------------------------------- scoring */

export interface ScoreOptions {
  weights?: Partial<Weights>;
  /** Pool every airport into one peer group instead of splitting by hub class. */
  crossClass?: boolean;
}

export function scoreAirports(
  airports: AirportRecord[],
  options: ScoreOptions = {},
): ScoredAirport[] {
  const weights: Weights = { ...DEFAULT_WEIGHTS, ...options.weights };

  const groups = new Map<string, AirportRecord[]>();
  for (const a of airports) {
    const k = options.crossClass ? "ALL" : a.hub ?? "N";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(a);
  }
  // A peer group too small to define a scale gets pooled with everyone else.
  for (const [k, members] of [...groups]) {
    if (k !== "ALL" && members.length < MIN_PEERS) {
      groups.delete(k);
      groups.set("ALL", [...(groups.get("ALL") ?? []), ...members]);
    }
  }

  const scales = new Map<string, (v: number | null) => number | null>();
  const medians = new Map<string, number | null>();
  for (const [g, members] of groups) {
    for (const [ck, specs] of Object.entries(COMPONENTS)) {
      for (const spec of specs) {
        const vals = members.map(spec.get).filter((v): v is number => v !== null);
        const id = `${g}|${ck}|${spec.key}`;
        scales.set(id, scaler(vals, spec.invert));
        medians.set(id, median(vals));
      }
    }
  }

  const memberOf = new Map<string, string>();
  for (const [g, members] of groups) for (const m of members) memberOf.set(m.code, g);

  return airports.map((a) => {
    const g = memberOf.get(a.code) ?? "ALL";
    const peerCount = groups.get(g)?.length ?? 0;
    const components: ComponentScore[] = [];

    for (const ck of Object.keys(COMPONENTS) as ComponentKey[]) {
      const inputs: InputContribution[] = COMPONENTS[ck].map((spec) => {
        const id = `${g}|${ck}|${spec.key}`;
        const raw = spec.get(a);
        return {
          key: spec.key,
          label: spec.label,
          raw,
          normalized: scales.get(id)?.(raw) ?? null,
          weight: spec.weight,
          unit: spec.unit,
          peerMedian: medians.get(id) ?? null,
        };
      });

      // Re-weight across the inputs actually present, so a missing input
      // dilutes confidence rather than silently scoring as zero.
      const present = inputs.filter((i) => i.normalized !== null);
      const wsum = present.reduce((s, i) => s + i.weight, 0);
      const value =
        present.length === 0 || wsum === 0
          ? null
          : present.reduce((s, i) => s + i.normalized! * i.weight, 0) / wsum;

      components.push({
        key: ck,
        label: COMPONENT_LABELS[ck],
        value,
        weight: weights[ck],
        points: value === null ? 0 : (ck === "risk" ? -1 : 1) * value * weights[ck] * 100,
        inputs,
        coverage: present.length / inputs.length,
      });
    }

    const scored = components.filter((c) => c.value !== null);
    let rus: number | null = null;
    let excludedReason: string | null = null;

    if (scored.length < MIN_COMPONENTS) {
      const missing = components.filter((c) => c.value === null).map((c) => c.label);
      excludedReason = `insufficient data - ${missing.join(", ")} could not be measured`;
    } else {
      rus = Math.max(0, Math.min(100, scored.reduce((s, c) => s + c.points, 0)));
    }

    // Confidence: share of inputs measurable, discounted when the flight
    // sample behind the delay statistics is thin.
    const allInputs = components.flatMap((c) => c.inputs);
    const inputCoverage =
      allInputs.filter((i) => i.normalized !== null).length / allInputs.length;
    const sampleFactor = Math.min(1, (a.departures ?? 0) / 5000);
    // Capped below 1: complete inputs still leave model risk, and a stated
    // band of exactly zero would overclaim.
    const confidence = Math.min(0.95, Math.max(0.05, 0.7 * inputCoverage + 0.3 * sampleFactor));

    const positives = scored.filter((c) => c.key !== "risk");
    const driver =
      positives.length === 0
        ? null
        : positives.reduce((best, c) => (c.points > best.points ? c : best)).key;

    return {
      airport: a,
      rus: rus === null ? null : Math.round(rus * 10) / 10,
      band: Math.round((1 - confidence) * 18 * 10) / 10,
      confidence: Math.round(confidence * 100) / 100,
      peerGroup: g === "ALL" ? "All airports" : HUB_LABELS[g] ?? g,
      peerCount,
      components,
      excludedReason,
      driver,
    };
  });
}

export { COMPONENTS };
export * from "./types";
