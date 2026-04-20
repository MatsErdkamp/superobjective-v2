import { z } from "zod";

import { signatureToInputZodSchema, signatureToOutputZodSchema } from "./schema.js";
import type {
  Example,
  InferInput,
  InferOutput,
  PredictModule,
  Program,
  Signature,
  Tool,
} from "./types.js";
import { deterministicShuffle } from "./utils.js";

type ExampleTarget<TInput, TOutput> =
  | Signature<any, any>
  | PredictModule<TInput, TOutput>
  | Program<TInput, TOutput>
  | Tool<TInput, TOutput>;

export function examples<TTarget extends ExampleTarget<any, any>>(
  target: TTarget,
  values: Array<Example<InferInput<TTarget>, Partial<InferOutput<TTarget>>>>,
): Array<Example<InferInput<TTarget>, Partial<InferOutput<TTarget>>>> {
  const inputSchema = getInputSchema(target);
  const expectedSchema = getExpectedSchema(target);
  const ids = new Set<string>();

  for (const example of values) {
    inputSchema.parse(example.input);
    expectedSchema.parse(example.expected);

    if (example.id) {
      if (ids.has(example.id)) {
        throw new Error(`Duplicate example id "${example.id}".`);
      }
      ids.add(example.id);
    }
  }

  return values;
}

export function splitExamples<TInput, TExpected>(
  values: Example<TInput, TExpected>[],
  args: {
    train: number;
    val: number;
    test: number;
    seed?: number;
  },
): {
  trainset: Example<TInput, TExpected>[];
  valset: Example<TInput, TExpected>[];
  testset: Example<TInput, TExpected>[];
} {
  const total = args.train + args.val + args.test;
  if (Math.abs(total - 1) > 0.0001) {
    throw new Error("Split ratios must sum to 1.");
  }

  const shuffled = deterministicShuffle(values, args.seed ?? 1);
  const trainEnd = Math.round(shuffled.length * args.train);
  const valEnd = trainEnd + Math.round(shuffled.length * args.val);

  return {
    trainset: shuffled.slice(0, trainEnd),
    valset: shuffled.slice(trainEnd, valEnd),
    testset: shuffled.slice(valEnd),
  };
}

function getInputSchema(target: ExampleTarget<any, any>): z.ZodTypeAny {
  if (target.kind === "signature") {
    return signatureToInputZodSchema({ signature: target });
  }

  if (target.kind === "predict") {
    return signatureToInputZodSchema({ signature: target.signature });
  }

  return target.inputSchema;
}

function getExpectedSchema(target: ExampleTarget<any, any>): z.ZodTypeAny {
  const outputSchema =
    target.kind === "signature"
      ? signatureToOutputZodSchema({ signature: target })
      : target.kind === "predict"
        ? signatureToOutputZodSchema({ signature: target.signature })
        : (target.outputSchema ?? z.unknown());

  if (outputSchema instanceof z.ZodObject) {
    return outputSchema.partial();
  }

  return outputSchema;
}
