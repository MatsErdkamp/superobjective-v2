import { z } from "zod";

import { so } from "superobjective";

import { triageTicket } from "./triage";

export const supportFlow = so.program({
  name: "support_flow",
  input: z.object({
    subject: z.string(),
    body: z.string(),
  }),
  output: z.object({
    triage: z.object({
      category: z.enum(["billing", "technical", "account", "other"]),
      priority: z.enum(["low", "medium", "high"]),
      needsHuman: z.boolean(),
    }),
    escalated: z.boolean(),
    response: z.string(),
  }),
  async run(ctx, input) {
    const triage = await ctx.call(triageTicket, input);

    if (triage.needsHuman) {
      return {
        triage,
        escalated: true,
        response:
          "A human support agent should take over this ticket based on the current classification.",
      };
    }

    return {
      triage,
      escalated: false,
      response: `Route this ticket to the ${triage.category} queue with ${triage.priority} priority.`,
    };
  },
});
