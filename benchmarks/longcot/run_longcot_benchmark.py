#!/usr/bin/env -S uv run --python 3.12
# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = [
#   "dspy>=3.1.3,<4",
#   "httpx>=0.28,<1",
#   "longcot @ git+https://github.com/LongHorizonReasoning/longcot.git",
# ]
# ///

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import sys
import time
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from longcot import load_questions
from longcot._parsing import extract_solution
from longcot._types import ChemistryVerifyOptions, MathVerifyOptions, Question, VerifyOptions
from longcot._verifier import verify

DOMAINS = ("logic", "cs", "chemistry", "chess", "math")
DIFFICULTIES = ("easy", "medium", "hard", "longcot-mini", "longcot")
BACKENDS = ("superobjective", "dspy-rlm", "both")


def build_verify_options(enable_fallback: bool) -> VerifyOptions:
    return VerifyOptions(
        math=MathVerifyOptions(enable_fallback=enable_fallback),
        chemistry=ChemistryVerifyOptions(enable_fallback=enable_fallback),
    )


def load_benchmark_questions(
    *,
    domain: str | None,
    difficulty: str | None,
    max_questions: int | None,
    question_id: str | None,
) -> list[Question]:
    domains = [domain] if domain else list(DOMAINS)
    if difficulty == "longcot":
        difficulties = ["medium", "hard"]
    elif difficulty == "longcot-mini":
        difficulties = ["easy"]
    elif difficulty is not None:
        difficulties = [difficulty]
    else:
        difficulties = ["easy", "medium", "hard"]

    questions: list[Question] = []
    for current_domain in domains:
        for current_difficulty in difficulties:
            questions.extend(
                load_questions(
                    domain=current_domain,
                    difficulty=current_difficulty,
                )
            )

    if max_questions is not None:
        questions = questions[:max_questions]

    if question_id is not None:
        questions = [question for question in questions if question.question_id == question_id]

    if not questions:
        raise SystemExit(
            f"No LongCoT questions found for domain={domain!r} difficulty={difficulty!r} question_id={question_id!r}."
        )

    return questions


def response_text_from_payload(payload: dict[str, Any]) -> str | None:
    output = payload.get("output")
    if isinstance(output, dict):
        for key in ("response_text", "responseText", "answer", "text"):
            value = output.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


async def poll_async_rlm_run(
    *,
    client: httpx.AsyncClient,
    base_url: str,
    run_id: str,
    poll_interval_s: float,
    poll_timeout_s: float | None,
) -> dict[str, Any]:
    started_at = time.perf_counter()
    while True:
        response = await client.get(
            f"{base_url.rstrip('/')}/kernel/rlm/{run_id}",
            timeout=30.0,
        )
        response.raise_for_status()
        body = response.json()
        run = body.get("run") if isinstance(body, dict) else None
        if isinstance(run, dict):
            status = run.get("status")
            if status in {"completed", "failed"}:
                return body

        if poll_timeout_s is not None and time.perf_counter() - started_at >= poll_timeout_s:
            raise TimeoutError(f"Timed out polling RLM run {run_id} after {poll_timeout_s}s")

        await asyncio.sleep(poll_interval_s)


def default_base_url() -> str:
    return (
        os.environ.get("LONGCOT_BASE_URL")
        or os.environ.get("SUPEROBJECTIVE_LIVE_BASE_URL")
        or "http://127.0.0.1:8787"
    )


def safe_filename_token(value: str) -> str:
    return "".join(char if char.isalnum() or char in {"-", "_"} else "_" for char in value)


def output_stem(
    *,
    backend: str,
    module_id: str,
    dspy_model: str | None,
    domain: str | None,
    difficulty: str | None,
) -> str:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    if backend == "superobjective":
        target = module_id
    elif backend == "dspy-rlm":
        target = f"dspy_rlm_{dspy_model or 'unconfigured'}"
    else:
        target = f"{module_id}_vs_dspy_rlm_{dspy_model or 'unconfigured'}"
    safe_target = safe_filename_token(target)
    safe_domain = domain or "all"
    safe_difficulty = difficulty or "all"
    return f"{safe_target}_{safe_domain}_{safe_difficulty}_{stamp}"


