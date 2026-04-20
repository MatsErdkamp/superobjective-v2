import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { cloudflare } from "@superobjective/cloudflare";
import { superobjective } from "superobjective";

import { mockModel } from "./support/mock-model";

type JobState = {
  status: "running" | "completed";
  ordinal?: number;
  traceId?: string;
  category?: "billing" | "general";
  queue?: "billing" | "general";
};

type JobStatePatch = Pick<JobState, "status"> & Partial<Omit<JobState, "status">>;

function mergeJobState(current: JobState | null, patch: JobStatePatch): JobState {
  if (current == null) {
    const { status, ...rest } = patch;
    return {
      status,
      ...rest,
    };
  }

  return {
    ...current,
    ...patch,
  };
}

function requiredSpace<T>(space: T | undefined, label: string): T {
  if (space == null) {
    throw new Error(`Missing storage space: ${label}`);
  }

  return space;
}

describe("superobjective app host", () => {
  it("creates, gets, and reuses shared storage spaces", async () => {
    const host = superobjective.init(cloudflare({}));

    const first = await host.create({
      id: "customer-support-shared",
      storage: {
        receipts: {
          search: "receipts-search",
        },
        emails: {
          search: "emails-search",
        },
      },
    });
    const firstReceipts = requiredSpace(first.storage.receipts, "first.storage.receipts");

    const created = await firstReceipts.put({
      id: "receipt_apr_2026",
      kind: "pdf",
      body: new Uint8Array([1, 2, 3]),
      contentType: "application/pdf",
      metadata: {
        vendor: "Stripe",
      },
      indexForSearch: true,
      searchableText: "Stripe April 2026 receipt",
    });

    const second = await host.get({
      id: "customer-support-shared",
    });
    const secondReceipts = requiredSpace(second.storage.receipts, "second.storage.receipts");

    const loaded = await secondReceipts.get(created.id);
    expect(loaded?.id).toBe(created.id);
    expect(loaded?.body).toBeInstanceOf(Uint8Array);

    const results = await secondReceipts.search({
      query: "stripe april",
    });
    expect(results[0]?.id).toBe(created.id);
    expect(second.storage.emails).toBeDefined();
  });

  it("merges partial create calls for the same app id without deleting undeclared spaces", async () => {
    const host = superobjective.init(cloudflare({}));

    await host.create({
      id: "customer-support-merge",
      storage: {
        receipts: {
          search: "receipts-search",
        },
        emails: {
          search: "emails-search",
        },
      },
    });

    const merged = await host.create({
      id: "customer-support-merge",
      storage: {
        receipts: {
          search: "receipts-search",
        },
      },
    });

    expect(merged.storage.receipts).toBeDefined();
    expect(merged.storage.emails).toBeDefined();
  });

  it("rejects conflicting resource declarations for the same app id", async () => {
    const host = superobjective.init(cloudflare({}));

    await host.create({
      id: "customer-support-conflict",
      storage: {
        receipts: {
          search: "receipts-search",
        },
      },
    });

    await expect(
      host.create({
        id: "customer-support-conflict",
        storage: {
          receipts: {
            search: "receipts-search-v2",
          },
        },
      }),
    ).rejects.toThrow(/different configuration/i);
  });

  it("stores internal state and traces on the app handle", async () => {
    const host = superobjective.init(cloudflare({}));

    const so = await host.create({
      id: "customer-support-state",
      storage: {
        receipts: {},
      },
    });

    await so.state.put("jobs", "job_123", {
      status: "running",
    });

    const job = await so.state.upsert<JobState>("jobs", "job_123", (current) =>
      mergeJobState(current, {
        status: "completed",
      }),
    );

    expect(job.status).toBe("completed");

    const trace = await so.state.startTrace({
      targetKind: "agent",
      targetId: "support",
      metadata: {
        caseId: "case_123",
      },
    });

    await so.state.appendTrace(trace.traceId, {
      type: "lookup.complete",
      payload: {
        resultCount: 2,
      },
    });

    await so.state.finishTrace(trace.traceId, {
      status: "ok",
    });

    const stored = await so.state.getTrace(trace.traceId);
    expect(stored?.events).toHaveLength(1);
    expect(stored?.summary?.status).toBe("ok");
  });

  it("destroys an app and tears down its managed resources", async () => {
    const host = superobjective.init(cloudflare({}));

    const so = await host.create({
      id: "customer-support-destroy",
      storage: {
        receipts: {
          search: "receipts-search",
        },
      },
    });
    const receipts = requiredSpace(so.storage.receipts, "so.storage.receipts");

    await receipts.put({
      id: "receipt_to_delete",
      kind: "pdf",
      body: "temporary",
      metadata: {
        vendor: "Delete Me",
      },
      searchableText: "temporary receipt",
      indexForSearch: true,
    });

    await so.destroy();

    await expect(
      host.get({
        id: "customer-support-destroy",
      }),
    ).rejects.toThrow(/was not found/i);
  });

  it("runs a real app lifecycle with predict modules twice", async () => {
    const host = superobjective.init(cloudflare({}));

    const classifyModel = mockModel(async (args) => {
      const prompt = args.messages.map((message) => message.content).join("\n");
      const isRefund = /refund|duplicate charge/i.test(prompt);
      return {
        category: isRefund ? "billing" : "general",
        needsHuman: /urgent|angry/i.test(prompt),
      };
    });

    const replyModel = mockModel(async (args) => {
      const prompt = args.messages.map((message) => message.content).join("\n");
      const isBilling = /billing/i.test(prompt);
      return {
        queue: isBilling ? "billing" : "general",
        response: isBilling
          ? "We routed this case to billing and recorded the receipt."
          : "We logged the case for the general support queue.",
      };
    });

    const classifyEmail = superobjective.predict<
      {
        subject: string;
        body: string;
      },
      {
        category: "billing" | "general";
        needsHuman: boolean;
      }
    >(
      superobjective
        .signature("classify_email")
        .withInstructions("Classify the incoming support email.", {
          optimize: true,
        })
        .withInput("subject", z.string(), {
          description: "The customer email subject.",
          optimize: true,
        })
        .withInput("body", z.string(), {
          description: "The customer email body.",
          optimize: true,
        })
        .withOutput("category", z.enum(["billing", "general"]), {
          description: "The target support queue.",
          optimize: true,
        })
        .withOutput("needsHuman", z.boolean(), {
          description: "Whether a human should review this case.",
          optimize: true,
        })
        .build(),
      {
        adapter: superobjective.adapters.xml(),
        model: classifyModel,
      },
    );

    const draftReply = superobjective.predict<
      {
        category: "billing" | "general";
        vendor: string;
        body: string;
      },
      {
        queue: "billing" | "general";
        response: string;
      }
    >(
      superobjective
        .signature("draft_reply")
        .withInstructions("Draft a short customer reply and choose the queue.", {
          optimize: true,
        })
        .withInput("category", z.enum(["billing", "general"]), {
          description: "The predicted case category.",
          optimize: true,
        })
        .withInput("vendor", z.string(), {
          description: "The payment vendor related to the request.",
          optimize: true,
        })
        .withInput("body", z.string(), {
          description: "The original customer email body.",
          optimize: true,
        })
        .withOutput("queue", z.enum(["billing", "general"]), {
          description: "The queue that should handle the reply.",
          optimize: true,
        })
        .withOutput("response", z.string(), {
          description: "The customer-facing reply.",
          optimize: true,
        })
        .build(),
      {
        adapter: superobjective.adapters.xml(),
        model: replyModel,
      },
    );

    const so = await host.create({
      id: "customer-support-stress",
      storage: {
        receipts: {
          search: "receipts-search",
        },
        emails: {
          search: "emails-search",
        },
      },
    });
    const receiptSpace = requiredSpace(so.storage.receipts, "so.storage.receipts");
    const emailSpace = requiredSpace(so.storage.emails, "so.storage.emails");

    const jobs = [
      {
        jobId: "job_0",
        vendor: "Stripe",
        subject: "Refund request job_0",
        body: "Customer job_0 is asking about a duplicate charge from Stripe.",
      },
      {
        jobId: "job_1",
        vendor: "Adyen",
        subject: "Product question job_1",
        body: "Customer job_1 wants a status update about order processing from Adyen.",
      },
    ];

    await Promise.all(
      jobs.map((job, index) =>
        so.state.upsert<JobState>("jobs", job.jobId, (current) =>
          mergeJobState(current, {
            status: "running",
            ordinal: index,
          }),
        ),
      ),
    );

    await Promise.all(
      jobs.map(async (job, index) => {
        const trace = await so.state.startTrace({
          targetKind: "agent",
          targetId: index % 2 === 0 ? "support" : "finance",
          metadata: {
            jobId: job.jobId,
          },
        });

        const classification = await classifyEmail({
          subject: job.subject,
          body: job.body,
        });

        const reply = await draftReply({
          category: classification.category,
          vendor: job.vendor,
          body: job.body,
        });

        await receiptSpace.upsert(`receipt:${job.jobId}`, {
          kind: "report",
          body: {
            vendor: job.vendor,
            category: classification.category,
            queue: reply.queue,
            response: reply.response,
          },
          contentType: "application/json",
          metadata: {
            jobId: job.jobId,
            vendor: job.vendor,
            category: classification.category,
          },
          indexForSearch: true,
          searchableText: `${job.vendor} ${classification.category} ${reply.response}`,
        });

        await emailSpace.upsert(`email:${job.jobId}`, {
          kind: "email",
          body: {
            subject: job.subject,
            body: job.body,
            reply: reply.response,
          },
          contentType: "application/json",
          metadata: {
            jobId: job.jobId,
            mailbox: "support",
            category: classification.category,
          },
          indexForSearch: true,
          searchableText: `${job.subject} ${job.body} ${reply.response}`,
        });

        await so.state.appendTrace(trace.traceId, {
          type: "stress.iteration",
          payload: {
            jobId: job.jobId,
            iteration: index,
            category: classification.category,
            queue: reply.queue,
          },
        });

        await so.state.finishTrace(trace.traceId, {
          status: "ok",
        });

        await so.state.upsert<JobState>("jobs", job.jobId, (current) =>
          mergeJobState(current, {
            status: "completed",
            traceId: trace.traceId,
            category: classification.category,
            queue: reply.queue,
          }),
        );
      }),
    );

    const secondHandle = await host.get({
      id: "customer-support-stress",
    });
    const secondReceipts = requiredSpace(
      secondHandle.storage.receipts,
      "secondHandle.storage.receipts",
    );
    const secondEmails = requiredSpace(secondHandle.storage.emails, "secondHandle.storage.emails");

    const [receipts, emails, jobsState, traces, searchResults] = await Promise.all([
      secondReceipts.list({ limit: 100 }),
      secondEmails.list({ limit: 100 }),
      secondHandle.state.list({ namespace: "jobs", limit: 100 }),
      secondHandle.state.listTraces({ limit: 100 }),
      secondEmails.search({
        query: "duplicate charge",
        limit: 10,
      }),
    ]);

    expect(receipts).toHaveLength(2);
    expect(emails).toHaveLength(2);
    expect(jobsState).toHaveLength(2);
    expect(traces).toHaveLength(2);
    expect(searchResults.length).toBeGreaterThan(0);
    expect(classifyModel.calls).toHaveLength(2);
    expect(replyModel.calls).toHaveLength(2);

    const sampleReceipt = await secondReceipts.get("receipt:job_0");
    expect(sampleReceipt?.metadata.jobId).toBe("job_0");
    expect(sampleReceipt?.metadata.category).toBe("billing");

    const sampleJob = jobsState.find((item) => item.key === "job_0");
    expect(sampleJob?.value).toMatchObject({
      status: "completed",
      ordinal: 0,
      category: "billing",
      queue: "billing",
    });

    await secondHandle.destroy();

    await expect(
      host.get({
        id: "customer-support-stress",
      }),
    ).rejects.toThrow(/was not found/i);
  });
});
