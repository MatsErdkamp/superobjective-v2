import { z } from "zod";

import { so } from "superobjective";

export const TriageTicket = so.signature({
  name: "triage_ticket",
  instructions: so.text({
    value: "Classify a support ticket for routing and escalation.",
    optimize: true,
  }),
  input: {
    subject: so.input(z.string(), {
      description: so.text({
        value: "The support ticket subject line.",
        optimize: true,
      }),
    }),
    body: so.input(z.string(), {
      description: so.text({
        value: "The customer-written support request body.",
        optimize: true,
      }),
    }),
  },
  output: {
    category: so.output(z.enum(["billing", "technical", "account", "other"]), {
      description: so.text({
        value: "The queue that should own the ticket.",
        optimize: true,
      }),
    }),
    priority: so.output(z.enum(["low", "medium", "high"]), {
      description: so.text({
        value: "Urgency based on impact, revenue risk, and time sensitivity.",
        optimize: true,
      }),
    }),
    needsHuman: so.output(z.boolean(), {
      description: so.text({
        value: "Whether a human support agent should take over.",
        optimize: true,
      }),
    }),
  },
});

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
