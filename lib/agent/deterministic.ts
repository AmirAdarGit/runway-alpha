/**
 * The no-model answerer.
 *
 * It reads the question with rules, calls the same tools the LLM agent calls,
 * and writes the answer from a template. It is deliberately less fluent and
 * exactly as accurate: every figure still comes from the tool payload.
 *
 * Two reasons it exists. It is the demo's safety net when there is no API key
 * or no network. And it is the control case: if the LLM's answer disagrees with
 * this one, the LLM is wrong.
 */
import { loadDataset } from "../data";
import { findMetro, findMetroMatches, findMetros, findRegion, findStates, REGIONS } from "../regions";
import {
  airportProfile,
  compareAirports,
  datasetInfo,
  explainScore,
  haulMix,
  rankAirports,
  type CompareFocus,
} from "../tools";
import type { ComponentKey } from "../scoring/types";

export interface DeterministicAnswer {
  text: string;
  /** Tool payloads behind the answer, for the evidence panel. */
  toolCalls: { tool: string; args: Record<string, unknown>; result: unknown }[];
}

const fmt = (v: number | null | undefined, dp = 1, suffix = "") =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "n/a"
    : `${Number(v).toFixed(dp)}${suffix}`;
const int = (v: number | null | undefined) =>
  v === null || v === undefined ? "n/a" : Math.round(v).toLocaleString();

/** Resolve airport mentions: IATA code, airport name, or city name. */
export function findCodes(text: string, limit = 4): string[] {
  const ds = loadDataset();
  const hits: { code: string; at: number; weight: number }[] = [];
  const upper = text.toUpperCase();
  const lower = text.toLowerCase();

  for (const a of ds.airports) {
    // A bare three-letter code, not glued to another word.
    const codeAt = upper.search(new RegExp(`(^|[^A-Z])${a.code}([^A-Z]|$)`));
    if (codeAt >= 0) {
      hits.push({ code: a.code, at: codeAt, weight: 3 });
      continue;
    }
    if (a.city && a.city.length > 3) {
      const cityAt = lower.indexOf(a.city.toLowerCase());
      // Prefer the city's busiest field when several share a city name.
      if (cityAt >= 0) hits.push({ code: a.code, at: cityAt, weight: 1 + (a.enp_2024 ?? 0) / 1e9 });
    }
  }

  const best = new Map<string, { at: number; weight: number }>();
  for (const h of hits) {
    const cur = best.get(h.code);
    if (!cur || h.weight > cur.weight) best.set(h.code, { at: h.at, weight: h.weight });
  }
  // Deduplicate cities that resolved to several airports: keep the strongest.
  return [...best.entries()]
    .sort((a, b) => b[1].weight - a[1].weight || a[1].at - b[1].at)
    .slice(0, limit)
    .sort((a, b) => a[1].at - b[1].at)
    .map(([code]) => code);
}

/** Where an airport was mentioned: by code, or by the city it serves. */
function positionOf(text: string, code: string): number {
  const byCode = text.toUpperCase().indexOf(code);
  if (byCode >= 0) return byCode;
  const city = loadDataset().airports.find((a) => a.code === code)?.city;
  const byCity = city ? text.toLowerCase().indexOf(city.toLowerCase()) : -1;
  return byCity >= 0 ? byCity : Number.MAX_SAFE_INTEGER;
}

function detectFocus(q: string): CompareFocus {
  if (/congest|delay|taxi|busy|backed up|queue/i.test(q)) return "congestion";
  if (/capacit|runway|headroom|terminal|gate|expan/i.test(q)) return "capacity";
  if (/grow|growth|trend|cagr|momentum|forecast/i.test(q)) return "growth";
  if (/demand|spill|unmet|underserved|under-served|load/i.test(q)) return "demand";
  return "overall";
}

function detectComponent(q: string): ComponentKey | undefined {
  if (/unmet|spill|underserved|under-served/i.test(q)) return "unmet";
  if (/congest|delay|taxi/i.test(q)) return "congestion";
  if (/headroom|capacit|runway|terminal/i.test(q)) return "headroom";
  if (/growth|momentum|cagr/i.test(q)) return "momentum";
  if (/risk|concentration|weather/i.test(q)) return "risk";
  return undefined;
}

/**
 * Field names come off the tool payload in camelCase. Turning
 * "p80TaxiOutMin" into "P80 Taxi Out Min" is not an improvement, so the
 * ones that appear in comparisons get written out properly.
 */
