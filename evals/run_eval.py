#!/usr/bin/env python3
"""Evaluation harness for Strata's server: every query in evals/queries.jsonl goes through
/v1/chat/completions, and three metrics are measured per query:

- format:    the reply is a valid OpenAI chat.completion (choices, message, usage; the shape clients rely on)
- relevance: the reply contains the keywords the query expects (expect_all: every one, expect_any: at least one)
- time:      wall seconds per request, and tokens/s from the server's own timings (real engine) or usage (mock)

Run it against the mock engine (no GPU, no model, no downloads - the repo's test convention):

    python evals/run_eval.py                      # starts the mock server on a free port, scores, stops it

Against a running server (the real model):

    python evals/run_eval.py --base http://127.0.0.1:8095 [--api-key KEY]

Options: --queries FILE (default evals/queries.jsonl), --out DIR (default evals/results), --repeats N
(median of N runs per query, default 1), --min-relevance F (default 1.0), --timeout S (default 120).
Exit code 0 when every query passes all three, 1 otherwise - usable as a CI gate. The report is
evals/results/eval-<utc>.json with one row per query.

The mock answers in queries.jsonl are what the mock engine replays, so the mock run checks the server's
plumbing (API shape, streaming, token counts, timing) end to end; a real-model run checks the model's answers
against the same keywords.
"""
import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

QUERIES = Path(__file__).resolve().parent / "queries.jsonl"
FINISH_REASONS = ("stop", "length", "tool_calls")


def load_queries(path: Path) -> list[dict]:
    """One JSON object per line: id, prompt, expect_all, expect_any, mock_answer, optional max_tokens/max_s."""
    out = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        q = json.loads(line)
        if "id" not in q or "prompt" not in q:
            raise ValueError(f"{path}:{n}: a query needs an id and a prompt")
        out.append(q)
    if not out:
        raise ValueError(f"{path}: no queries")
    return out


def http_post(url: str, body: dict, timeout: float, api_key: str = "") -> dict:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"HTTP {e.code}: {detail}") from e


def check_format(reply: dict) -> list[str]:
    """Problems with the OpenAI chat.completion shape the clients rely on; [] when it is well-formed."""
    problems = []
    if reply.get("object") != "chat.completion":
        problems.append(f"object is {reply.get('object')!r}, not 'chat.completion'")
    for key in ("id", "created", "model"):
        if key not in reply:
            problems.append(f"{key} is missing")
    choices = reply.get("choices")
    if not isinstance(choices, list) or not choices:
        problems.append("choices is not a non-empty list")
        return problems
    msg = choices[0].get("message")
    if not isinstance(msg, dict):
        problems.append("choices[0].message is missing")
    elif msg.get("role") != "assistant":
        problems.append(f"message.role is {msg.get('role')!r}, not 'assistant'")
    elif not isinstance(msg.get("content"), str):
        problems.append("message.content is not a string")
    if choices[0].get("finish_reason") not in FINISH_REASONS:
        problems.append(f"finish_reason is {choices[0].get('finish_reason')!r}")
    usage = reply.get("usage")
    if not isinstance(usage, dict):
        problems.append("usage is missing")
    else:
        for key in ("prompt_tokens", "completion_tokens"):
            if not isinstance(usage.get(key), int) or usage[key] < 0:
                problems.append(f"usage.{key} is not a non-negative int")
    return problems


def relevance(text: str, q: dict) -> float:
    """The share of the query's expected keywords the reply contains (case-insensitive).
    expect_all: every keyword counts; expect_any: one found keyword counts as all of them."""
    need = list(q.get("expect_all") or [])
    any_of = list(q.get("expect_any") or [])
    lowered = text.lower()
    matched = sum(1 for k in need if k.lower() in lowered)
    if any_of:
        matched += 1 if any(k.lower() in lowered for k in any_of) else 0
    total = len(need) + (1 if any_of else 0)
    return 1.0 if total == 0 else matched / total


