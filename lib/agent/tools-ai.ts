/**
 * The tool surface handed to the model.
 *
 * Thin wrappers only: schema, description, and a call into lib/tools. No
 * arithmetic happens here, which is the point — the model chooses the tool and
 * the arguments, and nothing else.
 */
import { tool } from "ai";
import { z } from "zod";
import {
  airportProfile,
  compareAirports,
  datasetInfo,
  explainScore,
  haulMix,
  liveStatus,
  rankAirports,
} from "../tools";
import { REGIONS, METROS } from "../regions";
import type { ComponentKey } from "../scoring/types";

const regionKeys = REGIONS.map((r) => r.key);
const metroKeys = METROS.map((m) => m.key);

export const agentTools = {
  rankAirports: tool({
    description:
      `Rank airports by Renovation Upside Score within a scope. Use for "which airports in X are candidates", ` +
      `"best opportunities", shortlists. Scope by region (${regionKeys.join(", ")}), metro (${metroKeys.join(", ")}), ` +
      `states, or explicit codes. Scores are normalised within FAA hub class.`,
    inputSchema: z.object({
      region: z.enum(regionKeys as [string, ...string[]]).optional(),
      metro: z.enum(metroKeys as [string, ...string[]]).optional(),
      states: z.array(z.string().length(2)).optional().describe("Two-letter state codes"),
      codes: z.array(z.string().length(3)).optional().describe("IATA airport codes"),
      hubClasses: z.array(z.enum(["L", "M", "S", "N"])).optional(),
      includeSmall: z
        .boolean()
        .optional()
        .describe("Include airports below 100,000 annual enplanements"),
      limit: z.number().int().min(1).max(25).default(5),
    }),
    execute: async ({ limit, ...filters }) => rankAirports(filters, {}, limit),
  }),

  compareAirports: tool({
    description:
      "Compare two or three airports head to head. Pick a focus that matches the question: " +
      "congestion for delay and taxi-out, capacity for runways and utilisation, growth for enplanement trend, " +
      "demand for spill signals, overall for the score breakdown.",
    inputSchema: z.object({
      codes: z.array(z.string().length(3)).min(2).max(3),
      focus: z.enum(["overall", "congestion", "capacity", "growth", "demand"]).default("overall"),
    }),
    execute: async ({ codes, focus }) => compareAirports(codes, focus),
  }),

  airportProfile: tool({
    description:
      "Everything measured for one airport: score, rank within hub class, physical plant, traffic, " +
      "delay performance, carrier mix, catchment. Use when the user asks about a single airport generally.",
    inputSchema: z.object({ code: z.string().length(3) }),
    execute: async ({ code }) => airportProfile(code),
  }),

  haulMix: tool({
    description:
      "Distance mix of an airport's departures — short, medium and long haul shares, average stage length. " +
      "Use for any question about flight distances or long-haul percentage. Domestic flights only.",
    inputSchema: z.object({ code: z.string().length(3) }),
    execute: async ({ code }) => haulMix(code),
  }),

  explainScore: tool({
    description:
      "Why an airport scores the way it does: each component, each raw input, the peer median, and how much " +
      "each contributed. Use for 'why', 'explain', 'what drives', and for unmet-demand questions.",
    inputSchema: z.object({
      code: z.string().length(3),
      component: z
        .enum(["congestion", "headroom", "momentum", "unmet", "risk"])
        .optional()
        .describe("Omit to explain all five components"),
    }),
    execute: async ({ code, component }) =>
      explainScore(code, component as ComponentKey | undefined),
  }),

  liveStatus: tool({
    description:
      "Live FAA ground stops and ground delay programmes right now. Use only when the user asks about " +
      "current or today's conditions — the scoring data is historical.",
    inputSchema: z.object({ codes: z.array(z.string().length(3)).min(1).max(6) }),
    execute: async ({ codes }) => liveStatus(codes),
  }),

  datasetInfo: tool({
    description:
      "What data the agent has, its window, its size, and its documented limits. Use when asked about " +
      "coverage, sources, freshness, or what the agent cannot do.",
    inputSchema: z.object({}),
    execute: async () => datasetInfo(),
  }),
};