const METRIC_LABELS: Record<string, string> = {
  hubClass: "Airport size",
  rus: "Score out of 100",
  band: "Score uncertainty",
  avgDepartureDelayMin: "Average departure delay (min)",
  p80DepartureDelayMin: "Departure delay on a slow day (min)",
  shareDelayedOver15Pct: "Flights over 15 min late (%)",
  p80TaxiOutMin: "Taxi time on a slow day (min)",
  peakHourMovements: "Flights in the busiest hour",
  peakMovementsPerRunway: "Busiest-hour flights per runway",
  runways: "Runways",
  cancelRatePct: "Flights cancelled (%)",
  divertRatePct: "Flights diverted (%)",
  longestRunwayFt: "Longest runway (ft)",
  movementsAnnualised: "Flights per year",
  runwayUtilisation: "How full the runways are",
  enplanements2024: "Passengers in 2024",
  enplanementsPerRunway: "Passengers per runway",
  enplanements: "Passengers by year",
  cagr2yrPct: "Passenger growth per year (%)",
  growthLastYearPct: "Passenger growth last year (%)",
  paxPerDeparture: "Passengers per flight",
  catchmentPopulation: "People living within 100 km",
  populationPerEnplanement: "People nearby per passenger",
};

function plainMetricLabel(key: string): string {
  if (METRIC_LABELS[key]) return METRIC_LABELS[key];
  // Anything left is a score component, already renamed loudly by the tool.
  return key
    .replace(/_normalisedWithinOwnHubClassOnly_notComparableHere$/, " (not comparable here)")
    .replace(/Component$/, " score")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

/* -------------------------------------------------------------- answers */

function answerRank(q: string): DeterministicAnswer {
  const region = findRegion(q);
  const metro = findMetro(q);
  const states = region ? undefined : findStates(q);
  const limit = Number(q.match(/top\s+(\d+)/i)?.[1] ?? 5);

  const args = {
    region: region?.key,
    metro: region ? undefined : metro?.key,
    states: states?.length ? states : undefined,
    limit,
  };
  const r = rankAirports(
    { region: args.region, metro: args.metro, states: args.states },
    {},
    limit,
  );

  if (r.results.length === 0) {
    return {
      text: `No screened airports matched **${r.scope}**. ${r.scopeNotes.join(" ")}\n\nThe screening floor is 100,000 annual enplanements; ask again with smaller airports included if that is what you want.`,
      toolCalls: [{ tool: "rankAirports", args, result: r }],
    };
  }

  const rows = r.results
    .map(
      (a) =>
        `| ${a.rank} | **${a.code}** | ${a.city ?? a.name?.slice(0, 22)} | ${Math.round(a.rus ?? 0)} | ${a.driver} | ${int(a.enplanements2024)} |`,
    )
    .join("\n");

  const top = r.results[0];
  const second = r.results[1];

  const lead =
    `**${top.code} is the strongest candidate in ${r.scope}, scoring ${Math.round(top.rus ?? 0)} out of 100.** ` +
    `Its main problem is ${top.driver?.toLowerCase()}.` +
    (second ? ` ${second.code} is next at ${Math.round(second.rus ?? 0)}.` : "");

  return {
    text: `${lead}

| # | Airport | City | Score | Main driver | Passengers 2024 |
|---|---------|------|-------|-------------|-----------------|
${rows}

${r.scopeNotes.join(" ")} Airports are compared against others of a similar size, so scores are not comparable between a small airport and a large one.

No one publishes terminal floor space for US airports, so "terminal expansion" here means pressure on flight capacity, not measured terminal size.`,
    toolCalls: [{ tool: "rankAirports", args, result: r }],
  };
}

function answerCompare(q: string, codes: string[]): DeterministicAnswer {
  const focus = detectFocus(q);
  const r = compareAirports(codes, focus);
  // Flag a metro whose alternates we did not use, so the user can redirect.
  const metro = findMetros(q).find((m) => m.codes.length > 1) ?? findMetro(q);

  // Drop the score fields the tool already flagged as not comparable here, and
  // the uncertainty band, which is detail rather than comparison.
  const keys = [
    ...new Set(
      r.airports.flatMap((a) =>
        Object.keys(a).filter(
          (k) => !["code", "name", "band"].includes(k) && !k.includes("notComparableHere"),
        ),
      ),
    ),
  ];
  const header = `| Metric | ${r.airports.map((a) => `**${a.code}**`).join(" | ")} |`;
  const sep = `|---|${r.airports.map(() => "---").join("|")}|`;
  const body = keys
    .map((k) => {
      const cells = r.airports.map((a) => {
        const v = (a as Record<string, unknown>)[k];
        if (v === null || v === undefined) return "n/a";
        if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2);
        if (typeof v === "object") return JSON.stringify(v);
        return String(v);
      });
      return `| ${plainMetricLabel(k)} | ${cells.join(" | ")} |`;
    })
    .join("\n");

  const ambiguity =
    metro && metro.codes.length > 1
      ? `\n\n${metro.label} has more than one airport: ${metro.codes.join(", ")}. This used ${codes.join(" and ")} — name another if you meant a different one.`
      : "";

  // Lead with the verdict computed from raw metrics, not from component values,
  // which are normalised inside each airport's own hub class.
  const verdict = r.rawComparison?.headline
    ? `**${r.rawComparison.headline}**\n\n` +
      r.rawComparison.metrics
        .filter((m) => m.verdict)
        .map((m) => `- ${m.verdict}`)
        .join("\n") +
      "\n\n"
    : "";

  return {
    text: `**${codes.join(" vs ")}** — ${focus}.

${verdict}${header}
${sep}
${body}

${r.comparabilityNote}${ambiguity}`,
    toolCalls: [{ tool: "compareAirports", args: { codes, focus }, result: r }],
  };
}

