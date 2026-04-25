# LongCoT RLM Trace Comparison - 2026-04-24

## Executive Summary

This comparison is based on the available LongCoT trace artifacts from the Superobjective RLM runner and the new `dspy.RLM` runner. The short version is:

- The early "DSPy underperforms badly" result was invalid. DSPy was failing because Deno was not available to its Pyodide interpreter. Those rows are useful as a harness-preflight lesson, not as benchmark evidence.
- After fixing Deno, DSPy is strong on this BlocksWorld subset because it gets a Python execution environment and naturally writes parsers, constructive solvers, and simulators.
- Superobjective was initially disadvantaged by a much smaller budget and by permissive final-output semantics. We have now aligned the LongCoT Superobjective budget to DSPy's values: `maxIterations=50`, `maxLlmCalls=50`, and `maxOutputChars=10000`, and changed the LongCoT `response_text` output schema to require a non-empty string.
- The most important remaining gap is not scoring. It is product/runtime behavior: finalization semantics, trace durability, interpreter ergonomics, and how reliably the agent can distinguish prompt examples from the actual benchmark instance.
- Superobjective still has real product advantages over a local DSPy script: hosted async runs, typed signatures, Durable Object-backed run state, future production observability, and direct integration with the Cloudflare runtime and Superobjective abstractions.

The latest partial post-budget run is directionally encouraging for Superobjective, but it is not a clean benchmark result. In that partial run, two recovered Superobjective completions both verified correct. Four recovered DSPy trajectory outputs included three correct answers and one false tiny-answer submission caused by parsing the example instead of the actual instance.

## Data Sources

Artifacts inspected:

- `benchmarks/longcot/results/solve_longcot_question_vs_dspy_rlm_openai_gpt-5_2_logic_longcot-mini_20260424T152850Z.jsonl`
- `benchmarks/longcot/results/solve_longcot_question_vs_dspy_rlm_openai_gpt-5_2_logic_longcot-mini_20260424T152850Z.summary.json`
- `benchmarks/longcot/results/solve_longcot_question_vs_dspy_rlm_openai_gpt-5_2_logic_longcot-mini_20260424T152850Z.traces/`
- `benchmarks/longcot/results/dspy_rlm_openai_gpt-5_2_logic_longcot-mini_20260424T155339Z.traces/`
- `benchmarks/longcot/results/solve_longcot_question_vs_dspy_rlm_openai_gpt-5_2_logic_longcot-mini_20260424T160541Z.traces/`

Important caveats:

- The `152850Z` dual run is not a fair DSPy comparison because DSPy failed with `Deno executable not found` on every question.
- The `155339Z` DSPy run is a fixed single-question sanity check. It verifies that DSPy can run correctly once Deno is on PATH.
- The `160541Z` run was interrupted while running 10 questions. It left partial DSPy trajectory files and partial Superobjective Durable Object run records. It has no completed JSONL or summary file.
- Models are still not aligned. DSPy was configured through `LONGCOT_DSPY_MODEL=openai/gpt-5.2`; the Superobjective LongCoT probe currently uses `openai/gpt-5.4` through the Cloudflare Worker integration. This makes trace behavior comparable, but accuracy numbers are still confounded.
- The latest partial run has unbalanced completion order. It should not be reported as a 10-question score.

## Current Configuration State

Superobjective LongCoT settings are now aligned to the published DSPy-style budget:

- `maxIterations: 50`
- `maxLlmCalls: 50`
- `maxOutputChars: 10_000`
- `response_text: z.string().trim().min(1)`

DSPy LongCoT settings:

- `dspy.RLM`
- default `max_iterations=50`
- default `max_llm_calls=50`
- configurable `max_output_chars`
- requires Deno/Pyodide support for code execution
- model supplied by `LONGCOT_DSPY_MODEL` or `--dspy-model`

The budget alignment matters. The earlier Superobjective failures happened with only six iterations. With a 50-step budget, Superobjective is no longer inherently cut off before it can recover from failed solver attempts.

## What The Older Dual Run Actually Shows

The `152850Z` dual run summary said:

- DSPy: 0 correct out of 5
- Superobjective: 1 correct out of 5, 2 incorrect, 2 failed

That result is misleading for DSPy because every DSPy trajectory failed at the runtime layer:

- The interpreter could not find Deno.
- DSPy therefore never got a valid local execution environment.
- The result measures harness configuration, not DSPy reasoning.

The Superobjective traces from that same run are still useful because they show real product and agent failure modes:

