/**
 * Deterministic place resolution.
 *
 * "New England", "the Bay Area", "LA" and "Santa Ana" are analyst shorthand,
 * not data. Resolving them in code — not in the model — is what makes the
 * answer to "which airports in New England" reproducible, and what lets the
 * agent tell the user exactly which airports it took the phrase to mean.
 */

export interface RegionDef {
  key: string;
  label: string;
  states: string[];
  aliases: string[];
}

/** Multi-state regions, defined by state list. */
export const REGIONS: RegionDef[] = [
  {
    key: "new_england",
    label: "New England",
    states: ["ME", "NH", "VT", "MA", "RI", "CT"],
    aliases: ["new england", "northeast corner", "n. england"],
  },
  {
    key: "mid_atlantic",
    label: "Mid-Atlantic",
    states: ["NY", "NJ", "PA", "DE", "MD", "DC", "VA"],
    aliases: ["mid atlantic", "mid-atlantic", "midatlantic"],
  },
  {
    key: "southeast",
    label: "Southeast",
    states: ["NC", "SC", "GA", "FL", "AL", "MS", "TN", "KY", "WV"],
    aliases: ["southeast", "south east", "the south"],
  },
  {
    key: "midwest",
    label: "Midwest",
    states: ["OH", "MI", "IN", "IL", "WI", "MN", "IA", "MO", "ND", "SD", "NE", "KS"],
    aliases: ["midwest", "mid west", "middle west"],
  },
  {
    key: "southwest",
    label: "Southwest",
    states: ["TX", "OK", "NM", "AZ"],
    aliases: ["southwest", "south west"],
  },
  {
    key: "mountain_west",
    label: "Mountain West",
    states: ["CO", "UT", "NV", "ID", "MT", "WY"],
    aliases: ["mountain west", "rockies", "rocky mountains", "intermountain"],
  },
  {
    key: "west_coast",
    label: "West Coast",
    states: ["CA", "OR", "WA"],
    aliases: ["west coast", "pacific coast", "pacific northwest and california"],
  },
  {
    key: "pacific_northwest",
    label: "Pacific Northwest",
    states: ["WA", "OR"],
    aliases: ["pacific northwest", "pnw"],
  },
  {
    key: "alaska",
    label: "Alaska",
    states: ["AK"],
    aliases: ["alaska"],
  },
  {
    key: "hawaii",
    label: "Hawaii",
    states: ["HI"],
    aliases: ["hawaii", "hawaiian islands"],
  },
];

/**
 * Metro areas, defined by airport code. A metro is deliberately a LIST:
 * "LA" is four commercial airports, and collapsing it to LAX silently
 * throws away the comparison the analyst probably wanted.
 */
export interface MetroDef {
  key: string;
  label: string;
  /** Primary field first; the rest are the alternates worth offering. */
  codes: string[];
  aliases: string[];
}

export const METROS: MetroDef[] = [
  {
    key: "la",
    label: "Los Angeles",
    codes: ["LAX", "BUR", "LGB", "ONT", "SNA"],
    aliases: ["la", "l.a.", "los angeles", "lax area", "greater los angeles"],
  },
  {
    key: "orange_county",
    label: "Santa Ana / Orange County",
    codes: ["SNA"],
    aliases: ["santa ana", "orange county", "john wayne", "sna"],
  },
  {
    key: "bay_area",
    label: "San Francisco Bay Area",
    codes: ["SFO", "OAK", "SJC"],
    aliases: ["bay area", "san francisco bay", "sf bay area"],
  },
  {
    key: "nyc",
    label: "New York City",
    codes: ["JFK", "LGA", "EWR"],
    aliases: ["nyc", "new york", "new york city", "the new york airports"],
  },
  {
    key: "chicago",
    label: "Chicago",
    codes: ["ORD", "MDW"],
    aliases: ["chicago", "chicagoland"],
  },
  {
    key: "dc",
    label: "Washington DC",
    codes: ["DCA", "IAD", "BWI"],
    aliases: ["washington dc", "dc", "washington", "the dc airports"],
  },
  {
    key: "houston",
    label: "Houston",
    codes: ["IAH", "HOU"],
    aliases: ["houston"],
  },
  {
    key: "dallas",
    label: "Dallas-Fort Worth",
    codes: ["DFW", "DAL"],
    aliases: ["dallas", "dfw metroplex", "dallas fort worth"],
  },
  {
    key: "miami",
    label: "South Florida",
    codes: ["MIA", "FLL", "PBI"],
    aliases: ["miami", "south florida", "the miami airports"],
  },
  {
    key: "anchorage",
    label: "Anchorage",
    codes: ["ANC"],
    aliases: ["anchorage"],
  },
];

export const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico",
  VI: "US Virgin Islands", GU: "Guam",
};

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z. ]/g, " ").replace(/\s+/g, " ").trim();

export function findRegion(text: string): RegionDef | null {
  const t = normalise(text);
  for (const r of REGIONS) {
    if (r.aliases.some((a) => t.includes(a))) return r;
  }
  return null;
}

/**
 * Every metro mentioned, with where it was mentioned. "LA and Santa Ana" is
 * two matches, and the positions let a caller keep the user's own ordering.
 */
export function findMetroMatches(text: string): { m: MetroDef; at: number }[] {
  // Longest alias first, so "los angeles" is not shadowed by "la".
  const candidates = METROS.flatMap((m) => m.aliases.map((a) => ({ m, a })))
    .sort((x, y) => y.a.length - x.a.length);

  const found: { m: MetroDef; at: number }[] = [];
  let remaining = ` ${normalise(text)} `;
  for (const { m, a } of candidates) {
    const at = remaining.indexOf(` ${a} `);
    if (at < 0 || found.some((f) => f.m.key === m.key)) continue;
    found.push({ m, at });
    // Blank the matched span so a shorter alias cannot re-match inside it.
    remaining =
      remaining.slice(0, at + 1) + " ".repeat(a.length) + remaining.slice(at + 1 + a.length);
  }
  return found.sort((x, y) => x.at - y.at);
}

/** Metros only, in the order they appear in the text. */
export function findMetros(text: string): MetroDef[] {
  return findMetroMatches(text).map((f) => f.m);
}

export function findMetro(text: string): MetroDef | null {
  return findMetros(text)[0] ?? null;
}

export function findStates(text: string): string[] {
  const t = normalise(text);
  const hits = new Set<string>();
  for (const [abbr, name] of Object.entries(STATE_NAMES)) {
    if (t.includes(name.toLowerCase())) hits.add(abbr);
  }
  // Bare two-letter codes only count when clearly a state token.
  for (const token of text.split(/[^A-Z]/)) {
    if (token.length === 2 && STATE_NAMES[token]) hits.add(token);
  }
  return [...hits];
}
