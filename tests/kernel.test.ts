import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  createCloudflareWorker,
  type CloudflareEnvLike,
  type ProjectLike,
} from "@superobjective/cloudflare";
import { so } from "superobjective";

const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
});

const answerQuestion = so.program({
  name: "answer_question_impl",
  input: z.object({
    question: z.string(),
    context: z.array(chatMessageSchema),
  }),
  output: z.object({
    answer: z.string(),
    historyCount: z.number(),
  }),
  async run(_ctx, input) {
    return {
      answer: input.question,
      historyCount: input.context.length,
    };
  },
});

const refundSummary = so.program({
  name: "refund_summary_impl",
  input: z.object({
    order: z.object({
      found: z.boolean(),
      reference: z.string(),
      status: z.string(),
    }),
  }),
  output: z.object({
    reference: z.string(),
    status: z.string(),
  }),
  async run(_ctx, input) {
    return {
      reference: input.order.reference,
      status: input.order.status,
    };
  },
});

const recentMessagesSummary = so.program({
  name: "recent_messages_summary_impl",
  input: z.object({
    messages: z.array(chatMessageSchema),
  }),
  output: z.object({
    count: z.number(),
    roles: z.array(z.enum(["system", "user", "assistant", "tool"])),
    lastContent: z.string().nullable(),
  }),
  async run(_ctx, input) {
    return {
      count: input.messages.length,
      roles: input.messages.map((message) => message.role),
      lastContent: input.messages.at(-1)?.content ?? null,
    };
  },
});

const profileFromStateProgram = so.program({
  name: "profile_from_state_impl",
  input: z.object({
    profile: z.object({
      tier: z.string(),
      locale: z.string(),
    }),
  }),
  output: z.object({
    tier: z.string(),
    locale: z.string(),
  }),
  async run(_ctx, input) {
    return input.profile;
  },
});

const supportFlow = so.program({
  name: "support_flow",
  input: z
    .object({
      question: z.string().optional(),
      message: z.string().optional(),
    })
    .passthrough(),
  output: z.object({
    response: z.string(),
  }),
  async run(_ctx, input) {
    return {
      response: input.question ?? input.message ?? "ok",
    };
  },
});

const lookupOrder = so.tool({
  name: "lookup_order",
  description: so.text({
    value: "Look up an order by email.",
    optimize: true,
  }),
  input: z.object({
    email: z.string().email(),
  }),
  output: z.object({
    found: z.boolean(),
    reference: z.string(),
    status: z.string(),
  }),
  async execute(input) {
    return {
      found: true,
      reference: `order:${input.email}`,
      status: "manual-review",
    };
  },
});

const answerFromChat = so.tool(answerQuestion, {
  name: "answer_from_chat",
  input: {
    question: so.from.chat.currentUserMessage(),
    context: so.from.chat.historyAsContext({
      maxMessages: 2,
    }),
  },
  execution: "auto",
});

const refundFromLookup = so.tool(refundSummary, {
  name: "refund_from_lookup",
  input: {
    order: so.from.latestToolResult("lookup_order", {
      required: true,
    }),
  },
  execution: "auto",
});

const recentMessagesTool = so.tool(recentMessagesSummary, {
  name: "recent_messages",
  input: {
    messages: so.from.chat.messagesSinceLastToolCall("lookup_order"),
  },
  execution: "auto",
});

const profileFromState = so.tool(profileFromStateProgram, {
  name: "profile_from_state",
  input: {
    profile: so.from.state("customer_profile"),
  },
  execution: "auto",
});

const supportAgent = so.agent({
  name: "support",
  system: so.text({
    value: "You are a precise support assistant.",
    optimize: true,
  }),
  chat: supportFlow,
  tools: [lookupOrder, answerFromChat, refundFromLookup, recentMessagesTool, profileFromState],
});

const financeCorpus = so.corpus({
  id: "finance-records",
  storage: {
    kind: "r2",
    bucketBinding: "SO_DATA",
    prefix: "finance/2026/q1",
  },
  retrieval: {
    kind: "ai-search",
    binding: "AI_SEARCH",
    namespace: "finance-records",
    instanceId: "finance-records",
    sourceMode: "external-r2",
  },
});

class TestBucket {
  private readonly store = new Map<string, string | Uint8Array>();