function answerHaul(code: string): DeterministicAnswer {
  const r = haulMix(code);
  if ("error" in r) {
    return { text: r.error as string, toolCalls: [{ tool: "haulMix", args: { code }, result: r }] };
  }
  return {
    text: `**${r.longHaulPct}% of flights leaving ${r.code} are long haul** — over 4,000 km. The national figure is ${r.nationalLongHaulPct}%.

| Distance | Share of flights |
|---|---|
| Short (under 1,500 km) | ${r.shortHaulPct}% |
| Medium (1,500–4,000 km) | ${r.mediumHaulPct}% |
| Long (over 4,000 km) | ${r.longHaulPct}% |

The average flight covers ${int(r.avgStageLengthKm)} km. Based on ${int(r.departuresInWindow)} flights in 2024.

This counts US domestic flights by the major airlines only. Anchorage's international and cargo traffic is not included, and for this airport that leaves a lot out.`,
    toolCalls: [{ tool: "haulMix", args: { code }, result: r }],
  };
}

function answerExplain(q: string, code: string): DeterministicAnswer {
  const component = detectComponent(q);
  const r = explainScore(code, component);
  if ("error" in r) {
    return { text: r.error as string, toolCalls: [{ tool: "explainScore", args: { code }, result: r }] };
  }

  const blocks = (r.explanation ?? [])
    .map((c) => {
      const inputs = c.inputs
        .map(
          (i) =>
            `| ${i.label} | ${fmt(i.raw, 1)} ${i.unit} | ${fmt(i.peerMedian, 1)} | ${i.vsPeerMedian} |`,
        )
        .join("\n");
      const sign = (c.pointsContributed ?? 0) >= 0 ? "adds" : "takes off";
      return `**${c.component}** — ${sign} ${fmt(Math.abs(c.pointsContributed ?? 0))} points.

| Measure | ${r.code} | Similar airports | |
|---|---|---|---|
${inputs}`;
    })
    .join("\n\n");

  return {
    text: `**${r.code} scores ${Math.round(r.rus ?? 0)} out of 100**, compared against ${r.peerCount} airports of a similar size.

${blocks}

These figures show what already happened at the airport, not a forecast of demand. Nothing here estimates what a project would cost.`,
    toolCalls: [{ tool: "explainScore", args: { code, component }, result: r }],
  };
}

function answerProfile(code: string): DeterministicAnswer {
  const r = airportProfile(code);
  if ("error" in r) {
    return { text: r.error as string, toolCalls: [{ tool: "airportProfile", args: { code }, result: r }] };
  }
  return {
    text: `**${r.code} — ${r.name}** (${r.city}, ${r.state}).

**Scores ${Math.round(r.rus ?? 0)} out of 100**, ranking ${r.positionInHubClass} of ${r.hubClassSize} among airports of a similar size. Its main driver is ${r.driver?.toLowerCase()}.

| | |
|---|---|
| Enplanements 2024 | ${int(r.traffic?.enplanements[2024])} |
| 2-year CAGR | ${fmt(r.traffic?.enplanementCagr2yrPct)}% |
| Runways (open) | ${r.physical?.runways} |
| Annualised movements | ${int(r.traffic?.movementsAnnualised)} |
| Runway utilisation | ${fmt(r.traffic?.runwayUtilisation, 3)} × nominal capacity |
| Peak-hour movements | ${fmt(r.traffic?.peakHourMovements)} |
| Avg departure delay | ${fmt(r.performance?.avgDepartureDelayMin)} min |
| Taxi-out, p80 | ${fmt(r.performance?.p80TaxiOutMin)} min |
| Cancelled | ${fmt(r.performance?.cancelRatePct, 2)}% |
| Top carrier | ${r.market?.topCarrier} at ${fmt(r.market?.topCarrierSharePct)}% |
| Catchment (100 km) | ${int(r.market?.catchmentPopulation)} people |

*${r.provenance}*`,
    toolCalls: [{ tool: "airportProfile", args: { code }, result: r }],
  };
}

