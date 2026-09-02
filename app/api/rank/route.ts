import { NextRequest, NextResponse } from "next/server";
import { rankAirports, type RankFilters } from "@/lib/tools";
import type { Weights } from "@/lib/scoring/types";

/**
 * GET /api/rank?region=new_england&limit=5
 *
 * The same function the chat agent calls, exposed directly so any answer can
 * be verified with no model in the path. Weights can be overridden per request
 * (w_congestion, w_headroom, w_momentum, w_unmet, w_risk).
 */

export function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const list = (k: string) => p.get(k)?.split(",").map((s) => s.trim()).filter(Boolean);

  const filters: RankFilters = {
    region: p.get("region") ?? undefined,
    metro: p.get("metro") ?? undefined,
    states: list("states"),
    codes: list("codes"),
    hubClasses: list("hub") as RankFilters["hubClasses"],
    minEnplanements: p.get("minEnplanements") ? Number(p.get("minEnplanements")) : undefined,
    includeSmall: p.get("includeSmall") === "true",
  };

  const weights: Partial<Weights> = {};
  for (const k of ["congestion", "headroom", "momentum", "unmet", "risk"] as const) {
    const v = p.get(`w_${k}`);
    if (v !== null && Number.isFinite(Number(v))) weights[k] = Number(v);
  }

  return NextResponse.json(
    rankAirports(
      filters,
      { weights: Object.keys(weights).length ? weights : undefined, crossClass: p.get("crossClass") === "true" },
      Number(p.get("limit") ?? 10),
    ),
  );
}
