"""The evaluation framework's own test: the harness runs end to end against the mock engine, with no GPU,
no model, and no downloads (the repo's test convention).

    python -m unittest evals.test_eval
"""
import tempfile
import unittest
from pathlib import Path

from evals import run_eval


def good_reply() -> dict:
    return {"id": "x", "object": "chat.completion", "created": 1, "model": "eval",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "Paris"},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13}}


class Queries(unittest.TestCase):
    def test_the_queries_file_parses(self):
        queries = run_eval.load_queries(run_eval.QUERIES)
        self.assertGreaterEqual(len(queries), 5)
        ids = [q["id"] for q in queries]
        self.assertEqual(len(ids), len(set(ids)), "query ids must be unique")
        for q in queries:
            self.assertTrue(q["prompt"].strip())
            self.assertTrue(q.get("mock_answer"), f"{q['id']}: the mock run needs a mock_answer")
            self.assertTrue(q.get("expect_all") or q.get("expect_any"), f"{q['id']}: needs keywords")

    def test_a_line_without_a_prompt_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "q.jsonl"
            p.write_text('{"id": "x"}\n', encoding="utf-8")
            with self.assertRaises(ValueError):
                run_eval.load_queries(p)


class Metrics(unittest.TestCase):
    def test_a_well_formed_reply_has_no_problems(self):
        self.assertEqual(run_eval.check_format(good_reply()), [])

    def test_a_missing_usage_is_a_format_problem(self):
        reply = good_reply()
        del reply["usage"]
        self.assertIn("usage is missing", run_eval.check_format(reply))

    def test_a_non_assistant_message_is_a_format_problem(self):
        reply = good_reply()
        reply["choices"][0]["message"]["role"] = "user"
        self.assertTrue(any("role" in p for p in run_eval.check_format(reply)))

    def test_relevance_counts_every_expected_keyword(self):
        q = {"expect_all": ["Paris", "capital"], "expect_any": ["France"]}
        self.assertEqual(run_eval.relevance("The capital of France is Paris.", q), 1.0)
        self.assertEqual(run_eval.relevance("The capital is Paris.", q), 2 / 3)

    def test_expect_any_needs_one_of_its_keywords(self):
        q = {"expect_any": ["Mars", "Venus"]}
        self.assertEqual(run_eval.relevance("Mercury, Venus, Earth", q), 1.0)
        self.assertEqual(run_eval.relevance("Mercury, Earth, Neptune", q), 0.0)


class EndToEnd(unittest.TestCase):
    def test_the_mock_run_passes_every_query(self):
        queries = run_eval.load_queries(run_eval.QUERIES)
        httpd, base = run_eval.start_mock_server(queries, repeats=2)
        try:
            report = run_eval.evaluate(base, queries, timeout=60, repeats=2, min_relevance=1.0)
        finally:
            httpd.shutdown()
            httpd.server_close()
        self.assertEqual(report["summary"]["failed"], 0,
                         msg=str([r for r in report["rows"] if not r["pass"]]))
        self.assertEqual(report["summary"]["passed"], len(queries))
        for row in report["rows"]:
            self.assertTrue(row["format_ok"], f"{row['id']}: {row['problems']}")
            self.assertEqual(row["relevance"], 1.0, f"{row['id']}: {row['content']!r}")
            self.assertGreater(row["tok_s"], 0)

    def test_main_writes_a_report_and_exits_zero(self):
        with tempfile.TemporaryDirectory() as d:
            code = run_eval.main(["--out", d, "--repeats", "2"])
            self.assertEqual(code, 0)
            reports = list(Path(d).glob("eval-*.json"))
            self.assertEqual(len(reports), 1)
            import json
            report = json.loads(reports[0].read_text(encoding="utf-8"))
            self.assertEqual(report["summary"]["passed"], report["queries"])

    def test_a_query_the_server_cannot_answer_fails_the_run(self):
        queries = [{"id": "needs-a-number", "prompt": "Answer with the number 42.",
                    "expect_all": ["42"], "mock_answer": "I am not sure."}]
        httpd, base = run_eval.start_mock_server(queries, repeats=1)
        try:
            report = run_eval.evaluate(base, queries, timeout=60, repeats=1, min_relevance=1.0)
        finally:
            httpd.shutdown()
            httpd.server_close()
        self.assertEqual(report["summary"]["failed"], 1)
        self.assertEqual(report["rows"][0]["relevance"], 0.0)

    def test_min_relevance_is_the_keyword_gate(self):
        # half the keywords covered: fails at the default 1.0, passes when the gate is lowered to 0.5
        queries = [{"id": "two-planets", "prompt": "Name two planets.",
                    "expect_all": ["Mars", "Venus"], "mock_answer": "Mars is a planet."}]
        for gate, failed in ((1.0, 1), (0.5, 0)):
            httpd, base = run_eval.start_mock_server(queries, repeats=1)
            try:
                report = run_eval.evaluate(base, queries, timeout=60, repeats=1, min_relevance=gate)
            finally:
                httpd.shutdown()
                httpd.server_close()
            self.assertEqual(report["rows"][0]["relevance"], 0.5)
            self.assertEqual(report["summary"]["failed"], failed,
                             f"gate {gate}: {report['rows'][0]}")


if __name__ == "__main__":
    unittest.main()