async def fetch_trace(
    *,
    client: httpx.AsyncClient,
    base_url: str,
    trace_id: str,
) -> dict[str, Any]:
    response = await client.get(
        f"{base_url.rstrip('/')}/dashboard/traces/{trace_id}",
        params={"serialization": "raw"},
        timeout=180.0,
    )
    response.raise_for_status()
    body = response.json()
    if not isinstance(body, dict) or body.get("ok") is not True:
        raise RuntimeError(f"Trace fetch failed for {trace_id}: {body!r}")
    return body


async def fetch_rlm_run(
    *,
    client: httpx.AsyncClient,
    base_url: str,
    run_id: str,
) -> dict[str, Any]:
    response = await client.get(
        f"{base_url.rstrip('/')}/kernel/rlm/{run_id}",
        params={"includeTrace": "1"},
        timeout=180.0,
    )
    response.raise_for_status()
    body = response.json()
    if not isinstance(body, dict) or body.get("ok") is not True:
        raise RuntimeError(f"RLM run fetch failed for {run_id}: {body!r}")
    return body


def score_row(
    *,
    row: dict[str, Any],
    question: Question,
    response_text: str,
    verify_options: VerifyOptions,
) -> dict[str, Any]:
    row["successful"] = True
    row["response_text"] = response_text

    try:
        row["wrong_formatting"] = extract_solution(response_text) is None
        row["correct"] = bool(verify(question, response_text, options=verify_options))
    except Exception as exc:  # noqa: BLE001
        row["correct"] = False
        row["verification_error"] = str(exc)

    return row


def json_default(value: Any) -> str:
    return repr(value)


def ensure_deno_on_path() -> str | None:
    deno_path = shutil.which("deno")
    if deno_path:
        return deno_path

    candidates = [
        Path(os.environ["LONGCOT_DENO_BIN"]).expanduser()
        for _ in [None]
        if os.environ.get("LONGCOT_DENO_BIN")
    ]
    candidates.append(Path.home() / ".deno" / "bin" / "deno")

    for candidate in candidates:
        if candidate.exists() and os.access(candidate, os.X_OK):
            os.environ["PATH"] = f"{candidate.parent}{os.pathsep}{os.environ.get('PATH', '')}"
            return str(candidate)

    return None


def serialize_dspy_prediction_value(result: Any, field_name: str) -> Any:
    if hasattr(result, field_name):
        return getattr(result, field_name)
    if isinstance(result, dict):
        return result.get(field_name)
    try:
        return result[field_name]
    except Exception:  # noqa: BLE001
        return None


