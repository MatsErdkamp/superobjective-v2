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
  }, 15000);

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
  }, 30000);
});