def score_query(base: str, q: dict, timeout: float, repeats: int, api_key: str) -> dict:
    """Run one query `repeats` times; the first reply is scored for format/relevance, the median wall time is kept."""
    walls, tok_s, reply, error = [], None, None, None
    for _ in range(max(1, repeats)):
        body = {"model": "eval", "messages": [{"role": "user", "content": q["prompt"]}],
                "max_tokens": q.get("max_tokens", 256), "temperature": 0, "stream": False}
        t0 = time.perf_counter()
        try:
            reply = http_post(base + "/v1/chat/completions", body, timeout, api_key)
        except (RuntimeError, OSError, ValueError) as e:
            error = str(e)
            break
        wall = time.perf_counter() - t0
        walls.append(wall)
        usage = reply.get("usage") or {}
        timings = reply.get("timings") or {}
        n = usage.get("completion_tokens") or 0
        tok_s = timings.get("predicted_per_second") or (n / wall if wall > 0 and n else None)
    if error is not None:
        return {"id": q["id"], "pass": False, "error": error, "wall_s": None, "tok_s": None,
                "relevance": 0.0, "format_ok": False, "problems": [error], "content": None}
    content = ((reply.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    problems = check_format(reply)
    rel = relevance(content, q)
    wall = statistics.median(walls)
    limit = q.get("max_s", timeout)
    row = {"id": q["id"], "wall_s": round(wall, 4), "tok_s": round(tok_s, 1) if tok_s else None,
           "relevance": round(rel, 3), "format_ok": not problems, "problems": problems,
           "content": content[:200], "pass": not problems and rel >= 1.0 - 1e-9 and wall <= limit}
    if problems or rel < 1.0 - 1e-9:
        row["pass"] = not problems and rel >= 1.0 - 1e-9 and wall <= limit
    return row


def evaluate(base: str, queries: list[dict], timeout: float, repeats: int,
             min_relevance: float, api_key: str = "") -> dict:
    rows = []
    for q in queries:
        row = score_query(base, q, timeout, repeats, api_key)
        row["pass"] = row["pass"] and row["relevance"] >= min_relevance
        rows.append(row)
    walls = [r["wall_s"] for r in rows if r["wall_s"] is not None]
    passed = sum(1 for r in rows if r["pass"])
    return {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "base": base,
        "queries": len(rows),
        "repeats": repeats,
        "thresholds": {"min_relevance": min_relevance, "timeout_s": timeout},
        "summary": {
            "passed": passed,
            "failed": len(rows) - passed,
            "median_wall_s": round(statistics.median(walls), 4) if walls else None,
            "max_wall_s": round(max(walls), 4) if walls else None,
            "min_relevance": min((r["relevance"] for r in rows), default=None),
        },
        "rows": rows,
    }


def start_mock_server(queries: list[dict], repeats: int):
    """The mock engine replaying each query's mock_answer: MockEngine hands every request the next
    script, so each answer sits `repeats` times in a row (score_query makes repeats requests per
    query, and the last reply is the scored one; when the scripts run out, the last one repeats).

    Each script starts with the think-close, as every serve test script does (serve/test_server.py):
    the chat template opens the model's think block, so without it the whole mock answer
    lands in reasoning_content and message.content comes back null."""
    from serve.frontend import ChatTemplate, THINK_END
    from serve.server import ByteTokenizer, MockEngine, Service, ROOT as SERVER_ROOT, serve
    tok = ByteTokenizer()
    close = THINK_END + "\n\n"        # the template opens the think block: the script closes it first
    scripts = [close + answer for q in queries
               for answer in [q.get("mock_answer", f"answer to {q['id']}")] * max(1, repeats)]
    engine = MockEngine(tok, scripts, max_context=8192)
    tpl = SERVER_ROOT / "serve" / "chat_template.jinja"
    svc = Service(engine, tok, ChatTemplate(tpl if tpl.exists() else SERVER_ROOT / "serve/chat_template.jinja"))
    httpd = serve(svc, port=0)
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    return httpd, base


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", help="a running server, e.g. http://127.0.0.1:8095 (default: start the mock engine)")
    ap.add_argument("--queries", default=str(QUERIES), help="the queries file (default evals/queries.jsonl)")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "results"), help="report directory")
    ap.add_argument("--repeats", type=int, default=1, help="runs per query, median kept (default 1)")
    ap.add_argument("--timeout", type=float, default=120.0, help="seconds per request (default 120)")
    ap.add_argument("--min-relevance", type=float, default=1.0, help="keyword coverage a query needs (default 1.0)")
    ap.add_argument("--api-key", default="", help="Bearer key for a server that requires one")
    a = ap.parse_args(argv)

    queries = load_queries(Path(a.queries))
    httpd = None
    base = a.base
    try:
        if not base:
            httpd, base = start_mock_server(queries, max(1, a.repeats))
            print(f"[eval] mock server on {base}", flush=True)
        report = evaluate(base, queries, a.timeout, max(1, a.repeats), a.min_relevance, a.api_key)
    finally:
        if httpd is not None:
            httpd.shutdown()
            httpd.server_close()

    out_dir = Path(a.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    name = out_dir / ("eval-%s.json" % report["generated"].replace(":", "").replace("+0000", "Z"))
    name.write_text(json.dumps(report, indent=1), encoding="utf-8")

    print(f"{'query':22} {'format':7} {'relevance':9} {'wall_s':8} {'tok_s':7} pass", flush=True)
    for r in report["rows"]:
        print(f"{r['id']:22} {'ok' if r['format_ok'] else 'FAIL':7} {r['relevance']:9.2f} "
              f"{(r['wall_s'] if r['wall_s'] is not None else 0):8.3f} "
              f"{(r['tok_s'] if r['tok_s'] is not None else 0):7.1f} {'yes' if r['pass'] else 'NO'}", flush=True)
        for p in r["problems"]:
            print(f"  {r['id']}: {p}", flush=True)
    s = report["summary"]
    print(f"[eval] {s['passed']}/{report['queries']} passed; median wall {s['median_wall_s']} s; "
          f"report {name}", flush=True)
    return 0 if s["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