async def run_one_superobjective(
    *,
    client: httpx.AsyncClient,
    base_url: str,
    module_id: str,
    session_prefix: str,
    timeout_s: float | None,
    async_rlm: bool,
    poll_interval_s: float,
    poll_timeout_s: float | None,
    question: Question,
    verify_options: VerifyOptions,
) -> dict[str, Any]:
    started_at = time.perf_counter()
    row: dict[str, Any] = {
        "backend": "superobjective",
        "model": None,
        "question_id": question.question_id,
        "domain": question.domain,
        "difficulty": question.difficulty,
        "successful": False,
    }

    payload = {
        "input": {
            "question_id": question.question_id,
            "domain": question.domain,
            "difficulty": question.difficulty,
            "prompt": question.prompt,
        },
        "sessionId": f"{session_prefix}-{question.question_id}",
    }
    if async_rlm:
        payload["execution"] = {
            "durable": True,
            "background": True,
        }

    try:
        response = await client.post(
            f"{base_url.rstrip('/')}/kernel/rlm/{module_id}",
            json=payload,
            timeout=timeout_s,
        )
    except Exception as exc:  # noqa: BLE001
        row["errors"] = [{"message": str(exc), "type": type(exc).__name__}]
        row["latency_s"] = round(time.perf_counter() - started_at, 3)
        return row

    row["http_status"] = response.status_code
    row["latency_s"] = round(time.perf_counter() - started_at, 3)

    try:
        body = response.json()
    except Exception as exc:  # noqa: BLE001
        row["errors"] = [{"message": f"Non-JSON response: {exc}"}]
        row["response_preview"] = response.text[:500]
        return row

    if response.status_code != 200 or body.get("ok") is not True:
        if response.status_code != 202:
            row["errors"] = [
                {
                    "message": str(body.get("error") or f"HTTP {response.status_code}"),
                    "trace_id": body.get("traceId"),
                }
            ]
            return row

    if body.get("status") == "running" and isinstance(body.get("runId"), str):
        row["run_id"] = body["runId"]
        row["trace_id"] = body.get("traceId") if isinstance(body.get("traceId"), str) else body["runId"]
        try:
            poll_body = await poll_async_rlm_run(
                client=client,
                base_url=base_url,
                run_id=body["runId"],
                poll_interval_s=poll_interval_s,
                poll_timeout_s=poll_timeout_s,
            )
        except Exception as exc:  # noqa: BLE001
            row["errors"] = [
                {
                    "message": str(exc),
                    "type": type(exc).__name__,
                    "trace_id": row.get("trace_id"),
                }
            ]
            row["latency_s"] = round(time.perf_counter() - started_at, 3)
            return row

        run = poll_body.get("run") if isinstance(poll_body, dict) else None
        if not isinstance(run, dict):
            row["errors"] = [{"message": "RLM poll response did not contain a run object"}]
            row["latency_s"] = round(time.perf_counter() - started_at, 3)
            return row

        row["latency_s"] = round(time.perf_counter() - started_at, 3)
        if isinstance(run.get("traceId"), str):
            row["trace_id"] = run["traceId"]
        if run.get("status") == "failed":
            row["errors"] = [
                {
                    "message": str((run.get("error") or {}).get("message") if isinstance(run.get("error"), dict) else run.get("error")),
                    "trace_id": row.get("trace_id"),
                }
            ]
            return row

        body = {
            "ok": True,
            "output": run.get("output"),
            "traceId": run.get("traceId") or row.get("trace_id"),
        }
    elif response.status_code != 200 or body.get("ok") is not True:
        row["errors"] = [
            {
                "message": str(body.get("error") or f"HTTP {response.status_code}"),
                "trace_id": body.get("traceId"),
            }
        ]
        return row

    response_text = response_text_from_payload(body)
    if response_text is None:
        row["errors"] = [{"message": "RLM response did not contain output.response_text"}]
        row["trace_id"] = body.get("traceId")
        row["output"] = body.get("output")
        return row

    if isinstance(body.get("traceId"), str):
        row["trace_id"] = body["traceId"]

    return score_row(
        row=row,
        question=question,
        response_text=response_text,
        verify_options=verify_options,
    )


