import { NextResponse } from "next/server";
import { explainScore } from "@/lib/tools";
import type { ComponentKey } from "@/lib/scoring/types";

/** GET /api/explain/SFO?component=unmet */

export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const component = new URL(req.url).searchParams.get("component") as ComponentKey | null;
  const result = explainScore(code, component ?? undefined);
  return NextResponse.json(result, { status: "error" in result ? 404 : 200 });
}
