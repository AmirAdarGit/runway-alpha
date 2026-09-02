# Runway Alpha

An analyst-facing agent that ranks US airports on how much profitable capacity a
renovation would unlock. Built for the Airport Investment Intelligence exercise.

The investment question is not "which airport is busy" — it is **where is demand
pressing against a physical constraint that concrete can relieve**. Busy and
roomy is a bad deal. Constrained and shrinking is worse. The target is
constrained, growing, and structurally under-built. That thesis is encoded as a
deterministic score, not as a prompt.

---

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
```

The built dataset (`data/airports.json`, well under a megabyte) is committed, so
the app runs with **no API key, no database, and no network**. With no model
configured the chat answers from the deterministic path — same tools, same
numbers, plainer prose.

To use a model, set one of these and restart:

```bash
GROQ_API_KEY=...                   # free tier, fastest
GOOGLE_GENERATIVE_AI_API_KEY=...   # free tier
ANTHROPIC_API_KEY=...
```

Optional overrides: `GROQ_MODEL`, `GOOGLE_MODEL`, `ANTHROPIC_MODEL`. `GET /api/models`
lists what the configured credential can actually reach — provider catalogues
churn, and `llama-3.3-70b-versatile` has already been retired from Groq.

**On Groq latency.** The free tier queues. The same question with identical
input tokens has come back in 2.5 s and in 46 s. Nothing in this app accounts
for the difference. If you are demonstrating live, either warm the model with
one throwaway question first, or use **Run without the model** — the answer is
instant and the figures are identical.

```bash
npm test         # 38 tests: scoring arithmetic, tool integration, number check
npm run typecheck
```

## Rebuild the data from source

```bash
npm run ingest   # download → extract → aggregate → data/airports.json
```

That fetches ~3 GB of BTS CSVs into `data/raw/` (gitignored). Nearly all of the
wall clock is the download — transtats.bts.gov serves at roughly 50 KB/s per
connection, so the 12 months are pulled over 6 parallel resumable curls. The
aggregation itself is 35 seconds for 7.08 M flight records. Stages can be run
individually:

```bash
npm run ingest:download   # OurAirports, FAA enplanements, Census
npm run ingest:ontime     # BTS On-Time, 12 months, 6 parallel connections
npm run ingest:build      # DuckDB aggregation → data/airports.json
```

---

## The four questions

| Question | Tool | What the answer contains |
|---|---|---|
| Which airports in New England are strong candidates for terminal expansion? | `rankAirports` | RUS-ranked shortlist, each with its dominant driver, plus the six states "New England" was read as, plus the admission that terminal square footage is inferred |
| Compare LA and Santa Ana airport congestion levels. | `compareAirports` | Delay, taxi-out, peak-hour movements per runway, side by side; names the four other LA-area fields it did not use |
| What is the percentage of long haul flights out of Anchorage airport? | `haulMix` | Share by distance bucket with thresholds restated, and the warning that cargo and international are excluded — which for ANC changes everything |
| What is the unmet flight demand in SFO airport and why? | `explainScore` | Each input, its peer median, its contribution — then the limit: this is revealed spill, not a demand model |

Every one of these is also a plain URL with no model in the path:

```
/api/rank?region=new_england&limit=5
/api/compare?codes=LAX,SNA&focus=congestion
/api/haul/ANC
/api/explain/SFO?component=unmet
/api/airport/SFO
/api/dataset
/api/live?codes=SFO,LAX
```

`/api/rank` also accepts `w_congestion`, `w_headroom`, `w_momentum`, `w_unmet`,
`w_risk` to re-run the whole ranking under different weights.

---

## Scoring

**Renovation Upside Score (RUS), 0–100.** Computed in `lib/scoring/`, which
imports nothing from any model SDK.

```
RUS = 100 × ( 0.30·CPI + 0.25·HCD + 0.20·DMI + 0.15·UDI − 0.10·RSK )
```

| Component | Weight | Inputs | Why |
|---|---|---|---|
| Congestion pressure | 0.30 | avg departure delay (.35), taxi-out p80 (.30), peak-hour movements per runway (.35) | Delay is the observable price of a constraint, and the best-measured signal available |
| Headroom deficit | 0.25 | movements vs runway capacity (.5), enplanements per runway (.5) | Throughput per unit of physical plant — doing a lot with too little is what a build fixes |
| Demand momentum | 0.20 | enplanement CAGR 2023→25 (.6), growth 2024→25 (.4) | A renovation pays back over decades; a congested but flat airport is a trap |
| Unmet demand | 0.15 | passengers per departure (.4), cancelled + diverted (.3), catchment population per enplanement (.3) | Spill: full aircraft, unreliable service, an under-served catchment |
| Risk penalty | −0.10 | carrier HHI (.5), weather/airspace share of delay (.5) | Single-carrier dependence and weather mean new concrete may not convert to throughput |

**Rules that keep it honest**

- **Peer normalisation.** Each input is winsorised at the 5th/95th percentile of
  the airport's FAA hub class, then min–max scaled inside that class. A nonhub is
  ranked against nonhubs. Scores from different classes are *not* comparable, and
  every payload says so.
- **Nearest-rank winsorising.** The percentile bounds pick an observed value
  rather than interpolating toward the next one — otherwise one extreme airport
  drags the 95th percentile of a small peer group and flattens everyone else.
- **Coverage gate.** Fewer than four measurable components and the airport scores
  `null` with a stated reason, never a guess. Missing inputs inside a component
  are dropped and the rest re-weighted, which lowers confidence rather than
  silently scoring zero.
- **Sample floor.** Delay statistics are discarded below 500 departures in the
  window: real numbers, statistically empty.
- **Confidence band.** Every score ships with a ±, derived from input coverage
  and sample size, capped below certainty. 71 ± 9 and 71 ± 2 are different
  recommendations.
- **Weights are input, not code.** The sliders in the UI re-score all airports in
  the browser using the same module the API uses.

---

## Where AI is used, and where it is not

**Used for:** reading "New England" as a six-state filter, resolving "LA and
Santa Ana" to two metros in the order asked, choosing which tool answers a
question, writing the prose, and carrying context across follow-ups.

**Not used for:** any component value, any weight, any ranking order, any
percentage. Those come from tested pure functions and are injected into the
answer as structured JSON.

Three mechanisms enforce that line rather than trusting it:

1. **The tool layer is the only path to a number** (`lib/tools.ts`). Each payload
   carries its own provenance and caveats.
2. **A post-hoc number check** (`lib/agent/verify.ts`) extracts every figure from
   the answer and looks for it in the tool payloads. Anything unaccounted for is
   flagged in the UI next to the answer, not hidden in a log.
3. **A no-tool answer is rejected.** If the model produces figures without
   calling a tool, the server discards it and serves the deterministic answer
   instead, saying so.

The deterministic answerer (`lib/agent/deterministic.ts`) also exists as a
control: press **Run without the model** and the same question is answered by
rules over the same tools. If the two disagree, the model is wrong.

---

## Architecture

```
scripts/ingest/download.ts   OurAirports, FAA enplanements, Census bulk files
scripts/ingest/ontime.sh     BTS On-Time, 12 months, resumable parallel curl
scripts/ingest/build.mts     DuckDB aggregation → data/airports.json  (offline)
        │
