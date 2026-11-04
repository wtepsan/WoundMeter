import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    { code: "STUDIO_DISABLED", message: "Use the authorised patient wound update workflow." },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}