- `BlocksWorld_easy_10`: correct. The run reached a verified JS solution and submitted a non-empty answer.
- `BlocksWorld_easy_11`: failed with no valid `SUBMIT`. The run ended with an empty `response_text` through extraction.
- `BlocksWorld_easy_12`: failed with no valid `SUBMIT`. Several candidate algorithms errored before reaching submission.
- `BlocksWorld_easy_1`: submitted a non-empty but verifier-incorrect answer.
- `BlocksWorld_easy_13`: submitted a tiny answer that appears to solve the prompt example rather than the actual 60-block puzzle instance.

This run exposed two distinct problems:

1. Product finalization allowed an empty extraction to become a completed result.
2. The agent sometimes parsed the first `Initial state` and `Goal state` in the prompt, which belonged to the example, not the actual instance.

The first is a product/runtime issue. The second is an agent-task issue that both systems can hit.

## DSPy After The Deno Fix

The fixed one-question DSPy run on `BlocksWorld_easy_1` completed correctly. Its trajectory is representative of why DSPy is strong on these particular LongCoT logic questions:

- It used Python to inspect the prompt.
- It used `re` and `ast` for parsing.
- It noticed that the first parse grabbed the toy example and corrected itself by taking the last occurrence of `Initial state` and `Goal state`.
- It iterated through several failed constructive algorithms.
- It eventually generated a valid blocks-world planner.
- It simulated the move list and checked that the final state exactly matched the goal.
- It submitted the official `solution = ...` answer surface.

The important point is not that DSPy has a magic LongCoT solver. It has an ergonomic local Python scratchpad, and the model quickly reaches for Python-native parsing and verification patterns. For BlocksWorld, that is a large advantage.

## Latest Partial Post-Budget Run

The interrupted `160541Z` run is not a complete benchmark result, but it is useful trace evidence because it ran after the budget and non-empty-output fixes.

Recovered Superobjective records:

| Question | Status | Steps | Submitted | Output length | Official verifier |
| --- | ---: | ---: | ---: | ---: | ---: |
| `BlocksWorld_easy_4` | completed | 6 | yes | 5891 | correct |
| `BlocksWorld_easy_10` | completed | 6 | yes | 6266 | correct |
| `BlocksWorld_easy_13` | running | 13 | no | 0 | not scored |

Recovered DSPy trajectory outputs:

| Question | Steps | Output length | Official verifier | Notes |
| --- | ---: | ---: | ---: | --- |
| `BlocksWorld_easy_1` | 10 | 7829 | correct | Recovered from failed attempts and submitted a long verified plan. |
| `BlocksWorld_easy_4` | 6 | 8225 | correct | Parsed actual instance after initially seeing the example, then solved. |
| `BlocksWorld_easy_12` | 4 | 7347 | correct | First parsed the example, noticed it, reparsed the real instance, then solved. |
| `BlocksWorld_easy_15` | 4 | 33 | incorrect | Parsed and solved the toy example, then submitted `solution = [[2, 1, 2], [0, 0, 2]]`. |

The key readout from this partial run:

- Superobjective can solve real 60-block instances under the aligned budget.
- DSPy can still make the same example-vs-instance parsing mistake.
- DSPy tends to recover from that mistake when it explicitly checks block counts, but not always.
- Superobjective's act instructions now explicitly tell the agent to slice from the last actual instance section. That is the right kind of benchmark-harness guidance: it is general prompt hygiene, not a baked-in LongCoT solver.

## Where Superobjective Loses Today

### 1. Interpreter Ergonomics

DSPy gives the model a Python execution environment. That matters here because the natural solution path for BlocksWorld is:

1. Parse lists from text.
2. Manipulate nested arrays.
3. Write a small planner.
4. Simulate every move.
5. Submit only if final state equals goal.

Python makes this path easy. The model uses `re`, `ast.literal_eval`, `copy`, list comprehensions, and quick simulation loops. The DSPy traces look like a familiar notebook workflow.

Superobjective's Worker JavaScript REPL can do the same work, but the generated code is more verbose and has more runtime-footgun surface:

- no Node built-ins
- no `require`
- no `fs`
- no `Buffer`
- JSON parsing instead of Python literal parsing
- more ceremony around copying and diagnostics
- regex extraction is easier to get subtly wrong

This is not an unsolvable limitation, but it is a real product gap. For RLM to feel stable across tasks, the execution environment should make common inspection, parsing, and verification workflows easy.

### 2. Finalization Semantics Were Too Permissive

The older failed Superobjective runs show completed runs with an empty `response_text` after no valid `SUBMIT`. That is the wrong product behavior for a required output field.

The LongCoT-specific fix was:

```ts
response_text: z.string().trim().min(1)
```

What this achieves:

- An empty extraction can no longer satisfy the output schema.
- A run with no valid final answer is surfaced as a failed run instead of a completed empty answer.
- The benchmark row can distinguish runtime failure from verifier-incorrect output.

What it does not achieve:

- It does not make the answer correct.
- It does not detect that the answer solved the example instead of the instance.
- It does not replace the official LongCoT verifier.