function answerDataset(): DeterministicAnswer {
  const r = datasetInfo();
  return {
    text: `**${r.airports} US airports** with scheduled service, of which ${r.scored} carry enough data to score and ${r.screened} clear the screening floor of 100,000 annual enplanements.

Flight window: ${r.window.first_date} to ${r.window.last_date} — ${r.window.months} of 12 months, ${int(r.flightRows)} flight records.

Default weights: congestion ${r.defaultWeights.congestion}, headroom ${r.defaultWeights.headroom}, momentum ${r.defaultWeights.momentum}, unmet ${r.defaultWeights.unmet}, risk −${r.defaultWeights.risk}.

**Known limits.**
${r.caveats.map((c) => `- ${c}`).join("\n")}

*${r.provenance}*`,
    toolCalls: [{ tool: "datasetInfo", args: {}, result: r }],
  };
}

/** Say out loud when the subject came from the previous turn, not this one. */
function withCarryNote(
  answer: DeterministicAnswer,
  inherited: boolean,
  subject: string,
): DeterministicAnswer {
  if (!inherited) return answer;
  return {
    ...answer,
    text: `*Carried over from the previous question: ${subject}.*\n\n${answer.text}`,
  };
}

/* ------------------------------------------------------------- routing */

export function answerDeterministically(
  question: string,
  history: { role: string; content: string }[] = [],
): DeterministicAnswer {
  const q = question.trim();

  // Follow-ups usually drop the subject: "why?", "and its growth?". When the
  // question names no airport, inherit the one the conversation was last about.
  let codes = findCodes(q);
  let carried: string[] = [];
  if (codes.length === 0) {
    for (let i = history.length - 1; i >= 0 && carried.length === 0; i--) {
      carried = findCodes(history[i].content, 2);
    }
    codes = carried;
  }
  const inherited = carried.length > 0;

  if (/what data|which data|dataset|where.*data.*from|your sources|coverage/i.test(q)) {
    return answerDataset();
  }
  if (/long.?haul|short.?haul|stage length|haul mix|percentage of .*flights/i.test(q)) {
    if (codes[0]) return answerHaul(codes[0]);
  }
  if (/compare|versus| vs\.?[ ]|difference between/i.test(q)) {
    // Metro names and explicit codes both count. "LA and Santa Ana" is two
    // metros; each contributes its primary field unless a code was named.
    // Ordering follows the question, so the answer reads back the way it was asked.
    const mentioned: { code: string; at: number }[] = [
      ...codes.map((code) => ({ code, at: positionOf(q, code) })),
      ...findMetroMatches(q).map(({ m, at }) => ({ code: m.codes[0], at })),
    ];
    const pair: string[] = [];
    for (const { code } of mentioned.sort((a, b) => a.at - b.at)) {
      if (!pair.includes(code)) pair.push(code);
    }
    if (pair.length >= 2) return answerCompare(q, pair.slice(0, 3));
  }
  if (/why|explain|unmet|reason|drives|driver|breakdown/i.test(q) && codes[0]) {
    return withCarryNote(answerExplain(q, codes[0]), inherited, codes[0]);
  }
  if (/candidate|rank|best|top|strong|which airports|shortlist|expansion/i.test(q)) {
    return answerRank(q);
  }
  if (codes.length === 1) return withCarryNote(answerProfile(codes[0]), inherited, codes[0]);
  if (codes.length > 1) return withCarryNote(answerCompare(q, codes), inherited, codes.join(", "));

  const regionList = REGIONS.map((r) => r.label).join(", ");
  return {
    text: `I could not tell which airports that question is about.

Try one of these shapes:
- "Which airports in New England are strong candidates for terminal expansion?"
- "Compare LAX and SNA congestion."
- "What percentage of flights out of Anchorage are long haul?"
- "Why does SFO score the way it does on unmet demand?"

Regions I resolve: ${regionList}. Airports can be named by IATA code or city.`,
    toolCalls: [],
  };
}
