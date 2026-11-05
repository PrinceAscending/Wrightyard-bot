import "../dist/env.js";
import { AIService } from "../dist/services/ai.js";
import { Logger } from "../dist/logger.js";

const ai = new AIService(
  { apiKey: process.env.GROQ_API_KEY ?? null, model: process.env.GROQ_MODEL },
  new Logger("ai-smoke"),
);

if (!ai.enabled) {
  console.error("GROQ_API_KEY is not set.");
  process.exit(1);
}

console.log("model:", ai.modelName);
console.log("\n--- ask ---");
console.log(await ai.ask("What does Wrightyard build, and how does a project start?"));

console.log("\n--- brief ---");
console.log(
  await ai.brief(
    "I run a 5,000 member gaming Discord and need a bot that handles tickets, moderation, and onboarding. I would also like a small website for the community.",
  ),
);
