import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { cloudflare } from "@superobjective/cloudflare";
import type { CloudflareEnvLike, RuntimeContextLike } from "@superobjective/cloudflare";
import { so } from "superobjective";

type WorkersAIRunOptions = {
  gateway?: {
    id: string;
    skipCache?: boolean;
    cacheTtl?: number;
  };
} & Record<string, unknown>;

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

  async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
    const prefix = options?.prefix ?? "";
    const offset = options?.cursor != null ? Number.parseInt(options.cursor, 10) : 0;
    const limit = options?.limit ?? 2;
    const matching = [...this.store.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort((left, right) => left.localeCompare(right));
    const page = matching.slice(offset, offset + limit);
    const nextOffset = offset + page.length;

    return {
      objects: page.map((key) => ({ key })),
      truncated: nextOffset < matching.length,
      ...(nextOffset < matching.length ? { cursor: String(nextOffset) } : {}),
    };
  }
}

class TestSearchNamespace {
  private readonly instances = new Map<string, {
    info(): Promise<unknown>;
    search(args: Record<string, unknown>): Promise<unknown>;
    items: {
      upload(name: string): Promise<{ id: string; filename?: string }>;
      uploadAndPoll(name: string): Promise<{ id: string; filename?: string }>;
      delete(itemId: string): Promise<void>;
    };
  }>();