def run_one_dspy_rlm_sync(
    *,
    question: Question,
    verify_options: VerifyOptions,
    dspy_model: str,
    dspy_api_base: str | None,
    dspy_api_key_env: str | None,
    dspy_max_iterations: int,
    dspy_max_llm_calls: int,
    dspy_max_output_chars: int,
    traces_dir: Path,
) -> dict[str, Any]:
    started_at = time.perf_counter()
    row: dict[str, Any] = {
        "backend": "dspy-rlm",
        "model": dspy_model,
        "question_id": question.question_id,
        "domain": question.domain,
        "difficulty": question.difficulty,
        "successful": False,
    }

    deno_path = ensure_deno_on_path()
    if deno_path is None:
        row["errors"] = [
            {
                "message": "DSPy.RLM requires Deno, but no deno executable was found on PATH or at ~/.deno/bin/deno.",
            }
        ]
        row["latency_s"] = round(time.perf_counter() - started_at, 3)
        return row
    row["deno_path"] = deno_path

    try:
        import dspy
    except Exception as exc:  # noqa: BLE001
        row["errors"] = [{"message": f"Could not import DSPy: {exc}", "type": type(exc).__name__}]
        row["latency_s"] = round(time.perf_counter() - started_at, 3)
        return row

    lm_kwargs: dict[str, Any] = {}
    if dspy_api_base:
        lm_kwargs["api_base"] = dspy_api_base
    if dspy_api_key_env:
        api_key = os.environ.get(dspy_api_key_env)
        if not api_key:
            row["errors"] = [{"message": f"Environment variable {dspy_api_key_env} is not set."}]
            row["latency_s"] = round(time.perf_counter() - started_at, 3)
            return row
        lm_kwargs["api_key"] = api_key

    try:
        lm = dspy.LM(dspy_model, **lm_kwargs)
        dspy.configure(lm=lm)

        class LongCoTSolve(dspy.Signature):
            """Solve a LongCoT problem.

            The prompt already contains the full problem statement and the answer
            format requirement. Return the final response text exactly as it
            should be passed to the official LongCoT verifier, including the
            required solution = ... line.
            """

            prompt: str = dspy.InputField(
                desc="Full LongCoT problem prompt with answer-format instructions"
            )
            response_text: str = dspy.OutputField(
                desc="Full final response containing the required solution = ... line"
            )

        rlm = dspy.RLM(
            LongCoTSolve,
            max_iterations=dspy_max_iterations,
            max_llm_calls=dspy_max_llm_calls,
            max_output_chars=dspy_max_output_chars,
            sub_lm=lm,
        )
        result = rlm(prompt=question.prompt)
    except Exception as exc:  # noqa: BLE001
        row["errors"] = [{"message": str(exc), "type": type(exc).__name__}]
        row["latency_s"] = round(time.perf_counter() - started_at, 3)
        return row

    row["latency_s"] = round(time.perf_counter() - started_at, 3)

    trajectory = serialize_dspy_prediction_value(result, "trajectory")
    if trajectory is not None:
        trajectory_path = traces_dir / f"dspy-rlm-{safe_filename_token(question.question_id)}.trajectory.json"
        trajectory_path.write_text(
            json.dumps(
                {
                    "backend": "dspy-rlm",
                    "model": dspy_model,
                    "question_id": question.question_id,
                    "domain": question.domain,
                    "difficulty": question.difficulty,
                    "trajectory": trajectory,
                },
                indent=2,
                ensure_ascii=True,
                default=json_default,
            )
            + "\n",
            encoding="utf-8",
        )
        row["trajectory_path"] = str(trajectory_path)

    response_text = serialize_dspy_prediction_value(result, "response_text")
    if not isinstance(response_text, str) or not response_text.strip():
        row["errors"] = [{"message": "DSPy RLM response did not contain response_text"}]
        row["output"] = result
        return row

    return score_row(
        row=row,
        question=question,
        response_text=response_text.strip(),
        verify_options=verify_options,
    )


