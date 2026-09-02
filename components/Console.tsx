"use client";

import { useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  COMPONENT_LABELS,
  DEFAULT_WEIGHTS,
  scoreAirports,
} from "@/lib/scoring";
import type {
  AirportRecord,
  ComponentKey,
  ScoredAirport,
  Weights,
} from "@/lib/scoring/types";
import { REGIONS } from "@/lib/regions";

/**
 * The console runs the SAME scoring module the server runs. Moving the weight
 * sliders re-scores every airport in the browser, with no round trip and no
 * model — which is the fastest way to show an interviewer that the ranking is
 * arithmetic they can steer, not text a model produced.
 */

interface Props {
  airports: AirportRecord[];
  meta: {
    flight_window: { first_date: string; last_date: string; months: number };
    flight_rows: number;
    caveats: string[];
  };
  provenance: string;
  modelLabel: string;
}

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  toolCalls?: { tool: string; args: unknown; result: unknown }[];
  mode?: string;
  model?: string;
  numberCheck?: { checked: number; unverified: string[] };
  elapsedMs?: number;
}

const SAMPLES = [
  "Which airports in New England are strong candidates for terminal expansion?",
  "Compare LA and Santa Ana airport congestion levels.",
  "What is the percentage of long haul flights out of Anchorage airport?",
  "What is the unmet flight demand in SFO airport and why?",
];

