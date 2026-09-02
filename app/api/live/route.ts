import { NextRequest, NextResponse } from "next/server";
import { liveStatus } from "@/lib/tools";

/** GET /api/live?codes=SFO,LAX — live FAA ground stops and delay programmes. */
export async function GET(req: NextRequest) {
  const codes = req.nextUrl.searchParams.get("codes")?.split(",").map((s) => s.trim()) ?? [];
  return NextResponse.json(await liveStatus(codes));
}