def build_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    def summarize(subset: list[dict[str, Any]]) -> dict[str, Any]:
        total = len(subset)
        correct = sum(1 for row in subset if row.get("successful") and row.get("correct") is True)
        incorrect = sum(
            1 for row in subset if row.get("successful") and row.get("correct") is not True
        )
        failed = sum(1 for row in subset if not row.get("successful"))
        wrong_formatting = sum(
            1
            for row in subset
            if row.get("successful") and row.get("wrong_formatting") is True
        )
        return {
            "total": total,
            "correct": correct,
            "incorrect": incorrect,
            "failed": failed,
            "wrong_formatting": wrong_formatting,
            "accuracy": correct / (correct + incorrect) if (correct + incorrect) else 0.0,
            "overall_accuracy": correct / total if total else 0.0,
        }

    def grouped_summary(key: str) -> dict[str, Any]:
        breakdown: dict[str, dict[str, Any]] = defaultdict(lambda: Counter())
        for row in rows:
            bucket = breakdown[str(row.get(key) or "unknown")]
            bucket["total"] += 1
            if row.get("successful"):
                bucket["verified"] += 1
                if row.get("correct") is True:
                    bucket["correct"] += 1
                else:
                    bucket["incorrect"] += 1
                if row.get("wrong_formatting") is True:
                    bucket["wrong_formatting"] += 1
            else:
                bucket["failed"] += 1

        def finalize(bucket: dict[str, Any]) -> dict[str, Any]:
            total_items = int(bucket.get("total", 0))
            verified = int(bucket.get("verified", 0))
            correct_items = int(bucket.get("correct", 0))
            return {
                **{key: int(value) for key, value in bucket.items()},
                "accuracy": correct_items / verified if verified else 0.0,
                "overall_accuracy": correct_items / total_items if total_items else 0.0,
            }

        return {key: finalize(value) for key, value in sorted(breakdown.items())}

    backend_names = sorted({str(row.get("backend") or "unknown") for row in rows})
    return {
        **summarize(rows),
        "by_backend": {
            backend: summarize([row for row in rows if str(row.get("backend") or "unknown") == backend])
            for backend in backend_names
        },
        "by_domain": grouped_summary("domain"),
        "by_difficulty": grouped_summary("difficulty"),
    }


