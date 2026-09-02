import { answerDeterministically } from "../../lib/agent/deterministic";

const questions = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "Which airports in New England are strong candidates for terminal expansion?",
      "Compare LA and Santa Ana airport congestion levels.",
      "What is the percentage of long haul flights out of Anchorage airport?",
      "What is the unmet flight demand in SFO airport and why?",
    ];

for (const q of questions) {
  console.log("\n" + "=".repeat(78) + `\nQ: ${q}\n` + "=".repeat(78));
  const a = answerDeterministically(q);
  console.log(a.text);
  console.log(`\n[tools: ${a.toolCalls.map((t) => t.tool).join(", ") || "none"}]`);
}
