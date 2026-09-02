import { NextResponse } from "next/server";
import { airportProfile } from "@/lib/tools";

/** GET /api/airport/SFO */

export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const result = airportProfile(code);
  return NextResponse.json(result, { status: "error" in result ? 404 : 200 });
}
