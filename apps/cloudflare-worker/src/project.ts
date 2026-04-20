import { so } from "superobjective";

import { supportFlow } from "./support-flow";
import {
  checkEligibility,
  fetchData,
  sendEmail,
  traceProbeFlow,
  traceProbeIntake,
  traceProbeResolution,
  traceProbeRisk,
} from "./trace-probe";
import { triageTicket } from "./triage";
import { lookupOrder } from "./tools";

export const supportAgent = so.agent({
  name: "support",
  system: so.text({
    value: "You are a precise and concise support assistant.",
    optimize: true,
  }),
  chat: supportFlow,
  tools: [triageTicket, lookupOrder],
});

export const traceProbeAgent = so.agent({
  name: "trace_probe",
  system: so.text({
    value:
      "You are a tracing harness that deliberately executes three predict stages so the dashboard can inspect a multi-model run.",
    optimize: true,
  }),
  chat: traceProbeFlow,
  tools: [
    traceProbeIntake,
    traceProbeRisk,
    traceProbeResolution,
    fetchData,
    checkEligibility,
    sendEmail,
  ],
});

export const supportRpc = so.rpc({
  name: "support_rpc",
  handlers: {
    triageTicket,
    supportFlow,
  },
});

export const traceProbeRpc = so.rpc({
  name: "trace_probe_rpc",
  handlers: {
    traceProbeFlow,
  },
});

export const supportMcp = so.mcp({
  name: "support_tools",
  tools: [triageTicket, lookupOrder],
});

export const project = so.project({
  programs: [
    triageTicket,
    supportFlow,
    traceProbeIntake,
    traceProbeRisk,
    traceProbeResolution,
    traceProbeFlow,
  ],
  agents: [supportAgent, traceProbeAgent],
  rpc: [supportRpc, traceProbeRpc],
  mcp: [supportMcp],
});
