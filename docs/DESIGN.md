# Design and architecture

Runway Alpha ranks 389 US airports on how much profitable capacity a renovation
would unlock, and answers analyst questions about them in chat.

This document covers the three things the brief asked for: the scoring
methodology, the key tradeoffs, and where AI is used. It is deliberately short.
`README.md` covers running it; the code is the reference for detail.

---

## 1. The thesis, in one paragraph

The investment question is not "which airport is busy." It is **where demand is
pressing against a physical constraint that concrete can relieve**. Busy and
roomy is a bad deal. Constrained and shrinking is worse. The target is
constrained, growing, and structurally under-built. That thesis is encoded as
arithmetic in `lib/scoring/index.ts` — not as a prompt.

---

## 2. Scoring methodology

### The five components

Each airport gets a **Renovation Upside Score** from 0 to 100: five weighted
components, each built from measured operational inputs.

| Component | Weight | Inputs (and their internal weights) |
|---|---|---|
| **Delays and congestion** | 0.30 | Average departure delay (0.35), taxi-out time on a slow day (0.30), flights per runway in the busiest hour (0.35) |
| **Running out of room** | 0.25 | Runway utilisation (0.50), passengers per runway (0.50) |
| **Passenger growth** | 0.20 | Two-year CAGR 2023→2025 (0.60), last-year growth 2024→2025 (0.40) |
| **Demand it cannot serve** | 0.15 | Passengers per flight (0.40), cancellation + diversion rate (0.30), nearby population per passenger (0.30) |
| **Risk** | **−0.10** | Single-airline reliance, Herfindahl (0.50), share of delay from weather or airspace (0.50) |

Risk is **subtracted**. An airport that is congested because one carrier
dominates it, or because of weather nobody can build away, is a worse
investment than the raw congestion figure suggests.

### How a raw number becomes a score

1. **Winsorise at the 5th and 95th percentile.** One outlier airport otherwise
   drags every other score with it. Quantiles are **nearest-rank**, not
   interpolated — interpolation pulled the cap toward the outlier, and a test
   caught a 0.198 score movement from a single extreme value.
2. **Min–max scale within FAA hub class.** Large hubs are scaled against large
   hubs, non-hubs against non-hubs. A delay minute at LAX and a delay minute at
   Bangor are not the same event. If a class has fewer than 8 members it is
   pooled rather than scaled against too few peers.
3. **Weight and sum.** Four positive components added, risk subtracted, result
   scaled to 0–100.

### The guards

- **Coverage gate** — an airport needs at least **4 of 5** components present or
  it is not scored at all. 338 of 389 airports clear this. The other 51 have no
  BTS flight data whatsoever.
- **Sample floor** — delay statistics are ignored below **500 departures**.
  Below that they are noise.
- **Screening floor** — airports under **100,000 annual passengers** are
  excluded from rankings unless explicitly requested.
- **Confidence caps at 0.95**, never 1.0. The inputs have known gaps, and a
  score should not claim otherwise.

### One consequence worth stating plainly

Scoring runs on **all 389 airports first**, and filtering is applied to the
output. Scoring a filtered subset would measure each airport only against its
neighbours and change every number. Filtering never touches the arithmetic.

This is why **Bangor (56.7) ranks above Boston (28.9)** in New England. BGR is a
non-hub with one runway and 376,456 passengers, genuinely near its ceiling. BOS
has six runways and 21 M passengers and is scored against ATL and LAX, where it
is not unusually pressured. The score ranks **pressure, not deal size** — see
tradeoffs below.

---

## 3. Where AI is used, and where it is not

The language model does exactly two things:

1. **Reads the question and picks one tool**, with arguments.
2. **Turns the tool's output into prose.**

It does not compute, rank, estimate, or retrieve. It cannot see the dataset. Its
only route to a number is a tool call.

### The seven tools

`rankAirports`, `airportProfile`, `compareAirports`, `haulMix`, `explainScore`,
`datasetInfo`, `resolveScope` — defined in `lib/tools.ts`. Every payload carries
provenance, the data vintage, and its own known limits. There is a test
asserting that no payload can ship without provenance.

### Three defences against fabrication

- **Post-hoc number verification** (`lib/agent/verify.ts`). After the model
  writes, code extracts every figure from the reply and matches each against the
  tool payloads. Unmatched figures are flagged on screen, next to the answer.
  The UI badge reads `6 figures verified`.
