/**
 * Post-hoc number check.
 *
 * The system prompt forbids stating a figure that is not in a tool result.
 * This verifies that claim instead of trusting it: every number in the answer
 * is looked for in the tool payloads, and anything unaccounted for is reported
 * to the UI. It is a smoke alarm, not a proof — but an answer that trips it is
 * one an analyst should not act on.
 */
export interface NumberCheck {
  checked: number;
  unverified: string[];
}

/** Numbers too common or too structural to be worth checking. */
function isIgnorable(token: string, value: number): boolean {
  if (!Number.isFinite(value)) return true;
  // Years, list indices, small counts, and the weights quoted from the prompt.
  if (/^(19|20)\d{2}$/.test(token)) return true;
  if (Number.isInteger(value) && Math.abs(value) <= 12) return true;
  if ([0.3, 0.25, 0.2, 0.15, 0.1, 0.35, 0.5, 0.6, 0.4].includes(value)) return true;
  return false;
}

export function verifyNumbers(text: string, toolResults: unknown[], question = ""): NumberCheck {
  // Dates are not claims. "2024-12-31" would otherwise report 12 and 31 as
  // figures the tools never returned.
  text = text.replace(/\d{4}[-‑/]\d{1,2}[-‑/]\d{1,2}/g, " ");
  // Models group thousands with spaces as often as commas ("376 456",
  // "376\u202f456"). Without this, one figure reads as two invented ones.
  text = text.replace(/(\d)[\u00a0\u202f\u2009 ](?=\d{3}\b)/g, "$1,");
  const haystack = JSON.stringify(toolResults);
  // Every number the tools returned, at full precision and rounded, so that a
  // model quoting "18.7" against a stored 18.7231 still verifies.
  const known = new Set<string>();
  for (const m of haystack.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const v = Number(m[0]);
    if (!Number.isFinite(v)) continue;
    known.add(String(v));
    known.add(v.toFixed(0));
    known.add(v.toFixed(1));
    known.add(v.toFixed(2));
    // Percentages are often reported as the share times 100, and vice versa.
    known.add((v * 100).toFixed(1));
    known.add((v * 100).toFixed(0));
    known.add((v / 100).toFixed(2));
    known.add((v / 100).toFixed(3));
  }

  const fromQuestion = new Set(
    [...question.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => String(Number(m[0]))),
  );

  const unverified: string[] = [];
  let checked = 0;

  for (const m of text.matchAll(/-?\d[\d,\u00a0\u202f]*(?:\.\d+)?/g)) {
    const token = m[0];
    const value = Number(token.replace(/[,\u00a0\u202f]/g, ""));
    if (isIgnorable(token, value)) continue;
    if (fromQuestion.has(String(value))) continue;
    checked++;
    const candidates = [
      String(value),
      value.toFixed(0),
      value.toFixed(1),
      value.toFixed(2),
    ];
    if (!candidates.some((c) => known.has(c))) unverified.push(token);
  }

  return { checked, unverified: [...new Set(unverified)] };
}