The broader product fix should be generic: every RLM run should expose whether completion came from `SUBMIT`, extraction, fallback extraction, or failure. Empty required outputs should fail schema validation by default.

### 3. Trace Durability And Interrupted Runs

DSPy trajectories are written as soon as the backend returns. In the interrupted run, several DSPy trajectory files survived.

Superobjective run JSON was originally saved by the benchmark runner only after the full backend call returned. When the run was interrupted, no benchmark-side Superobjective trace artifacts were written. I had to recover records manually from `/kernel/rlm/:runId`.

This matters for product stability:

- Long runs are exactly where users need durable traces.
- If a benchmark or client process dies, the RLM run should still be inspectable.
- The runner should persist run IDs immediately, then enrich rows later.
- The UI/API should make it easy to retrieve partial trajectories for running or abandoned runs.

The Durable Object already has useful state. The gap is artifact lifecycle and UX around it.

### 4. Prompt Example Confusion

Both systems can parse the toy example instead of the actual problem instance.

Evidence:

- Old Superobjective `BlocksWorld_easy_13` submitted a tiny answer like `solution = [[2,1,0],[2,0,2],[0,0,2]]`, which is not a 60-block solution.
- Latest DSPy `BlocksWorld_easy_15` submitted `solution = [[2, 1, 2], [0, 0, 2]]`, exactly the toy example solution shape.
- Other DSPy traces show the model catching the issue after printing block counts, then reparsing the last occurrence or the `Puzzle instance:` section.

This is not a scoring bug. It is a general prompt-processing reliability problem. The stable-RLM lesson is to encourage and support:

- isolating the actual task section before parsing
- checking declared metadata against parsed data
- rejecting tiny outputs when the instance says there are 60 blocks
- recording parser evidence in the trace before final submission

We should avoid baking a BlocksWorld parser into Superobjective. But we should make the general behavior easy: "identify the task section, parse from that section, verify metadata, then solve."

### 5. State Semantics Across Steps

Some older Superobjective traces show the agent attempting to carry values across steps and then failing with messages like `Missing solvedMoves`. Whether this was a true runtime-state issue or a model assumption issue, the trace shows the model did not have a reliable mental model of what persists.

DSPy's local RLM trajectory often behaves more like a notebook. It naturally keeps variables and reruns code in a Pythonic flow.

Superobjective should make state semantics explicit in the act prompt and possibly in the runtime surface:

- what persists across steps
- how to store reusable computed artifacts
- what output size limits apply
- whether each step should recompute from source data when correctness matters

For benchmarks, self-contained recomputation is often safer. For a production RLM product, clear state semantics are mandatory.

### 6. Model And Provider Confounding

The traces are not yet apples-to-apples:

- DSPy used `openai/gpt-5.2`.
- Superobjective LongCoT currently uses `openai/gpt-5.4`.
- DSPy runs through local Pyodide/Deno.
- Superobjective runs through the Cloudflare Worker stack and Workers AI integration.

Before making accuracy claims, we need a run where:

- both use the same model where possible
- both use the same question order
- both use the same budget
- both use the official verifier
- partial/interrupted runs are excluded from aggregate scoring

## Where Superobjective Wins Or Might Win

### 1. Hosted Async Execution

Superobjective already has a hosted RLM shape:

- `/kernel/rlm/:runId` polling
- run status
- session IDs
- Durable Object-backed state
- inspectable steps
- async background execution

DSPy's local script is effective for research, but it is not a product runtime by itself. Superobjective is closer to something users can operate, monitor, and integrate.

### 2. Typed Product Contracts

Superobjective's signature and Zod schema give us a typed contract around inputs and outputs. Once schema validation is strict, this is a major advantage:

- invalid empty output fails
- output fields are named and inspectable
- app code can rely on a stable shape
- benchmark rows can separate runtime failure from verifier failure

DSPy can express signatures too, but Superobjective's TypeScript/Zod boundary is closer to production app integration.

### 3. Production Runtime Integration

The Worker JavaScript environment is less ergonomic than Python for this benchmark, but it is the deployment target. That matters if the goal is a stable RLM product rather than only leaderboard performance.

Advantages:

- same environment in benchmark and deployed app
- direct access to Cloudflare bindings and product resources
- Durable Object persistence
- streaming and dashboard integration potential
- app-native TypeScript integration

DSPy's local interpreter is a powerful scratchpad. Superobjective's runtime is a product substrate.

### 4. Observability Potential

The Superobjective traces already contain useful structured details:

- reasoning per step
- code per step
- stdout diagnostics
- errors
- submitted payloads
- final output
- run status

The issue is not absence of observability. The issue is making it durable, first-class, and easy to compare. With better trace persistence and UI/API retrieval, Superobjective can beat the local DSPy workflow for debugging long-running agents.