data/airports.json           389 airports × ~45 measured fields, committed
        │
lib/scoring/                 pure, tested, no model — RUS and its components
lib/tools.ts                 the only path to a number; provenance attached
        ├── app/api/*        one HTTP route per tool, callable with no model
        └── lib/agent/       system prompt, tool schemas, number check, fallback
                │
app/page.tsx + components/Console.tsx    three panes: ranking, chat, evidence
```

DuckDB is used **offline only**, as an ETL engine over 7,079,061 flight records.
Nothing at runtime touches a database: the aggregated JSON is small enough to
load into module scope on the server and to ship to the browser, which is what
lets the weight sliders re-score instantly.

---

## Data sources

All public, all free, no aviation vendor.

| Source | Gives us | Vintage |
|---|---|---|
| BTS On-Time Performance | Per-flight delays, taxi-out, cancels, diversions, distance, scheduled times, carrier | CY2024, 12 months, 7.08 M records |
| FAA ACAIS enplanements | Annual boardings, official hub class | CY2023–CY2025 (2025 preliminary) |
| OurAirports | Runways, coordinates, state, IATA↔FAA identifiers | current |
| US Census (bulk) | County population and centroids for catchment | 2024 estimates |
| FAA NAS Status | Live ground stops and delay programmes | live, request-time |

---

## Assumptions and limits, stated up front

- **No terminal square footage exists in any free national dataset.** "Terminal
  expansion" is therefore scored as movement-capacity pressure — inferred, never
  measured. This is the single biggest weakness and the agent says so whenever a
  question is terminal-specific.
- **Domestic only.** BTS On-Time covers scheduled domestic service by reporting
  carriers. No international passenger flights, no all-cargo. For Anchorage —
  a top-five global freight hub — this changes the haul-mix answer materially.
- **BTS T-100 was not reachable.** Its bulk download endpoints now 404, so seats
  and load factor are unavailable. Load is proxied by passengers per departure
  (annual enplanements ÷ annualised departures), which is stated as a proxy.
- **Runway capacity is a rule of thumb**: 200,000 annual operations per runway,
  before runway geometry and configuration. Crude, and it over-penalises airports
  with closely spaced parallel runways.
- **Catchment is a 100 km radius** sum of county population — a stand-in for a
  drive-time isochrone.
- **Long haul is >4,000 km** great-circle; the threshold is a parameter and the
  agent restates it with every haul figure.
- **Nothing here prices construction cost, land, or political feasibility.** RUS
  measures upside. It ranks candidates for a human to underwrite; it does not
  price the deal.

Design document with the full reasoning: `docs/plan.html`.
