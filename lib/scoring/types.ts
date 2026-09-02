/** One airport as measured — raw values only, straight from data/airports.json. */
export interface AirportRecord {
  code: string;
  ident: string;
  name: string;
  city: string | null;
  state: string | null;
  lat: number | null;
  lon: number | null;
  type: string;
  /** FAA hub class: L large, M medium, S small, N nonhub. */
  hub: "L" | "M" | "S" | "N" | null;
  faa_name: string | null;

  enp_2023: number | null;
  enp_2024: number | null;
  enp_2025: number | null;

  runways: number | null;
  longest_runway_ft: number | null;

  sched_departures: number | null;
  departures: number | null;
  arrivals: number | null;
  movements: number | null;
  /** Window counts scaled to a full year, for mixing with annual enplanements. */
  departures_annualised: number | null;
  movements_annualised: number | null;
  /** False when the airport is too small to carry a default ranking. */
  screened: boolean | null;

  avg_dep_delay_min: number | null;
  p80_dep_delay_min: number | null;
  share_dep_delayed_15: number | null;
  avg_arr_delay_min: number | null;
  avg_taxi_out_min: number | null;
  p80_taxi_out_min: number | null;

  cancel_rate: number | null;
  divert_rate: number | null;

  peak_hour_movements: number | null;
  max_hour_movements: number | null;

  carrier_hhi: number | null;
  top_carrier: string | null;
  top_carrier_share: number | null;
  carriers: number | null;

  share_short_haul: number | null;
  share_medium_haul: number | null;
  share_long_haul: number | null;
  avg_stage_length_km: number | null;
  max_stage_length_km: number | null;

  weather_nas_delay_share: number | null;
  catchment_pop: number | null;
  pax_per_departure: number | null;
  enp_per_capita: number | null;
  runway_utilisation: number | null;
  enp_cagr_2yr: number | null;
  enp_growth_last_yr: number | null;
}

export interface Dataset {
  meta: {
    generated_at: string;
    flight_window: { first_date: string; last_date: string; months: number };
    flight_rows: number;
    enplanement_years: number[];
    annualisation_factor: number;
    constants: Record<string, number>;
    caveats: string[];
  };
  airports: AirportRecord[];
}

export type ComponentKey = "congestion" | "headroom" | "momentum" | "unmet" | "risk";

export interface Weights {
  congestion: number;
  headroom: number;
  momentum: number;
  unmet: number;
  /** Applied as a penalty — subtracted from the weighted sum. */
  risk: number;
}

/** One measured quantity feeding a component. */
export interface InputContribution {
  key: string;
  label: string;
  /** As measured, in the unit named by `unit`. */
  raw: number | null;
  /** 0–1 after winsorising and min–max scaling inside the peer group. */
  normalized: number | null;
  /** Share of its parent component. */
  weight: number;
  unit: string;
  /** Peer-group median of `raw`, for context in explanations. */
  peerMedian: number | null;
}

export interface ComponentScore {
  key: ComponentKey;
  label: string;
  /** 0–1, or null when too many inputs are missing. */
  value: number | null;
  weight: number;
  /** Signed contribution to the final 0–100 score. */
  points: number;
  inputs: InputContribution[];
  /** Fraction of this component's inputs that were measurable. */
  coverage: number;
}

export interface ScoredAirport {
  airport: AirportRecord;
  /** Renovation Upside Score, 0–100, or null when coverage is insufficient. */
  rus: number | null;
  /** ± band on the 0–100 scale, from input coverage and sample size. */
  band: number;
  confidence: number;
  /** Peer group the normalisation ran inside. */
  peerGroup: string;
  peerCount: number;
  components: ComponentScore[];
  /** Set when rus is null — why it could not be scored. */
  excludedReason: string | null;
  /** The single component contributing the most points. */
  driver: ComponentKey | null;
}