### 5. General RLM Abstractions

Superobjective can expose a richer runtime surface than DSPy for product tasks:

- `rlm.query`
- `rlm.queryBatch`
- resource listing and bounded resource reads
- typed signatures
- query providers
- hosted modules
- app-specific tools

LongCoT BlocksWorld mostly rewards local code execution. Many real product tasks reward access to typed app context, hosted state, retrieval, and controlled tool surfaces. That is where Superobjective should be able to win.

## Recommendations

### P0: Keep Strict Output Validation

The `z.string().trim().min(1)` LongCoT change is correct. More generally, required string outputs should not silently accept empty strings unless the schema explicitly allows them.

Also add explicit finalization metadata to RLM run records:

- `finish_reason: "submitted" | "extracted" | "schema_failed" | "max_iterations" | "max_llm_calls" | "runtime_error"`
- `submitted: boolean`
- `extracted: boolean`
- `output_validation_error?: string`

This would have made the old empty-output failures obvious immediately.

### P0: Persist Run IDs And Partial Traces Immediately

The benchmark runner should write a row or sidecar record as soon as it receives a Superobjective `runId`. It can fill in `correct`, `response_text`, and `trace_path` later.

Minimum useful artifact:

```json
{
  "backend": "superobjective",
  "question_id": "...",
  "run_id": "...",
  "status": "running",
  "started_at": "..."
}
```

That way an interrupted 10-question run is still analyzable without scraping terminal logs.

### P1: Add Runtime Preflight Checks

The DSPy Deno failure should have failed before spending benchmark time.

Preflight should check:

- DSPy model configured
- OpenAI API key env available
- Deno available for DSPy/Pyodide
- Superobjective base URL reachable
- Superobjective module route available
- selected model/provider configured

For compare mode, preflight should run before launching either backend.

### P1: Improve General Prompt Section Isolation

Do not add a LongCoT solver. Do add general guidance and helper patterns for prompts with examples.

The Superobjective LongCoT act prompt now tells the agent to use the final actual instance section, for example slicing from `lastIndexOf("Puzzle instance:")`. That is appropriate. It is not solving the benchmark; it is avoiding a common prompt-processing failure.

The next step is to make this easier generically:

- small helper examples in act instructions
- bounded prompt inspection patterns
- metadata checks before solve
- "do not parse examples as task data" guidance

### P1: Clarify Step State Semantics

The runtime should document and expose what persists across steps. If state persistence is reliable, say exactly how. If it is intentionally limited, the agent prompt should say to recompute critical values from `inputs` or durable resources.

For high-stakes verification, the model should prefer a final self-contained step that reparses the prompt, recomputes the plan, simulates it, and submits only if the check passes.

### P2: Consider Better Standard Library Ergonomics

The Worker JS environment does not need to become Python, but RLM stability would improve with a small set of safe, documented helpers:

- robust JSON/list extraction from labeled sections
- deep clone
- bounded pretty printing
- assertions with structured errors
- maybe a tiny standard `inspectPromptSections` helper

These should be generic runtime utilities, not LongCoT domain solvers.

### P2: Make The Comparison Truly Fair

The next clean experiment should be:

```bash
set -a; source benchmarks/longcot/.env; set +a
pnpm benchmark:longcot:compare --domain logic --difficulty longcot-mini --max-questions 10 --base-url http://127.0.0.1:8787
```

But before treating it as evidence:

- confirm Superobjective and DSPy use comparable models
- confirm no timeout is applied, or record the timeout explicitly
- exclude runs where the backend failed preflight
- store partial run IDs as soon as they are created
- use only completed rows for per-backend accuracy
- report failed, incorrect, wrong-format, and correct separately

## What Not To Do

Do not hard-code a LongCoT BlocksWorld solver into Superobjective.

That would improve this benchmark while weakening the product goal. LongCoT is useful here as pressure: can the RLM runtime inspect a hard prompt, use code, verify its own work, and produce a strict answer surface? The right improvements are runtime-generic:

- stricter finalization
- better trace lifecycle
- clearer state semantics
- easier prompt inspection
- better execution ergonomics
- stronger preflight checks

## Bottom Line

DSPy currently looks better at this particular style of LongCoT logic task because its local Python RLM loop is a very good fit for parsing, simulation, and constructive search. Superobjective's losses are mostly product/runtime maturity issues, not verifier bugs.

The promising signal is that once budget was aligned, Superobjective completed and verified two recovered 60-block instances in the partial run. The less promising signal is that older traces exposed weak completion semantics and brittle trace persistence.

If the goal is to create a stable RLM, the next work should focus on turning those product gaps into hard runtime guarantees. Accuracy will improve as a consequence, but the deeper win is making failures legible, recoverable, and hard to misclassify.
