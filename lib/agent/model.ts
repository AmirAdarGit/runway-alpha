/**
 * Provider selection.
 *
 * The assignment allows any model provider, so the app takes whichever
 * credential is present in the environment rather than hard-wiring one vendor.
 * Each SDK reads its own environment variable itself, so nothing is passed
 * through this file. With no provider configured at all, the chat route falls
 * back to the deterministic answerer — same tools, no model — which is what
 * keeps the demo alive on a bad conference connection.
 */
import { groq } from "@ai-sdk/groq";
import { google } from "@ai-sdk/google";
import { anthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

export interface ModelChoice {
  model: LanguageModel;
  label: string;
}

export function selectModel(): ModelChoice | null {
  if (process.env.GROQ_API_KEY) {
    const id = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
    return { model: groq(id), label: `Groq ${id}` };
  }
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    const id = process.env.GOOGLE_MODEL ?? "gemini-2.0-flash";
    return { model: google(id), label: `Google ${id}` };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const id = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
    return { model: anthropic(id), label: `Anthropic ${id}` };
  }
  return null;
}

/** Shown in the UI so the interviewer can see which brain is answering. */
export function modelLabel(): string {
  return selectModel()?.label ?? "deterministic fallback (no model configured)";
}
