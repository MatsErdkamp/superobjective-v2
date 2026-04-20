import { so } from "superobjective";
import { triageTicket } from "../examples/superobjective-demo/src/triage";
import { trainset } from "../examples/superobjective-demo/src/triage.examples";
import { triageQuality } from "../examples/superobjective-demo/src/triage.metric";

const compiled = await so.compile(triageTicket, {
  optimizer: so.optimizers.gepa({
    maxMetricCalls: 120,
    reflectionBatchSize: 3,
    skipPerfectScores: true,
    candidateSelection: "pareto",
  }),
  trainset,
  metric: triageQuality,
  objective: "Improve support ticket triage accuracy.",
  background: `
Billing includes refunds, charges, invoices, subscriptions, and failed payments.
Technical includes product defects, login failures, API issues, and integrations.
Account includes permissions, identity, account status, and profile changes.
  `,
});

await so.stores.filesystem(".superobjective/artifacts").saveArtifact(compiled);

console.log(JSON.stringify(compiled, null, 2));
