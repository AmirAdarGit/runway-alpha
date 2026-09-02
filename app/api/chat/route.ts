import { NextRequest, NextResponse } from "next/server";
import { generateText, stepCountIs } from "ai";
import { answerDeterministically } from "@/lib/agent/deterministic";
import { selectModel } from "@/lib/agent/model";
import { systemPrompt } from "@/lib/agent/prompt";
import { agentTools } from "@/lib/agent/tools-ai";
import { verifyNumbers } from "@/lib/agent/verify";

export const maxDuration = 60;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  text: string;
  /** Every tool call behind the answer — this is what the evidence panel renders. */
  toolCalls: { tool: string; args: unknown; result: unknown }[];
  mode: "model" | "deterministic";
  model: string;
  /** Numbers in the answer that were not found in any tool result. */
  numberCheck: { checked: number; unverified: string[] };
  elapsedMs: number;
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  const body = (await req.json()) as { messages?: ChatMessage[]; force?: "deterministic" };
  const messages = body.messages ?? [];
  const question = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  if (!question.trim()) {
    return NextResponse.json({ error: "No question supplied." }, { status: 400 });
  }

  const choice = body.force === "deterministic" ? null : selectModel();

  // No provider configured, or the caller asked for the control path: answer
  // from rules over the same tools. Always available, never hallucinates.
  if (!choice) {
    const a = answerDeterministically(question, messages.slice(0, -1));
    const payload: ChatResponse = {
      text: a.text,
      toolCalls: a.toolCalls,
      mode: "deterministic",
      model: body.force === "deterministic" ? "deterministic (forced)" : "deterministic (no model configured)",
      numberCheck: verifyNumbers(a.text, a.toolCalls.map((t) => t.result), question),
      elapsedMs: Date.now() - started,
    };
    return NextResponse.json(payload);
  }

  try {
    const result = await generateText({
      model: choice.model,
      system: systemPrompt(),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      tools: agentTools,
      stopWhen: stepCountIs(6),
      temperature: 0.2,
    });

    const toolCalls = result.steps.flatMap((step) =>
      step.toolCalls.map((call, i) => ({
        tool: call.toolName,
        args: call.input,
        result: step.toolResults[i]?.output ?? null,
      })),
    );

    // A model that answered without calling a tool has, by definition, made the
    // numbers up. Fall back rather than serve it.
    if (toolCalls.length === 0 && /\d/.test(result.text)) {
      const a = answerDeterministically(question, messages.slice(0, -1));
      const payload: ChatResponse = {
        text: `${a.text}\n\n*The model answered without consulting the data, so this reply came from the deterministic path instead.*`,
        toolCalls: a.toolCalls,
        mode: "deterministic",
        model: `${choice.label} (rejected: no tool call)`,
        numberCheck: verifyNumbers(a.text, a.toolCalls.map((t) => t.result), question),
        elapsedMs: Date.now() - started,
      };
      return NextResponse.json(payload);
    }

    const payload: ChatResponse = {
      text: result.text,
      toolCalls,
      mode: "model",
      model: choice.label,
      numberCheck: verifyNumbers(result.text, toolCalls.map((t) => t.result), question),
      elapsedMs: Date.now() - started,
    };
    return NextResponse.json(payload);
  } catch (e) {
    // Provider outage, rate limit, bad key: the demo continues on rules.
    const a = answerDeterministically(question, messages.slice(0, -1));
    const payload: ChatResponse = {
      text: `${a.text}\n\n*Model unavailable (${e instanceof Error ? e.message : String(e)}); answered from the deterministic path.*`,
      toolCalls: a.toolCalls,
      mode: "deterministic",
      model: `${choice.label} (unavailable)`,
      numberCheck: verifyNumbers(a.text, a.toolCalls.map((t) => t.result), question),
      elapsedMs: Date.now() - started,
    };
    return NextResponse.json(payload);
  }
}
