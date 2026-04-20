import { z } from "zod";

import { so } from "superobjective";

export const TriageTicket = so
  .signature("triage_ticket")
  .withInstructions("Classify a support ticket for routing and escalation.", {
    optimize: true,
  })
  .withInput("subject", z.string(), {
    description: "The support ticket subject line.",
    optimize: true,
  })
  .withInput("body", z.string(), {
    description: "The customer-written support request body.",
    optimize: true,
  })
  .withOutput("category", z.enum(["billing", "technical", "account", "other"]), {
    description: "The queue that should own the ticket.",
    optimize: true,
  })
  .withOutput("priority", z.enum(["low", "medium", "high"]), {
    description: "Urgency based on impact, revenue risk, and time sensitivity.",
    optimize: true,
  })
  .withOutput("needsHuman", z.boolean(), {
    description: "Whether a human support agent should take over.",
    optimize: true,
  })
  .build();

export type TriageInput = {
  subject: string;
  body: string;
};

export type TriageOutput = {
  category: "billing" | "technical" | "account" | "other";
  priority: "low" | "medium" | "high";
  needsHuman: boolean;
};

export const triageTicket = so.predict<TriageInput, TriageOutput>(TriageTicket, {
  adapter: so.adapters.xml(),
});
