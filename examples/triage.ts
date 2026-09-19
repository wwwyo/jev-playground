import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient();

const state = {
  ticket: {
    subject: "Charged twice for my subscription renewal",
    body: "This is the second time this has happened. I was charged twice for my Pro plan renewal on the 12th and now I'm locked out of the dashboard too. I need this fixed today or I'm cancelling.",
    plan: "Pro",
  },
};

const angerLevels = [
  "Calm and neutral; no frustration expressed.",
  "Mildly annoyed but polite; states the problem without complaint.",
  "Frustrated; explicit complaint or a repeated issue mentioned.",
  "Furious; threatens to cancel, demands escalation, or uses charged language.",
] as const;

const { model, answers, usage } = await client.systemOne({
  state,
  questions: {
    urgent: noul("Does `ticket.body` show the customer needs a same-day response?", {
      true: "States a deadline, threatens to cancel, or is blocked from using the product.",
      false: "Can reasonably wait for a normal-priority response.",
    }),
    category: choice("Classify the ticket's primary topic from `ticket.subject` and `ticket.body`.", {
      billing: "Charges, invoices, refunds, or subscription payments.",
      bug: "Something in the product is broken or behaving incorrectly.",
      feature_request: "The customer is asking for new or changed functionality.",
      other: "Doesn't fit any of the above.",
    }),
    anger: score("Rate how angry the customer sounds in `ticket.subject` and `ticket.body`.", angerLevels),
  },
});

console.log(`model: ${model}\n`);

console.log("urgent (noul)");
console.log(`  yes: ${answers.urgent.noul.toFixed(3)}`);
console.log(`  no:  ${(1 - answers.urgent.noul).toFixed(3)}\n`);

console.log("category (choice)");
console.log(`  choice:     ${answers.category.choice}`);
console.log(`  confidence: ${answers.category.confidence.toFixed(3)}`);
for (const [label, probability] of Object.entries(answers.category.probabilities)) {
  console.log(`  ${label}: ${probability.toFixed(3)}`);
}
console.log();

console.log("anger (score)");
console.log(`  score:      ${answers.anger.score.toFixed(3)}`);
console.log(`  confidence: ${answers.anger.confidence.toFixed(3)}`);
for (const [level, description] of Object.entries(answers.anger.legend)) {
  console.log(`  [${level}] ${description}`);
}
for (const [level, probability] of Object.entries(answers.anger.probabilities)) {
  console.log(`  [${level}] probability: ${probability.toFixed(3)}`);
}
console.log();

const costPerMillionInputTokens = 0.042;
const estimatedCost = (usage.input_tokens / 1_000_000) * costPerMillionInputTokens;
console.log(`usage: input_tokens=${usage.input_tokens} output_tokens=${usage.output_tokens}`);
console.log(`estimated cost: $${estimatedCost.toFixed(6)}`);
