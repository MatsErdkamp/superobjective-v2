import { describe, expect, it } from "vite-plus/test";

const liveBaseUrl = process.env.SUPEROBJECTIVE_LIVE_BASE_URL;

describe.skipIf(!liveBaseUrl)("cloudflare live deployment", () => {
  it("runs triage against a real Workers AI-backed deployment", async () => {
    const response = await fetch(`${liveBaseUrl}/rpc/support_rpc/triageTicket`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        subject: "Refund not received",
        body: "I returned my order two weeks ago and still have not received the refund. Please route this to whoever handles refunds and charges.",
      }),
    });

    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      data: {
        category: string;
        priority: string;
        needsHuman: boolean;
      };
      traceId: string;
    };

    expect(payload.ok).toBe(true);
    expect(payload.data.category).toBe("billing");
    expect(["low", "medium", "high"]).toContain(payload.data.priority);
    expect(typeof payload.data.needsHuman).toBe("boolean");
    expect(typeof payload.traceId).toBe("string");
    expect(payload.traceId.length).toBeGreaterThan(0);
  }, 30000);

  it("runs the live app host lifecycle against the deployed worker", async () => {
    const appId = `live-app-${Date.now().toString(36)}`;

    try {
      const createResponse = await fetch(
        `${liveBaseUrl}/dashboard/apps/${encodeURIComponent(appId)}/create`,
        {
          method: "POST",
        },
      );

      expect(createResponse.status).toBe(200);
      const created = (await createResponse.json()) as {
        ok: boolean;
        app: {
          id: string;
          counts: {
            receipts: number;
            emails: number;
            jobs: number;
            traces: number;
          };
        };
      };

      expect(created.ok).toBe(true);
      expect(created.app.id).toBe(appId);
      expect(created.app.counts.receipts).toBe(0);
      expect(created.app.counts.emails).toBe(0);

      const exerciseResponse = await fetch(
        `${liveBaseUrl}/dashboard/apps/${encodeURIComponent(appId)}/exercise`,
        {
          method: "POST",
        },
      );

      expect(exerciseResponse.status).toBe(200);
      const exercised = (await exerciseResponse.json()) as {
        ok: boolean;
        jobs: Array<{ jobId: string }>;
        searchResults: Array<{ id: string; score: number }>;
        summary: {
          id: string;
          counts: {
            receipts: number;
            emails: number;
            jobs: number;
            traces: number;
          };
          jobs: Array<{
            key: string;
            value: {
              status: string;
              category: string;
              queue: string;
            };
          }>;
        };
      };

      expect(exercised.ok).toBe(true);
      expect(exercised.jobs).toHaveLength(2);
      expect(exercised.summary.counts.receipts).toBe(2);
      expect(exercised.summary.counts.emails).toBe(2);
      expect(exercised.summary.counts.jobs).toBe(2);
      expect(exercised.summary.counts.traces).toBe(2);
      expect(exercised.searchResults.length).toBeGreaterThan(0);
      expect(exercised.summary.jobs[0]?.value.status).toBe("completed");

      const getResponse = await fetch(`${liveBaseUrl}/dashboard/apps/${encodeURIComponent(appId)}`);

      expect(getResponse.status).toBe(200);
      const loaded = (await getResponse.json()) as {
        ok: boolean;
        app: {
          counts: {
            receipts: number;
            emails: number;
            jobs: number;
            traces: number;
          };
        };
      };

      expect(loaded.ok).toBe(true);
      expect(loaded.app.counts.receipts).toBe(2);
      expect(loaded.app.counts.emails).toBe(2);

      const deleteResponse = await fetch(
        `${liveBaseUrl}/dashboard/apps/${encodeURIComponent(appId)}`,
        {
          method: "DELETE",
        },
      );

      expect(deleteResponse.status).toBe(200);
      const deleted = (await deleteResponse.json()) as {
        ok: boolean;
        destroyed: string;
      };

      expect(deleted.ok).toBe(true);
      expect(deleted.destroyed).toBe(appId);

      const missingResponse = await fetch(
        `${liveBaseUrl}/dashboard/apps/${encodeURIComponent(appId)}`,
      );

      expect(missingResponse.status).toBe(404);
    } finally {
      await fetch(`${liveBaseUrl}/dashboard/apps/${encodeURIComponent(appId)}`, {
        method: "DELETE",
      }).catch(() => undefined);
    }
  }, 60000);

  it("runs the live RLM kernel route and persists the trajectory", async () => {
    const dossier = [
      "Investigation dossier:",
      ...Array.from({ length: 320 }, (_, index) => `Filler paragraph ${index + 1}.`),
      "LAUNCH_CODE=ORBIT-9",
      "Use the launch code only after verification.",
    ].join("\n");

    const response = await fetch(`${liveBaseUrl}/kernel/rlm/inspect_launch_dossier`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: {
          question: "What is the launch code?",
          dossier,
        },
      }),
    });

    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      output: {
        answer: string;
        evidence: string;
      };
      traceId: string;
    };

    expect(payload.ok).toBe(true);
    expect(payload.output.answer).toBe("ORBIT-9");
    expect(payload.output.evidence).toContain("LAUNCH_CODE=ORBIT-9");
    expect(typeof payload.traceId).toBe("string");
    expect(payload.traceId.length).toBeGreaterThan(0);

    const traceResponse = await fetch(
      `${liveBaseUrl}/kernel/traces/${encodeURIComponent(payload.traceId)}`,
    );

    expect(traceResponse.status).toBe(200);

    const tracePayload = (await traceResponse.json()) as {
      ok: boolean;
      trace: {
        targetId: string;
        targetKind: string;
        metadata?: {
          rlmSession?: {
            kind?: string;
            resumed?: boolean;
          };
        };
        programmable?: {
          mode: string;
          steps: Array<{
            index: number;
            code: string;
            error?: {
              message?: string;
            };
          }>;
        };
        modelCalls: Array<{
          provider: string;
          model: string;
        }>;
      };
    };

    expect(tracePayload.ok).toBe(true);
    expect(tracePayload.trace.targetId).toBe("inspect_launch_dossier");
    expect(tracePayload.trace.targetKind).toBe("rlm");
    expect(tracePayload.trace.programmable?.mode).toBe("rlm");
    expect(tracePayload.trace.metadata?.rlmSession?.kind).toBe("cloudflare-hosted-facet");

    const steps = tracePayload.trace.programmable?.steps ?? [];
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps.map((step) => step.index)).toEqual(
      Array.from({ length: steps.length }, (_, index) => index + 1),
    );
    expect(steps.some((step) => step.code.includes("listResources"))).toBe(true);
    expect(steps.some((step) => step.code.includes("searchText"))).toBe(true);
    expect(
      steps.every(
        (step) =>
          !((step.error?.message ?? "").includes("already been declared") ||
            (step.error?.message ?? "").includes("Identifier")),
      ),
    ).toBe(true);
    expect(tracePayload.trace.modelCalls.length).toBeGreaterThan(0);
    expect(
      tracePayload.trace.modelCalls.some(
        (modelCall) =>
          modelCall.provider === "cloudflare-workers-ai" &&
          modelCall.model.includes("gemma-4-26b-a4b-it"),
      ),
    ).toBe(true);
  }, 120000);
});
