import { z } from "zod";

import { so } from "superobjective";

export const lookupOrder = so.tool({
  name: "lookup_order",
  description: so.text({
    value: "Look up an order by order ID or customer email.",
    optimize: true,
  }),
  input: z.object({
    orderId: z.string().optional(),
    email: z.string().email().optional(),
  }),
  output: z.object({
    found: z.boolean(),
    reference: z.string(),
    status: z.string(),
  }),
  async execute(input, ctx) {
    ctx.log(`lookup_order called with ${JSON.stringify(input)}`);

    const reference = input.orderId ?? input.email ?? "unresolved-order-reference";

    return {
      found: Boolean(input.orderId ?? input.email),
      reference,
      status: "manual-review",
    };
  },
});