  constructor(seed?: Record<string, string | Uint8Array>) {
    for (const [key, value] of Object.entries(seed ?? {})) {
      this.store.set(key, value);
    }
  }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream) {
    if (typeof value === "string") {
      this.store.set(key, value);
      return;
    }

    if (value instanceof Blob) {
      this.store.set(key, new Uint8Array(await value.arrayBuffer()));
      return;
    }

    if (value instanceof ReadableStream) {
      this.store.set(key, new Uint8Array(await new Response(value).arrayBuffer()));
      return;
    }

    if (ArrayBuffer.isView(value)) {
      this.store.set(key, new Uint8Array(value.buffer.slice(0)));
      return;
    }

    this.store.set(key, new Uint8Array(value.slice(0)));
  }

  async get(key: string) {
    const value = this.store.get(key);
    if (value == null) {
      return null;
    }
    const bytes =
      typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    return {
      size: bytes.byteLength,
      async text() {
        return typeof value === "string" ? value : new TextDecoder().decode(bytes);
      },
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }

  async delete(key: string) {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string }) {
    const prefix = options?.prefix ?? "";
    return {
      objects: [...this.store.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort((left, right) => left.localeCompare(right))
        .map((key) => ({ key })),
    };
  }
}

class TestSearchNamespace {
  private readonly instances = new Map<string, {
    info(): Promise<unknown>;
    search(args: Record<string, unknown>): Promise<unknown>;
    items: {
      uploadAndPoll(name: string): Promise<{ id: string; filename?: string }>;
      delete(itemId: string): Promise<void>;
    };
  }>();

  createInstance(name: string, responseFactory?: (args: Record<string, unknown>) => unknown) {
    this.instances.set(name, {
      async info() {
        return {
          id: name,
        };
      },
      async search(args: Record<string, unknown>) {
        return (
          responseFactory?.(args) ?? {
            results: [],
          }
        );
      },
      items: {
        async uploadAndPoll(filename: string) {
          return {
            id: `${name}:${filename}`,
            filename,
          };
        },
        async delete(_itemId: string) {},
      },
    });
  }

  get(name: string) {
    const instance = this.instances.get(name);
    if (instance == null) {
      throw new Error(`Search instance "${name}" was not found.`);
    }
    return instance;
  }

  async create(options: { id: string }) {
    this.createInstance(options.id);
    return this.get(options.id);
  }

  async delete(name: string) {
    this.instances.delete(name);
  }
}

function createCorpusEnv(): CloudflareEnvLike {
  const bucket = new TestBucket({
    "finance/2026/q1/refunds.csv": "order_id,amount,status\nord_1,42.00,settled\n",
    "finance/2026/q1/ledger.csv": "entry_id,kind\nent_1,refund\n",
    "uploads/manual/review.csv": "case_id,status\ncase_1,open\n",
  });
  const search = new TestSearchNamespace();
  search.createInstance("finance-records", () => ({
    data: [
      {
        id: "hit-refund-1",
        text: "ord_1 refund settled",
        score: 0.91,
        metadata: {
          key: "refunds.csv",
          source: "finance/2026/q1/refunds.csv",
        },
      },
    ],
  }));
  return {
    SO_DATA: bucket as NonNullable<CloudflareEnvLike["SO_DATA"]>,
    AI_SEARCH: search as NonNullable<CloudflareEnvLike["AI_SEARCH"]>,
  };
}

function createWorker() {
  return createCloudflareWorker({
    project: so.project({
      programs: [
        answerQuestion,
        refundSummary,
        recentMessagesSummary,
        profileFromStateProgram,
        supportFlow,
      ],
      agents: [supportAgent],
      corpora: [financeCorpus],
    }) as ProjectLike,
  });
}

