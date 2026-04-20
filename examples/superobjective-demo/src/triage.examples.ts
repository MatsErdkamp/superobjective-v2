import type { Example } from "superobjective";

import type { TriageInput, TriageOutput } from "./triage";

export const trainset: Example<TriageInput, TriageOutput>[] = [
  {
    id: "billing-refund",
    input: {
      subject: "Refund still missing",
      body: "I returned the order two weeks ago and the refund still has not arrived.",
    },
    expected: {
      category: "billing",
      priority: "high",
      needsHuman: true,
    },
  },
  {
    id: "technical-login",
    input: {
      subject: "Cannot log in",
      body: "The app keeps rejecting my password after the latest update.",
    },
    expected: {
      category: "technical",
      priority: "high",
      needsHuman: true,
    },
  },
  {
    id: "account-permissions",
    input: {
      subject: "Need teammate access restored",
      body: "My admin access disappeared after our account owner changed billing details.",
    },
    expected: {
      category: "account",
      priority: "medium",
      needsHuman: true,
    },
  },
  {
    id: "other-status",
    input: {
      subject: "When will my order ship?",
      body: "I just want an update on the current shipping status for order 1842.",
    },
    expected: {
      category: "other",
      priority: "low",
      needsHuman: false,
    },
  },
];
