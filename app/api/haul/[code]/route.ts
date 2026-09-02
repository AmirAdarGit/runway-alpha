import { NextResponse } from "next/server";
import { haulMix } from "@/lib/tools";

/** GET /api/haul/ANC */

export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const result = haulMix(code);
  return NextResponse.json(result, { status: "error" in result ? 404 : 200 });
}
