import { NextRequest, NextResponse } from "next/server";
import { compareAirports, type CompareFocus } from "@/lib/tools";

/** GET /api/compare?codes=LAX,SNA&focus=congestion */

export function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const codes = p.get("codes")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  if (codes.length < 2) {
    return NextResponse.json(
      { error: "Pass at least two airport codes, e.g. /api/compare?codes=LAX,SNA" },
      { status: 400 },
    );
  }
  return NextResponse.json(
    compareAirports(codes, (p.get("focus") as CompareFocus) ?? "overall"),
  );
}
