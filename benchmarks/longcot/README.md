# LongCoT Benchmark

This benchmark uses the real official LongCoT dataset and verifier against the deployed or local Superobjective RLM route.

What is real in this setup:

- Questions are loaded from the official `longcot` package from [LongHorizonReasoning/longcot](https://github.com/LongHorizonReasoning/longcot).
- Scoring uses the official `longcot._verifier.verify(...)` function.
- The runner calls the actual Superobjective RLM HTTP route at `/kernel/rlm/solve_longcot_question`.

The default target module is [solve_longcot_question](/Users/matserdkamp/Documents/superobjective-v2/apps/cloudflare-worker/src/longcot-probe.ts).

## Requirements

- Python `3.12`
- `uv`
- A running Superobjective worker, either:
  - local `wrangler dev`
  - or a deployed worker with `SUPEROBJECTIVE_LIVE_BASE_URL` set

The runner installs the official benchmark package on demand through `uv`.

## Quick start

Smoke test one official question:

```bash
uv run --python 3.12 benchmarks/longcot/run_longcot_benchmark.py \
  --difficulty longcot-mini \
  --domain logic \
  --max-questions 1 \
  --base-url "$SUPEROBJECTIVE_LIVE_BASE_URL"
```

Target one specific official question id:

```bash
uv run --python 3.12 benchmarks/longcot/run_longcot_benchmark.py \
  --difficulty longcot-mini \
  --domain chess \
  --question-id piece_combinations_easy_20 \
  --base-url "$SUPEROBJECTIVE_LIVE_BASE_URL"
```

Run the official easy split:

```bash
uv run --python 3.12 benchmarks/longcot/run_longcot_benchmark.py \
  --difficulty longcot-mini \
  --base-url "$SUPEROBJECTIVE_LIVE_BASE_URL"
```

Run the official medium+hard benchmark:

```bash
uv run --python 3.12 benchmarks/longcot/run_longcot_benchmark.py \
  --difficulty longcot \
  --base-url "$SUPEROBJECTIVE_LIVE_BASE_URL"
```

Use a local worker instead:

```bash
uv run --python 3.12 benchmarks/longcot/run_longcot_benchmark.py \
  --difficulty longcot-mini \
  --base-url http://127.0.0.1:8787
```

## Output

Each run writes:

- `benchmarks/longcot/results/<timestamp>.jsonl`
- `benchmarks/longcot/results/<timestamp>.summary.json`

Each JSONL row includes the official fields:

- `question_id`
- `domain`
- `difficulty`
- `successful`
- `response_text`

and extra metadata such as:

- `trace_id`
- `http_status`
- `latency_s`
- `correct`
- `wrong_formatting`

## Notes

- The benchmark runner now defaults to no client-side HTTP timeout. If a run hangs, add `--timeout-s 180` or another value to cap it.
- The runner disables the official math/chemistry fallback judges by default, so the score is self-contained and does not depend on extra Gemini calls.
- `--enable-fallback` turns those official fallbacks back on if you want them.
- Full LongCoT runs can be expensive. Start with `--max-questions 1` or `--difficulty longcot-mini`.
