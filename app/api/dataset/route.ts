import { NextResponse } from "next/server";
import { datasetInfo } from "@/lib/tools";

/** GET /api/dataset — what the agent knows, and from when. */

export function GET() {
  return NextResponse.json(datasetInfo());
}