async def run_benchmark(args: argparse.Namespace) -> int:
    questions = load_benchmark_questions(
        domain=args.domain,
        difficulty=args.difficulty,
        max_questions=args.max_questions,
        question_id=args.question_id,
    )
    verify_options = build_verify_options(args.enable_fallback)
    base_url = args.base_url.rstrip("/")
    active_backends = (
        ["superobjective", "dspy-rlm"] if args.backend == "both" else [args.backend]
    )

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = output_stem(
        backend=args.backend,
        module_id=args.module_id,
        dspy_model=args.dspy_model,
        domain=args.domain,
        difficulty=args.difficulty,
    )
    responses_path = output_dir / f"{stem}.jsonl"
    summary_path = output_dir / f"{stem}.summary.json"
    traces_dir = output_dir / f"{stem}.traces"
    traces_dir.mkdir(parents=True, exist_ok=True)

    targets = []
    if "superobjective" in active_backends:
        targets.append(f"superobjective:{base_url}/kernel/rlm/{args.module_id}")
    if "dspy-rlm" in active_backends:
        targets.append(f"dspy-rlm:{args.dspy_model}")
    print(f"Running LongCoT benchmark against {', '.join(targets)} for {len(questions)} questions.")
    print(
        f"Domain={args.domain or 'all'} Difficulty={args.difficulty or 'all'} "
        f"Concurrency={args.concurrency} Fallback={'on' if args.enable_fallback else 'off'}"
    )

    rows: list[dict[str, Any]] = []
    semaphore = asyncio.Semaphore(args.concurrency)
    jobs = [(backend, question) for question in questions for backend in active_backends]

    async with httpx.AsyncClient(follow_redirects=True) as client:
        async def worker(backend: str, question: Question) -> dict[str, Any]:
            async with semaphore:
                if backend == "superobjective":
                    row = await run_one_superobjective(
                        client=client,
                        base_url=base_url,
                        module_id=args.module_id,
                        session_prefix=args.session_prefix,
                        timeout_s=args.timeout_s,
                        async_rlm=not args.sync_rlm,
                        poll_interval_s=args.poll_interval_s,
                        poll_timeout_s=args.poll_timeout_s,
                        question=question,
                        verify_options=verify_options,
                    )
                else:
                    row = await asyncio.to_thread(
                        run_one_dspy_rlm_sync,
                        question=question,
                        verify_options=verify_options,
                        dspy_model=args.dspy_model,
                        dspy_api_base=args.dspy_api_base,
                        dspy_api_key_env=args.dspy_api_key_env,
                        dspy_max_iterations=args.dspy_max_iterations,
                        dspy_max_llm_calls=args.dspy_max_llm_calls,
                        dspy_max_output_chars=args.dspy_max_output_chars,
                        traces_dir=traces_dir,
                    )
                status = "failed"
                if row.get("successful"):
                    status = "correct" if row.get("correct") is True else "incorrect"
                print(
                    f"[{backend} {question.domain}/{question.difficulty}] "
                    f"{question.question_id}: {status}"
                    + (f" ({row['latency_s']}s)" if "latency_s" in row else "")
                )
                return row

        for completed in asyncio.as_completed([worker(backend, question) for backend, question in jobs]):
            rows.append(await completed)

        trace_paths: dict[str, str] = {}
        rlm_run_paths: dict[str, str] = {}
        for row in rows:
            run_id = row.get("run_id")
            if isinstance(run_id, str) and run_id not in rlm_run_paths:
                rlm_run_path = traces_dir / f"{run_id}.rlm-run.json"
                try:
                    rlm_run_body = await fetch_rlm_run(
                        client=client,
                        base_url=base_url,
                        run_id=run_id,
                    )
                    rlm_run_path.write_text(
                        json.dumps(rlm_run_body, indent=2, ensure_ascii=True) + "\n",
                        encoding="utf-8",
                    )
                    rlm_run_paths[run_id] = str(rlm_run_path)
                except Exception as exc:  # noqa: BLE001
                    rlm_run_paths[run_id] = f"ERROR: {type(exc).__name__}: {exc}"

            trace_id = row.get("trace_id")
            if not isinstance(trace_id, str) or trace_id in trace_paths:
                continue

            trace_path = traces_dir / f"{trace_id}.json"
            try:
                trace_body = await fetch_trace(
                    client=client,
                    base_url=base_url,
                    trace_id=trace_id,
                )
                trace_path.write_text(
                    json.dumps(trace_body, indent=2, ensure_ascii=True) + "\n",
                    encoding="utf-8",
                )
                trace_paths[trace_id] = str(trace_path)
            except Exception as exc:  # noqa: BLE001
                trace_paths[trace_id] = f"ERROR: {type(exc).__name__}: {exc}"

        for row in rows:
            run_id = row.get("run_id")
            if isinstance(run_id, str) and run_id in rlm_run_paths:
                row["rlm_run_path"] = rlm_run_paths[run_id]
            trace_id = row.get("trace_id")
            if isinstance(trace_id, str) and trace_id in trace_paths:
                row["trace_path"] = trace_paths[trace_id]

    rows.sort(key=lambda row: (row["domain"], row["difficulty"], row["question_id"], row["backend"]))
    with responses_path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=True, default=json_default) + "\n")

    summary = build_summary(rows)
    summary["backend"] = args.backend
    summary["backends"] = active_backends
    summary["base_url"] = base_url
    summary["module_id"] = args.module_id
    summary["dspy_model"] = args.dspy_model
    summary["responses_path"] = str(responses_path)
    summary["traces_dir"] = str(traces_dir)
    summary["trace_paths"] = sorted(
        value for value in {row.get("trace_path") for row in rows} if isinstance(value, str)
    )
    summary["rlm_run_paths"] = sorted(
        value for value in {row.get("rlm_run_path") for row in rows} if isinstance(value, str)
    )
    summary["trajectory_paths"] = sorted(
        value for value in {row.get("trajectory_path") for row in rows} if isinstance(value, str)
    )
    summary["questions_run"] = len(questions)

    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")

    print("")
    print(json.dumps(summary, indent=2))
    print(f"\nWrote responses to {responses_path}")
    print(f"Wrote summary to {summary_path}")
    print(f"Wrote traces to {traces_dir}")
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    def parse_timeout(value: str) -> float | None:
        lowered = value.strip().lower()
        if lowered in {"none", "off", "disabled", "disable", "infinite", "inf", "0"}:
            return None
        parsed = float(value)
        if parsed <= 0:
            return None
        return parsed

    parser = argparse.ArgumentParser(
        description="Run the official LongCoT benchmark against Superobjective RLM, DSPy.RLM, or both.",
    )
    parser.add_argument(
        "--backend",
        choices=BACKENDS,
        default="superobjective",
        help="Benchmark backend. Default keeps the existing Superobjective RLM route behavior.",
    )
    parser.add_argument("--base-url", default=default_base_url(), help="Worker base URL.")
    parser.add_argument(
        "--module-id",
        default="solve_longcot_question",
        help="RLM module id exposed at /kernel/rlm/:moduleId.",
    )
    parser.add_argument("--domain", choices=DOMAINS)
    parser.add_argument("--difficulty", choices=DIFFICULTIES)
    parser.add_argument("--max-questions", type=int)
    parser.add_argument("--question-id")
    parser.add_argument(
        "--timeout-s",
        type=parse_timeout,
        default=None,
        help="Initial POST HTTP timeout in seconds. Default is disabled. Use 0 or none to disable explicitly.",
    )
    parser.add_argument(
        "--poll-timeout-s",
        type=parse_timeout,
        default=None,
        help="Total async RLM polling timeout in seconds. Default is disabled.",
    )
    parser.add_argument(
        "--poll-interval-s",
        type=float,
        default=5.0,
        help="Polling interval for async RLM runs.",
    )
    parser.add_argument(
        "--sync-rlm",
        action="store_true",
        help="Use the legacy synchronous RLM POST instead of durable background execution.",
    )
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--session-prefix", default="longcot")
    parser.add_argument(
        "--dspy-model",
        default=os.environ.get("LONGCOT_DSPY_MODEL"),
        help="DSPy LM model name, e.g. openai/gpt-5 or anthropic/claude-sonnet-4-5. Defaults to LONGCOT_DSPY_MODEL.",
    )
    parser.add_argument(
        "--dspy-api-base",
        default=os.environ.get("LONGCOT_DSPY_API_BASE"),
        help="Optional API base passed to dspy.LM. Defaults to LONGCOT_DSPY_API_BASE.",
    )
    parser.add_argument(
        "--dspy-api-key-env",
        default=os.environ.get("LONGCOT_DSPY_API_KEY_ENV"),
        help="Optional environment variable name whose value is passed to dspy.LM as api_key.",
    )
    parser.add_argument(
        "--dspy-max-iterations",
        type=int,
        default=50,
        help="Maximum DSPy.RLM REPL iterations.",
    )
    parser.add_argument(
        "--dspy-max-llm-calls",
        type=int,
        default=50,
        help="Maximum DSPy.RLM llm_query/llm_query_batched calls.",
    )
    parser.add_argument(
        "--dspy-max-output-chars",
        type=int,
        default=10_000,
        help="Maximum characters from REPL output passed back into DSPy.RLM.",
    )
    parser.add_argument(
        "--output-dir",
        default="benchmarks/longcot/results",
        help="Directory for JSONL outputs and summary JSON.",
    )
    parser.add_argument(
        "--enable-fallback",
        action="store_true",
        help="Enable official LongCoT math/chemistry fallback judges. Disabled by default.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.concurrency < 1:
        raise SystemExit("--concurrency must be at least 1")
    if args.backend in {"dspy-rlm", "both"} and not args.dspy_model:
        raise SystemExit(
            "--dspy-model or LONGCOT_DSPY_MODEL is required when --backend uses dspy-rlm."
        )
    if args.dspy_max_iterations < 1:
        raise SystemExit("--dspy-max-iterations must be at least 1")
    if args.dspy_max_llm_calls < 1:
        raise SystemExit("--dspy-max-llm-calls must be at least 1")
    if args.dspy_max_output_chars < 1:
        raise SystemExit("--dspy-max-output-chars must be at least 1")
    return asyncio.run(run_benchmark(args))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