const fmt = (v: number | null | undefined, dp = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(dp);
const int = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : Math.round(v).toLocaleString();

export default function Console({ airports, meta, provenance, modelLabel }: Props) {
  const [weights, setWeights] = useState<Weights>({ ...DEFAULT_WEIGHTS });
  const [region, setRegion] = useState("");
  const [hub, setHub] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [pending, setPending] = useState(false);
  const [input, setInput] = useState("");
  const [listening, setListening] = useState(false);
  const [speak, setSpeak] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Deterministic core, run client-side. Re-runs only when weights change.
  const scored = useMemo(() => scoreAirports(airports, { weights }), [airports, weights]);

  const rows = useMemo(() => {
    const states = REGIONS.find((r) => r.key === region)?.states;
    const q = query.trim().toLowerCase();
    return scored
      .filter((s) => s.rus !== null)
      .filter((s) => s.airport.screened !== false)
      .filter((s) => !states || (s.airport.state && states.includes(s.airport.state)))
      .filter((s) => !hub || (s.airport.hub ?? "N") === hub)
      .filter(
        (s) =>
          !q ||
          s.airport.code.toLowerCase().includes(q) ||
          (s.airport.name ?? "").toLowerCase().includes(q) ||
          (s.airport.city ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => b.rus! - a.rus!);
  }, [scored, region, hub, query]);

  const lastAnswer = [...turns].reverse().find((t) => t.role === "assistant");
  const detail: ScoredAirport | null =
    scored.find((s) => s.airport.code === selected) ?? null;

  async function ask(question: string, force?: "deterministic") {
    if (!question.trim() || pending) return;
    const history: ChatTurn[] = [...turns, { role: "user", content: question }];
    setTurns(history);
    setInput("");
    setPending(true);
    requestAnimationFrame(() => logRef.current?.scrollTo({ top: 1e6, behavior: "smooth" }));

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: history.map((t) => ({ role: t.role, content: t.content })),
          force,
        }),
      });
      const data = await res.json();
      const turn: ChatTurn = {
        role: "assistant",
        content: data.text ?? data.error ?? "No answer returned.",
        toolCalls: data.toolCalls,
        mode: data.mode,
        model: data.model,
        numberCheck: data.numberCheck,
        elapsedMs: data.elapsedMs,
      };
      setTurns([...history, turn]);

      // Focus the evidence panel on whatever the answer was about.
      const code = firstCodeIn(data.toolCalls ?? []);
      if (code) setSelected(code);
      if (speak) say(turn.content);
    } catch (e) {
      setTurns([
        ...history,
        { role: "assistant", content: `Request failed: ${e instanceof Error ? e.message : String(e)}` },
      ]);
    } finally {
      setPending(false);
      requestAnimationFrame(() => logRef.current?.scrollTo({ top: 1e6, behavior: "smooth" }));
    }
  }

  function listen() {
    const Rec =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike })
        .SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike })
        .webkitSpeechRecognition;
    if (!Rec) {
      alert("This browser has no speech recognition. Chrome and Edge do.");
      return;
    }
    const rec = new Rec();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.onresult = (e) => {
      const said = e.results[0][0].transcript;
      setInput(said);
      void ask(said);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    setListening(true);
    rec.start();
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <b>Runway Alpha</b>
          <span>Airport investment intelligence</span>
        </div>
        <div className="topmeta">
          <div>
            <b>{airports.length}</b> airports · <b>{rows.length}</b> in view
          </div>
          <div>
            flights <b>{meta.flight_window.first_date}</b>–<b>{meta.flight_window.last_date}</b> (
            {meta.flight_window.months}/12 mo)
          </div>
          <div>
            agent <b>{modelLabel}</b>
          </div>
        </div>
      </header>

      <div className="panes">
        {/* ------------------------------------------------ ranking */}
        <section className="pane">
          <div className="pane-head">
            <h2>Ranking — Renovation Upside Score</h2>
          </div>

          <div className="controls">
            <div className="row">
              <label className="field" style={{ flex: 1 }}>
                Region
                <select value={region} onChange={(e) => setRegion(e.target.value)}>
                  <option value="">All US</option>
                  {REGIONS.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Hub class
                <select value={hub} onChange={(e) => setHub(e.target.value)}>
                  <option value="">All</option>
                  <option value="L">Large</option>
                  <option value="M">Medium</option>
                  <option value="S">Small</option>
                  <option value="N">Nonhub</option>
                </select>
              </label>
            </div>
            <input
              type="text"
              placeholder="Filter by code, city or name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />

            <div className="weights">
              {(Object.keys(DEFAULT_WEIGHTS) as ComponentKey[]).map((k) => (
                <div className={`weight ${k === "risk" ? "risk" : ""}`} key={k}>
                  <span>
                    {COMPONENT_LABELS[k]}
                    {k === "risk" ? " (−)" : ""}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={0.6}
                    step={0.05}
                    value={weights[k]}
                    onChange={(e) => setWeights({ ...weights, [k]: Number(e.target.value) })}
                  />
                  <code>{weights[k].toFixed(2)}</code>
                </div>
              ))}
              <div className="row">
                <button className="btn ghost" onClick={() => setWeights({ ...DEFAULT_WEIGHTS })}>
                  Reset weights
                </button>
                <span className="hint">
                  Sliders re-score all {airports.length} airports in the browser, using the same
                  module the API uses.
                </span>
              </div>
            </div>
          </div>

          <div className="pane-body">
            <table className="rank">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Airport</th>
                  <th>Hub</th>
                  <th style={{ textAlign: "right" }}>RUS</th>
                  <th style={{ textAlign: "right" }}>Enpl. 2024</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s, i) => (
                  <tr
                    key={s.airport.code}
                    className={selected === s.airport.code ? "sel" : ""}
                    onClick={() => setSelected(s.airport.code)}
                  >
                    <td className="num" style={{ color: "var(--muted)" }}>
                      {i + 1}
                    </td>
                    <td>
                      <span className="code" style={{ fontFamily: "var(--mono)", fontWeight: 600 }}>
                        {s.airport.code}
                      </span>
                      <span className="airportname">{s.airport.name}</span>
                    </td>
                    <td>
                      <span className={`hubchip ${s.airport.hub ?? "N"}`}>{s.airport.hub ?? "N"}</span>
                    </td>
                    <td className="num">
                      <span className="scorecell">
                        <span className="scorebar">
                          <i style={{ width: `${Math.max(2, s.rus!)}%` }} />
                        </span>
                        {fmt(s.rus)}
                      </span>
                    </td>
                    <td className="num">{int(s.airport.enp_2024)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ padding: 16, color: "var(--muted)" }}>
                      Nothing matches that filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* --------------------------------------------------- chat */}
        <section className="pane">
          <div className="pane-head">
            <h2>Ask the agent</h2>
            <span className="spacer" />
            <button
              className={`btn ghost ${speak ? "on" : ""}`}
              onClick={() => setSpeak(!speak)}
              title="Read answers aloud"
            >
              {speak ? "Voice out on" : "Voice out off"}
            </button>
          </div>

          <div className="pane-body" ref={logRef}>
            {turns.length === 0 && (
              <div className="chatlog">
                <div className="empty">
                  Ask about a region, compare two airports, or challenge a score. Every figure in an
                  answer comes from a tool call, and the tool payload is shown on the right.
                </div>
              </div>
            )}
            <div className="chatlog">
              {turns.map((t, i) => (
                <div className={`msg ${t.role === "user" ? "user" : "agent"}`} key={i}>
                  <div className="who">{t.role === "user" ? "Analyst" : "Runway Alpha"}</div>
                  <div className="bubble">
                    {t.role === "user" ? (
                      t.content
                    ) : (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{t.content}</ReactMarkdown>
                    )}
                  </div>
                  {t.role === "assistant" && (
                    <div className="statusline">
                      <span className={`badge ${t.mode === "model" ? "model" : "rules"}`}>
                        {t.mode === "model" ? "model + tools" : "deterministic"}
                      </span>
                      <span>{t.model}</span>
                      {t.numberCheck && (
                        <span
                          className={`badge ${t.numberCheck.unverified.length ? "bad" : "ok"}`}
                          title={
                            t.numberCheck.unverified.length
                              ? `Not found in tool output: ${t.numberCheck.unverified.join(", ")}`
                              : "Every figure traced to a tool result"
                          }
                        >
                          {t.numberCheck.unverified.length
                            ? `${t.numberCheck.unverified.length} unverified of ${t.numberCheck.checked}`
                            : `${t.numberCheck.checked} figures verified`}
                        </span>
                      )}
                      {t.elapsedMs != null && <span>{(t.elapsedMs / 1000).toFixed(1)}s</span>}
                    </div>
                  )}
                </div>
              ))}
              {pending && <div className="thinking">calling tools…</div>}
            </div>
          </div>

          {turns.length === 0 && (
            <div className="chips">
              {SAMPLES.map((s) => (
                <button className="chip" key={s} onClick={() => ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}

          <div className="composer">
            <div className="row">
              <input
                type="text"
                placeholder="Ask about an airport, a region, or a score…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && ask(input)}
              />
              <button
                className={`btn ${listening ? "on" : ""}`}
                onClick={listen}
                title="Speak your question"
              >
                {listening ? "Listening…" : "Mic"}
              </button>
              <button className="btn primary" disabled={pending} onClick={() => ask(input)}>
                Ask
              </button>
            </div>
            <div className="statusline">
              <button
                className="btn ghost"
                onClick={() => ask(input || SAMPLES[0], "deterministic")}
                title="Answer the same question with rules only, as a control"
              >
                Run without the model
              </button>
              <span>Answers cite their source and vintage. Numbers are checked against tool output.</span>
            </div>
          </div>
        </section>

        {/* ----------------------------------------------- evidence */}
        <section className="pane">
          <div className="pane-head">
            <h2>Evidence</h2>
          </div>
          <div className="pane-body">
            <div className="evidence">
              {detail ? (
                <>
                  <div className="ev-title">
                    <b>{detail.airport.code}</b>
                    <span>
                      {detail.airport.city}, {detail.airport.state}
                    </span>
                  </div>
                  <div className="bigscore">
                    <b>{fmt(detail.rus)}</b>
                    <span>
                      ± {fmt(detail.band)} · confidence {detail.confidence.toFixed(2)} ·{" "}
                      {detail.peerGroup}, {detail.peerCount} peers
                    </span>
                  </div>

                  {detail.components.map((c) => (
                    <div className="comp" key={c.key}>
                      <div className="lbl">
                        <span>
                          {c.label}
                          {c.key === "risk" ? " (subtracted)" : ""}
                        </span>
                        <code>
                          {c.value === null ? "no data" : c.value.toFixed(2)} × {c.weight.toFixed(2)} ={" "}
                          {c.points >= 0 ? "+" : ""}
                          {c.points.toFixed(1)}
                        </code>
                      </div>
                      <div className={`compbar ${c.key === "risk" ? "neg" : ""}`}>
                        <i style={{ width: `${(c.value ?? 0) * 100}%` }} />
                      </div>
                      <div className="inputs">
                        {c.inputs.map((inp) => (
                          <div className="inputrow" key={inp.key}>
                            <span>{inp.label}</span>
                            <code>
                              {inp.raw === null
                                ? "not measured"
                                : `${formatRaw(inp.raw)} ${inp.unit}`}
                              {inp.peerMedian !== null && inp.raw !== null
                                ? ` · med ${formatRaw(inp.peerMedian)}`
                                : ""}
                            </code>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}

                  {detail.excludedReason && (
                    <div className="caveats">
                      <div>{detail.excludedReason}</div>
                    </div>
                  )}
                </>
              ) : (
                <div className="empty">
                  Select an airport on the left, or ask a question — the evidence for the answer lands
                  here.
                </div>
              )}

              {lastAnswer?.toolCalls?.length ? (
                <>
                  <div className="ev-title" style={{ marginTop: 4 }}>
                    <b style={{ fontSize: 12 }}>TOOL CALLS</b>
                    <span>behind the last answer</span>
                  </div>
                  {lastAnswer.toolCalls.map((tc, i) => (
                    <details className="toolcall" key={i}>
                      <summary>
                        {tc.tool}({shortArgs(tc.args)})
                      </summary>
                      <pre>{JSON.stringify(tc.result, null, 2)}</pre>
                    </details>
                  ))}
                </>
              ) : null}

              <div className="caveats">
                {meta.caveats.map((c, i) => (
                  <div key={i}>{c}</div>
                ))}
              </div>
              <div className="provenance">{provenance}</div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ helpers */

function formatRaw(v: number): string {
  const a = Math.abs(v);
  if (a >= 100000) return Math.round(v).toLocaleString();
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return v.toFixed(1);
  return v.toFixed(3);
}

function shortArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  return Object.entries(args as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("/") : String(v)}`)
    .join(", ");
}

function firstCodeIn(calls: { args: unknown; result: unknown }[]): string | null {
  for (const c of calls) {
    const args = c.args as Record<string, unknown> | null;
    if (args && typeof args.code === "string") return args.code.toUpperCase();
    if (args && Array.isArray(args.codes) && typeof args.codes[0] === "string")
      return (args.codes[0] as string).toUpperCase();
    const result = c.result as { results?: { code?: string }[] } | null;
    if (result?.results?.[0]?.code) return result.results[0].code!;
  }
  return null;
}

function say(markdown: string) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  // Strip tables and markup: a screen reader of a pipe table is unlistenable.
  const plain = markdown
    .split("\n")
    .filter((l) => !l.trim().startsWith("|"))
    .join(" ")
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 700);
  const u = new SpeechSynthesisUtterance(plain);
  u.rate = 1.05;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

/** Minimal shape of the Web Speech API, which TypeScript's DOM lib omits. */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  start(): void;
  onresult: (e: { results: { [i: number]: { [j: number]: { transcript: string } } } }) => void;
  onend: () => void;
  onerror: () => void;
}