describe("kernel routes", () => {
  it("wraps a module as a direct tool", async () => {
    const tool = so.tool(refundSummary);

    const result = await tool.execute(
      {
        order: {
          found: true,
          reference: "order:123",
          status: "processed",
        },
      },
      {
        runtime: so.getRuntimeContext(),
        log() {},
      },
    );

    expect(result).toEqual({
      reference: "order:123",
      status: "processed",
    });
    expect(tool.inspectExecutionPlan().selected).toBe("direct");
  });

  it("selects codemode when prepared inputs require programmable resolution", () => {
    const tool = so.tool(refundSummary, {
      name: "refund_from_codemode",
      input: {
        order: so.prepare.codemode({
          instructions: "Load the order with lookup_order if it is missing.",
          tools: [lookupOrder],
        }),
      },
      execution: "auto",
    });

    expect(tool.inspectExecutionPlan().selected).toBe("codemode");
    expect(tool.inspectExecutionPlan().reasons.join("\n")).toContain("prepared codemode");
  });

  it("resolves chat-bound inputs and prior tool results through the kernel", async () => {
    const worker = createWorker();

    const firstTurn = await worker.fetch(
      new Request("https://example.com/kernel/agent/support/session-1/message", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: {
            question: "I placed an order yesterday.",
          },
        }),
      }),
    );

    expect(firstTurn.status).toBe(200);

    const secondTurn = await worker.fetch(
      new Request("https://example.com/kernel/agent/support/session-1/message", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: {
            question: "Where is my refund?",
          },
        }),
      }),
    );

    expect(secondTurn.status).toBe(200);

    const chatToolResponse = await worker.fetch(
      new Request("https://example.com/kernel/agent/support/session-1/message", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "answer_from_chat",
          input: {},
        }),
      }),
    );

    expect(chatToolResponse.status).toBe(200);
    const chatToolPayload = (await chatToolResponse.json()) as {
      ok: boolean;
      output: {
        answer: string;
        historyCount: number;
      };
      traceId: string;
    };

    expect(chatToolPayload.ok).toBe(true);
    expect(chatToolPayload.output.answer).toContain("Where is my refund?");
    expect(chatToolPayload.output.historyCount).toBe(2);

    const lookupResponse = await worker.fetch(
      new Request("https://example.com/kernel/tool/lookup_order", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: "session-1",
          input: {
            email: "test@example.com",
          },
        }),
      }),
    );

    expect(lookupResponse.status).toBe(200);

    const refundResponse = await worker.fetch(
      new Request("https://example.com/kernel/tool/refund_from_lookup", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: "session-1",
          input: {},
        }),
      }),
    );

    expect(refundResponse.status).toBe(200);
    const refundPayload = (await refundResponse.json()) as {
      ok: boolean;
      output: {
        reference: string;
        status: string;
      };
      traceId: string;
    };

    expect(refundPayload.ok).toBe(true);
    expect(refundPayload.output.reference).toBe("order:test@example.com");
    expect(refundPayload.output.status).toBe("manual-review");

    const postLookupTurn = await worker.fetch(
      new Request("https://example.com/kernel/agent/support/session-1/message", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: {
            question: "Anything else I should check?",
          },
        }),
      }),
    );

    expect(postLookupTurn.status).toBe(200);

    const recentMessagesResponse = await worker.fetch(
      new Request("https://example.com/kernel/agent/support/session-1/message", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "recent_messages",
          input: {},
        }),
      }),
    );

    expect(recentMessagesResponse.status).toBe(200);
    const recentMessagesPayload = (await recentMessagesResponse.json()) as {
      ok: boolean;
      output: {
        count: number;
        roles: string[];
        lastContent: string | null;
      };
    };

    expect(recentMessagesPayload.ok).toBe(true);
    expect(recentMessagesPayload.output.count).toBe(3);
    expect(recentMessagesPayload.output.roles).toEqual(["tool", "user", "assistant"]);
    expect(recentMessagesPayload.output.lastContent).toBe("Anything else I should check?");

    const traceResponse = await worker.fetch(
      new Request(`https://example.com/kernel/traces/${refundPayload.traceId}`),
    );

    expect(traceResponse.status).toBe(200);
    const tracePayload = (await traceResponse.json()) as {
      ok: boolean;
      trace: {
        targetKind: string;
        targetId: string;
      };
    };

    expect(tracePayload.ok).toBe(true);
    expect(tracePayload.trace.targetKind).toBe("tool");
    expect(tracePayload.trace.targetId).toBe("refund_from_lookup");
  });

  it("resolves state-bound inputs through the kernel session store", async () => {
    const worker = createWorker();

    const stateWriteResponse = await worker.fetch(
      new Request("https://example.com/kernel/state/customer_profile", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: "session-state",
          value: {
            tier: "gold",
            locale: "nl-NL",
          },
        }),
      }),
    );

    expect(stateWriteResponse.status).toBe(200);

    const toolResponse = await worker.fetch(
      new Request("https://example.com/kernel/tool/profile_from_state", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: "session-state",
          input: {},
        }),
      }),
    );

    expect(toolResponse.status).toBe(200);
    const toolPayload = (await toolResponse.json()) as {
      ok: boolean;
      output: {
        tier: string;
        locale: string;
      };
    };

    expect(toolPayload.ok).toBe(true);
    expect(toolPayload.output).toEqual({
      tier: "gold",
      locale: "nl-NL",
    });

    const stateReadResponse = await worker.fetch(
      new Request("https://example.com/kernel/state/customer_profile?sessionId=session-state"),
    );

    expect(stateReadResponse.status).toBe(200);
    const stateReadPayload = (await stateReadResponse.json()) as {
      ok: boolean;
      value: {
        tier: string;
        locale: string;
      };
    };

    expect(stateReadPayload.ok).toBe(true);
    expect(stateReadPayload.value.tier).toBe("gold");
  });

  it("stores and activates artifacts without a separate runtime artifact store", async () => {
    const worker = createWorker();
    const artifact = {
      id: "artifact-support-flow-v1",
      target: {
        kind: "program" as const,
        id: "support_flow",
      },
      optimizer: {
        id: "gepa",
        version: "0.1.0",
        configHash: "cfg-1",
      },
      textCandidate: {
        "program.support_flow.instructions": "Prefer concise support replies.",
      },
      adapter: {
        id: "test-adapter",
        version: "0.0.1",
      },
      eval: {
        metricName: "support_quality",
        trainScore: 0.9,
        trainSize: 4,
      },
      createdAt: "2026-04-21T10:00:00.000Z",
    };

    const saveResponse = await worker.fetch(
      new Request("https://example.com/kernel/artifacts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          artifact,
        }),
      }),
    );

    expect(saveResponse.status).toBe(200);

    const getResponse = await worker.fetch(
      new Request(`https://example.com/kernel/artifacts/${artifact.id}`),
    );

    expect(getResponse.status).toBe(200);
    const getPayload = (await getResponse.json()) as {
      ok: boolean;
      artifact: {
        id: string;
        target: {
          id: string;
        };
      };
    };

    expect(getPayload.ok).toBe(true);
    expect(getPayload.artifact.id).toBe(artifact.id);
    expect(getPayload.artifact.target.id).toBe("support_flow");

    const activateResponse = await worker.fetch(
      new Request("https://example.com/kernel/artifacts/program/support_flow/active", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          artifactId: artifact.id,
        }),
      }),
    );

    expect(activateResponse.status).toBe(200);

    const activeResponse = await worker.fetch(
      new Request("https://example.com/kernel/artifacts/active/program/support_flow"),
    );

    expect(activeResponse.status).toBe(200);
    const activePayload = (await activeResponse.json()) as {
      ok: boolean;
      artifact: {
        id: string;
      };
    };

    expect(activePayload.ok).toBe(true);
    expect(activePayload.artifact.id).toBe(artifact.id);
  });

  it("registers, lists, reads, and searches corpora through kernel routes", async () => {
    const worker = createWorker();
    const env = createCorpusEnv();

    const listResponse = await worker.fetch(
      new Request("https://example.com/kernel/corpora"),
      env,
    );

    expect(listResponse.status).toBe(200);
    const listPayload = (await listResponse.json()) as {
      ok: boolean;
      corpora: Array<{ id: string }>;
    };

    expect(listPayload.ok).toBe(true);
    expect(listPayload.corpora.map((corpus) => corpus.id)).toContain("finance-records");

    const readResponse = await worker.fetch(
      new Request("https://example.com/kernel/corpora/finance-records/read", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          path: "refunds.csv",
        }),
      }),
      env,
    );

    expect(readResponse.status).toBe(200);
    const readPayload = (await readResponse.json()) as {
      ok: boolean;
      content: string;
    };

    expect(readPayload.ok).toBe(true);
    expect(readPayload.content).toContain("ord_1");

    const searchResponse = await worker.fetch(
      new Request("https://example.com/kernel/corpora/finance-records/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: "refund settled",
          maxResults: 5,
        }),
      }),
      env,
    );

    expect(searchResponse.status).toBe(200);
    const searchPayload = (await searchResponse.json()) as {
      ok: boolean;
      result: {
        query?: string;
        chunks: Array<{
          id: string;
          text: string;
          item?: {
            key?: string;
          };
        }>;
      };
    };

    expect(searchPayload.ok).toBe(true);
    expect(searchPayload.result.query).toBe("refund settled");
    expect(searchPayload.result.chunks[0]?.id).toBe("hit-refund-1");
    expect(searchPayload.result.chunks[0]?.item?.key).toBe("refunds.csv");

    const registerResponse = await worker.fetch(
      new Request("https://example.com/kernel/corpora", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          corpus: {
            id: "manual-review",
            storage: {
              kind: "r2",
              bucketBinding: "SO_DATA",
              prefix: "uploads/manual",
            },
          },
        }),
      }),
      env,
    );

    expect(registerResponse.status).toBe(200);

    const getRegisteredResponse = await worker.fetch(
      new Request("https://example.com/kernel/corpora/manual-review"),
      env,
    );

    expect(getRegisteredResponse.status).toBe(200);
    const registeredPayload = (await getRegisteredResponse.json()) as {
      ok: boolean;
      corpus: {
        id: string;
      };
    };

    expect(registeredPayload.ok).toBe(true);
    expect(registeredPayload.corpus.id).toBe("manual-review");

    const filesResponse = await worker.fetch(
      new Request("https://example.com/kernel/corpora/manual-review/files"),
      env,
    );

    expect(filesResponse.status).toBe(200);
    const filesPayload = (await filesResponse.json()) as {
      ok: boolean;
      files: string[];
    };

    expect(filesPayload.ok).toBe(true);
    expect(filesPayload.files).toEqual(["review.csv"]);
  });
});