- **No-tool-call rejection** (`app/api/chat/route.ts`). If the model answers
  without calling a tool, it invented everything. The server discards the reply,
  answers from the deterministic path, and says that it did.
- **A deterministic answerer** (`lib/agent/deterministic.ts`). Same tools, same
  numbers, plainer prose, no model. It is the offline fallback *and* the control
  case: if the two paths ever disagree on a figure, the model is wrong.

### Model choice

Groq `openai/gpt-oss-120b` — free tier, typically 1.3–1.7 s. The 20B model was
tested and was both slower and worse at tool selection. Google and Anthropic are
wired behind the same interface; the model is the one component the design
treats as replaceable.

---

## 4. Key tradeoffs

**Scoring within hub class, not across all airports.**
Comparing a non-hub's delay minutes to a large hub's is meaningless, so scores
are only comparable *within* a class. The cost is that cross-class questions
("compare LA and Santa Ana") cannot use scores at all — those answers lead with
raw measured figures instead, and the payload says why. An earlier version got
this wrong and claimed SNA was more congested than LAX using normalised values
from different classes.

**The score ranks pressure, not profit.**
No deal size, no capital cost, no return estimate. An airport topping its class
may still be a small cheque. This is a screening tool that narrows 389 airports
to a shortlist worth a human week — it does not replace the week. Multiplying by
addressable spend is the first thing a real product would add.

**Public bulk files instead of live APIs.**
The BTS T-100 endpoint returns 404 on every bulk URL; that source is dead. The
Census ACS API now requires a registered key, which would make the ingest
impossible to run from a clean clone. So the ingest pulls published public
datasets directly and needs **no credentials**. Same public sources, fetched the
way that works today.

**Passengers-per-departure standing in for load factor.**
T-100 was the seats source. Its loss means true load factor is unavailable, so
passengers-per-departure is used and **labelled as an approximation** everywhere
it appears rather than presented as load factor.

**Operational strain inferred, not measured directly.**
No free national source exists for terminal square footage or gate counts. The
score infers constraint from how operations behave, which is why it measures
*revealed* strain rather than a capital plan.

**Domestic flights only.**
BTS On-Time covers scheduled domestic service by reporting carriers.
International departures are absent. This distorts Anchorage most, and the
haul-mix answer states the limitation on screen every time.

**Weights are a judgement, exposed rather than hidden.**
Congestion and capacity are weighted highest because they are what a terminal
project directly relieves. They are not fitted to outcomes — there is no
outcome dataset. So they are exposed as sliders in the UI: an analyst who
disagrees re-weights and watches the ranking move, and every tool payload
records which weights produced that answer.

---

## 5. Architecture

```
Question
   ↓
Model picks one tool + arguments        ← the only AI in the request path
   ↓
Tool resolves scope from a lookup table  (regions are code, not guesses)
   ↓
Score all 389 airports                   (deterministic, lib/scoring)
   ↓
Filter to the requested scope            (output only, never the arithmetic)
   ↓
Payload: figures + provenance + limits
   ↓
Model writes prose                      ← the second and last AI step
   ↓
Verify every number against the payload  (deterministic)
   ↓
Answer + verification badge
```

Next.js 16 App Router, React 19, TypeScript strict. DuckDB is used **offline
only**, as the ETL engine — 7,079,061 BTS flight records reduced to a 389-row
JSON file in 35 seconds. The app itself reads that committed file and needs no
database and no network.

**Data sources.** BTS On-Time Performance (full calendar year 2024, 7,079,061
records), FAA ACAIS enplanements (2023–2025, CY2025 preliminary), OurAirports
runway counts and coordinates, US Census county population with gazetteer
centroids for 100 km catchments.

**Tests.** 38, via `node:test`. They assert invariants rather than figures —
"shares sum to 100", "results come back sorted", "no payload ships without
provenance" — because the numbers move when the ingest window moves, but the
invariants must hold for any vintage.

```bash
npm test     # 38/38, ~0.7s
```

---

## 6. What I would do next

1. **Addressable spend.** Multiply the score by what a project would actually
   cost and unlock. This turns a pressure ranking into an investment ranking and
   is the single largest gap.
2. **International flights.** A paid or scraped source would remove the biggest
   caveat on the dataset.
3. **Gate and terminal inventory.** Would replace inferred constraint with
   measured constraint.
4. **Backtesting.** With historical enplanement data, check whether airports the
   score flagged in 2019 actually expanded — the only honest way to move the
   weights off judgement.