  createInstance(name: string, responseFactory?: (args: Record<string, unknown>) => unknown) {
    this.instances.set(name, {
      async info() {
        return {
          id: name,
          status: "ready",
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
        async upload(filename: string) {
          return {
            id: `${name}:${filename}`,
            filename,
          };
        },
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
  });
  const search = new TestSearchNamespace();
  search.createInstance("finance-records", (args) => ({
    results: [
      {
        id: "hit-1",
        text: `match for ${String(args.query ?? "")}`,
        score: 0.88,
        metadata: {
          key: "refunds.csv",
        },
      },
    ],
  }));
  return {
    SO_DATA: bucket as NonNullable<CloudflareEnvLike["SO_DATA"]>,
    AI_SEARCH: search as NonNullable<CloudflareEnvLike["AI_SEARCH"]>,
  };
}

describe("cloudflare workersAI()", () => {
  it("uses the default AI Gateway when none is configured", async () => {
    let observedOptions: WorkersAIRunOptions | undefined;
    const run = vi.fn((async (
      _model: string,
      _input: Record<string, unknown>,
      options?: WorkersAIRunOptions,
    ) => {
      observedOptions = options;
      return {
        object: {
          answer: "ok",
        },
      };
    }) satisfies NonNullable<NonNullable<CloudflareEnvLike["AI"]>["run"]>);

    const model = cloudflare.workersAI("@cf/meta/llama-3.1-8b-instruct");

    const env: CloudflareEnvLike = {
      AI: {
        run,
      },
    };

    await model.structured({
      env,
      messages: [
        {
          role: "user",
          content: "Why use Cloudflare for AI inference?",
        },
      ],
      schema: z.object({
        answer: z.string(),
      }),
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(observedOptions).toEqual({
      gateway: {
        id: "default",
      },
    });
  });

  it("lets callers override the default gateway id", async () => {
    let observedOptions: WorkersAIRunOptions | undefined;
    const run = vi.fn((async (
      _model: string,
      _input: Record<string, unknown>,
      options?: WorkersAIRunOptions,
    ) => {
      observedOptions = options;
      return {
        object: {
          answer: "ok",
        },
      };
    }) satisfies NonNullable<NonNullable<CloudflareEnvLike["AI"]>["run"]>);

    const model = cloudflare.workersAI("@cf/meta/llama-3.1-8b-instruct", {
      gateway: {
        id: "my-gateway",
        skipCache: false,
        cacheTtl: 3360,
      },
    });

    const env: CloudflareEnvLike = {
      AI: {
        run,
      },
    };

    await model.structured({
      env,
      messages: [
        {
          role: "user",
          content: "Why use Cloudflare for AI inference?",
        },
      ],
      schema: z.object({
        answer: z.string(),
      }),
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(observedOptions).toEqual({
      gateway: {
        id: "my-gateway",
        skipCache: false,
        cacheTtl: 3360,
      },
    });
  });
});

describe("cloudflare R2 stores", () => {
  it("follows R2 list cursors when listing blob keys", async () => {
    const bucket = new TestBucket({
      "runs/a.json": JSON.stringify({ id: "a" }),
      "runs/b.json": JSON.stringify({ id: "b" }),
      "runs/c.json": JSON.stringify({ id: "c" }),
      "runs/d.json": JSON.stringify({ id: "d" }),
    });
    const store = cloudflare.r2BlobStore({
      env: {
        SO_ARTIFACTS: bucket as NonNullable<CloudflareEnvLike["SO_ARTIFACTS"]>,
      },
    });

    await expect(store.list?.("runs/")).resolves.toEqual([
      "runs/a.json",
      "runs/b.json",
      "runs/c.json",
      "runs/d.json",
    ]);
  });
});

describe("cloudflare corpora()", () => {
  it("resolves corpus handles, searches, and reads files from bound env storage", async () => {
    const env = createCorpusEnv();
    const provider = cloudflare.corpora.provider({
      corpora: [
        {
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
        },
      ],
      env,
    });

    const handle = await provider.resolve("finance-records");
    expect(await handle.files.list()).toEqual(["ledger.csv", "refunds.csv"]);
    expect(await handle.files.getText("refunds.csv")).toContain("ord_1");

    const search = await handle.search?.search({
      query: "refund settled",
      maxResults: 3,
    });

    expect(search?.query).toBe("refund settled");
    expect(search?.chunks[0]?.id).toBe("hit-1");
    expect(search?.chunks[0]?.item?.key).toBe("refunds.csv");
  });

  it("materializes prepared corpus context into a workspace", async () => {
    const env = createCorpusEnv();
    const provider = cloudflare.corpora.provider({
      corpora: [
        {
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
        },
      ],
      env,
    });

    const writes: Array<{ path: string; kind: "text" | "bytes" }> = [];
    const workspace = {
      async mkdir(_path: string) {},
      async writeText(path: string, _content: string) {
        writes.push({
          path,
          kind: "text",
        });
      },
      async writeBytes(path: string, _content: Uint8Array) {
        writes.push({
          path,
          kind: "bytes",
        });
      },
    };

    const prepared = await cloudflare.corpora.prepareContext({
      provider,
      corpusIds: ["finance-records"],
      workspace,
      includeSearchInfo: true,
      pathsByCorpus: {
        "finance-records": ["refunds.csv"],
      },
      destinationPrefix: "context",
    });

    expect(prepared.manifest.corpora[0]?.search?.available).toBe(true);
    expect(prepared.manifest.corpora[0]?.materialized?.destinationPrefix).toBe(
      "context/finance-records",
    );
    expect(prepared.manifest.corpora[0]?.materialized?.files).toEqual(["refunds.csv"]);
    expect(writes).toEqual([
      {
        path: "context/finance-records/refunds.csv",
        kind: "text",
      },
    ]);
  });

  it("exposes list, read, and search tools against runtime corpora", async () => {
    const env = createCorpusEnv();
    const provider = cloudflare.corpora.provider({
      corpora: [
        {
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
        },
      ],
      env,
    });

    const runtime = {
      ...so.getRuntimeContext(),
      corpora: provider,
    } as RuntimeContextLike;

    const listTool = cloudflare.corpora.listFilesTool("finance-records");
    const readTool = cloudflare.corpora.readFileTool("finance-records");
    const searchTool = cloudflare.corpora.searchTool("finance-records");

    const listed = await listTool.execute(
      {},
      {
        runtime,
        log() {},
      },
    );
    const read = await readTool.execute(
      {
        path: "refunds.csv",
      },
      {
        runtime,
        log() {},
      },
    );
    const searched = await searchTool.execute(
      {
        query: "refund",
      },
      {
        runtime,
        log() {},
      },
    );

    expect(listed.files).toEqual(["ledger.csv", "refunds.csv"]);
    expect(read.content).toContain("settled");
    expect(searched.chunks[0]?.id).toBe("hit-1");
  });
});
