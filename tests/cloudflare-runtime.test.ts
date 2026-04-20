import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { cloudflare } from "@superobjective/cloudflare";
import type { CloudflareEnvLike } from "@superobjective/cloudflare";

type WorkersAIRunOptions = {
  gateway?: {
    id: string;
    skipCache?: boolean;
    cacheTtl?: number;
  };
} & Record<string, unknown>;

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
