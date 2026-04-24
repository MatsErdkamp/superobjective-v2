#!/usr/bin/env -S uv run --python 3.12
# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = [
#   "httpx>=0.28,<1",
#   "longcot @ git+https://github.com/LongHorizonReasoning/longcot.git",
# ]
# ///

from __future__ import annotations

import argparse
import asyncio
import json
import os
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


def output_stem(module_id: str, domain: str | None, difficulty: str | None) -> str:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    safe_module = module_id.replace("/", "_")
    safe_domain = domain or "all"
    safe_difficulty = difficulty or "all"
    return f"{safe_module}_{safe_domain}_{safe_difficulty}_{stamp}"


async def run_one(
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

    row["successful"] = True
    row["response_text"] = response_text
    if isinstance(body.get("traceId"), str):
        row["trace_id"] = body["traceId"]

    try:
        row["wrong_formatting"] = extract_solution(response_text) is None
        row["correct"] = bool(verify(question, response_text, options=verify_options))
    except Exception as exc:  # noqa: BLE001
        row["correct"] = False
        row["verification_error"] = str(exc)

    return row


def build_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(rows)
    correct = sum(1 for row in rows if row.get("successful") and row.get("correct") is True)
    incorrect = sum(1 for row in rows if row.get("successful") and row.get("correct") is not True)
    failed = sum(1 for row in rows if not row.get("successful"))
    wrong_formatting = sum(
        1 for row in rows if row.get("successful") and row.get("wrong_formatting") is True
    )

    domain_breakdown: dict[str, dict[str, Any]] = defaultdict(lambda: Counter())
    difficulty_breakdown: dict[str, dict[str, Any]] = defaultdict(lambda: Counter())

    for row in rows:
        domain_bucket = domain_breakdown[row["domain"]]
        difficulty_bucket = difficulty_breakdown[row["difficulty"]]
        for bucket in (domain_bucket, difficulty_bucket):
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

    return {
        "total": total,
        "correct": correct,
        "incorrect": incorrect,
        "failed": failed,
        "wrong_formatting": wrong_formatting,
        "accuracy": correct / (correct + incorrect) if (correct + incorrect) else 0.0,
        "overall_accuracy": correct / total if total else 0.0,
        "by_domain": {key: finalize(value) for key, value in sorted(domain_breakdown.items())},
        "by_difficulty": {
            key: finalize(value) for key, value in sorted(difficulty_breakdown.items())
        },
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

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = output_stem(args.module_id, args.domain, args.difficulty)
    responses_path = output_dir / f"{stem}.jsonl"
    summary_path = output_dir / f"{stem}.summary.json"

    print(
        f"Running LongCoT benchmark against {base_url}/kernel/rlm/{args.module_id} "
        f"for {len(questions)} questions."
    )
    print(
        f"Domain={args.domain or 'all'} Difficulty={args.difficulty or 'all'} "
        f"Concurrency={args.concurrency} Fallback={'on' if args.enable_fallback else 'off'}"
    )

    rows: list[dict[str, Any]] = []
    semaphore = asyncio.Semaphore(args.concurrency)

    async with httpx.AsyncClient(follow_redirects=True) as client:
        async def worker(question: Question) -> dict[str, Any]:
            async with semaphore:
                row = await run_one(
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
                status = "failed"
                if row.get("successful"):
                    status = "correct" if row.get("correct") is True else "incorrect"
                print(
                    f"[{question.domain}/{question.difficulty}] {question.question_id}: {status}"
                    + (f" ({row['latency_s']}s)" if "latency_s" in row else "")
                )
                return row

        for completed in asyncio.as_completed([worker(question) for question in questions]):
            rows.append(await completed)

    rows.sort(key=lambda row: (row["domain"], row["difficulty"], row["question_id"]))
    with responses_path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=True) + "\n")

    summary = build_summary(rows)
    summary["base_url"] = base_url
    summary["module_id"] = args.module_id
    summary["responses_path"] = str(responses_path)
    summary["questions_run"] = len(questions)

    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")

    print("")
    print(json.dumps(summary, indent=2))
    print(f"\nWrote responses to {responses_path}")
    print(f"Wrote summary to {summary_path}")
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
        description="Run the official LongCoT benchmark against the Superobjective RLM route.",
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
    return asyncio.run(run_benchmark(args))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
