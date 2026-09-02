import { NextResponse } from "next/server";

/**
 * Which models the configured provider actually offers this account.
 *
 * Provider model catalogues churn — an id that worked last quarter returns
 * "does not exist or you do not have access to it" today. This endpoint asks
 * the provider rather than guessing, and never returns the credential itself.
 */
export async function GET() {
  const providers: { name: string; url: string; header: Record<string, string> }[] = [];

  if (process.env.GROQ_API_KEY) {
    providers.push({
      name: "groq",
      url: "https://api.groq.com/openai/v1/models",
      header: { authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    });
  }
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    providers.push({
      name: "google",
      url: `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GOOGLE_GENERATIVE_AI_API_KEY}`,
      header: {},
    });
  }

  if (providers.length === 0) {
    return NextResponse.json({ configured: false, note: "No provider credential present." });
  }

  const out: Record<string, unknown> = { configured: true };
  for (const p of providers) {
    try {
      const res = await fetch(p.url, {
        headers: p.header,
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json()) as {
        data?: { id: string }[];
        models?: { name: string }[];
        error?: unknown;
      };
      out[p.name] = res.ok
        ? (body.data?.map((m) => m.id) ?? body.models?.map((m) => m.name) ?? body)
        : { status: res.status, error: body.error ?? body };
    } catch (e) {
      out[p.name] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return NextResponse.json(out);
}
