# Security scan log (local, not version controlled)

Running log for the scheduled security review. Read this before each scan; do not
re-report anything listed here; append new validated findings after each run. Only
findings with a full attack path (attacker, input they control, route to the
vulnerable code, concrete impact) belong here.

## Findings

- **F-1 (medium, confidentiality): a trace carries conversation text when the request ends in a
  structured-output validation error.** SECURITY.md:43-45 promises that with tracing on and the
  Monitor off "a trace carries no conversation text". It does not hold.
  - Route: `serve/structured.py:217` builds the message from jsonschema's own text, which quotes
    the model's value verbatim (`model output failed the JSON Schema at /note: '<the answer>' is
    not of type 'integer'`) -> `serve/server.py:4720` (non-stream 502), `:5013` (SSE error frame),
    `:5075`/`:5111` (Responses API) put it in the error body -> `_json` records it as
    `record["error"]` (`server.py:4446-4448`, recorded for every request, monitor-independent) ->
    `serve/tracing.py:192-194` emits it as the root span's `exception.message` (first 2000 chars)
    -> the exporter POSTs it to the operator's OTLP endpoint.
  - Attacker / impact: (a) whoever reads the collector - a shared team Jaeger/Tempo, a hosted APM
    - sees up to 2000 characters of the model's answer per failed request, which is exactly the
    text the promise says never leaves the process; (b) a prompt-injected document can steer the
    answer into a field whose type fails validation, which turns the collector into an
    exfiltration channel for text the injected content chose.
  - Measured (this machine, Python 3.15.0rc1, venv, `jsonschema` installed, tracing on,
    `api_monitor` off, MockEngine, collector on a random 127.0.0.1 port):
    `c:\Users\Public\scan6_e2e.py` -> HTTP 502 and the exported payload contains
    `SECRET-CARD-4111-1111-1111-1232`; `c:\Users\Public\scan6_stream.py` -> same via the SSE
    error frame. `c:\Users\Public\scan6_size.py`: a 2600-char answer is quoted whole (message
    3673 chars, truncated to 2000 in the span).
  - Same route carries attacker-supplied request text: `c:\Users\Public\scan6_marker.py` sent
    `"max_tokens": "ATTACKER-MARKER-<b>x</b>-4111-1111"`, the 400 body's `str(e)` was recorded
    and appeared in the exported span. Any client that may call `/v1` can write arbitrary text
    into the collector's spans.
  - Suggested fix (not applied): in `tracing.py:192-194` drop `exception.message` and keep only
    the server-authored category (`exception.type` = the error's `type`/`code`), which is a fixed
    short string; the message is always built from model or request text.
  - Not previously listed: scans 3, 4 and 5 all traced the span content and missed the
    `events`/`exception` branch (they checked the attribute keys only).

## Run history

- 2026-10-11 (scan 9, HEAD 833958d): No new vulnerabilities found. The 2 commits since scan 8
  (`e67304c`, `833958d`) are docs and data only: `e67304c` adds three AGENTS.md lines pointing at
  the eval harness (no code), `833958d` commits one eval report JSON (99 lines: mock answers,
  timings, thresholds, a 127.0.0.1 ephemeral port - read in full, no key/secret/token value, no
  code). Neither adds an entry point, sink, or parsing path fed by request data.
  - The AGENTS.md claim "the mock run needs no GPU, model, or downloads" verified by running, not
    reading: `python evals/run_eval.py` -> 8/8 passed, median wall 0.0022 s; `python -m unittest
    evals.test_eval` -> 10 OK. The mock server binds through `serve(svc, port=0)`, whose default
    host is 127.0.0.1 (server.py:5598) - loopback only, dev/CI tool, not deployed; `--base`/
    `--api-key` are operator CLI flags, no request data reaches them.
  - `git log 238a8da..HEAD -- serve/ tools/ setup.py` is empty: no code file touched in the window.
    F-1 (tracing exception.message, tracing.py:192-194) re-read at HEAD - unchanged, still the
    sole open finding; not re-reported.
  - Suites verified by running (repo root, venv): serve.test_security, test_runconfig,
    test_request_hardening, test_tracing, test_mcp - 74 OK. Working tree clean
    (`git status --porcelain -uall` = 0), branch `docs/eval-harness-in-agents`.

- 2026-10-11 (scan 8, HEAD 238a8da): No new vulnerabilities found. The 12 commits since scan 7
  (`56e0be8`, `3ff5850`, `63eb51a`, `8cfd588`, `cda9003`, `cd62f94`, `466e64a`, `b7a9604`,
  `89d9f3a`, `885ff2d`, `7820b37`, `238a8da`) add the `evals/` harness and engine lifecycle /
  pipe guards plus the tracing clamp - none introduces a network entry point, sink, or parsing
  path fed by request data. Inspected most closely: (1) the new `evals/` harness - binds a mock
  server to 127.0.0.1 on a free port, talks only to its own /v1, dev/CI only, not deployed;
  (2) vision `http(s)` image URL / local path (`frontend.py:_image_source` -> Vision.load) -
  client-supplied URL fetched by design, prior restrictions intact (UNC/network paths and
  foreign file:// refused, IMAGE_URL_MAX cap, embedding cache by image hash, file paths gated to
  Strata's own page) - no new SSRF/file-read route; (3) the `89d9f3a` type-narrowing asserts in
  openai_collect/anthropic_collect - fire only on a zero-chunk stream, no auth-bypass/injection/
  leak; (4) the auth/CSRF/framing invariants in SECURITY.md (constant-time key compare, Host
  check, Origin gating, CORS-allow-list, static extension allow-list, chunked-body cap) -
  untouched by the window. F-1 (tracing exception.message, tracing.py:192-194) remains the sole
  open finding; not re-reported. No files changed.

- 2026-10-11 (scan 7, HEAD cd62f94): No new vulnerabilities found. The 6 commits since scan 6
  (`56e0be8`, `3ff5850`, `63eb51a`, `8cfd588`, `cda9003`, `cd62f94`) change engine lifecycle and
  pipe handling, the tracing clamp/inflight bookkeeping, and type-checker cleanups:
  `serve/server.py` 235 lines, `serve/tracing.py` 5, `serve/frontend.py` 3 (a `_has_tag`
  annotation), the rest tests. Read every hunk of the `serve/server.py` delta, not the summary:
  `proc = self.proc` + `stdin = proc.stdin if proc is not None else None` + `EngineDied` on a
  gone process, the log-handle give-back (`_close_log`), `death_note` opening the log by path,
  `_pump` tolerating a process-less (lazy) engine, and `getattr(..., None)`/`callable` plus
  typing asserts in `metrics`, `/slots`, `run_with_mcp`, `anthropic_*` and `_captured`. No entry
  point added, no sink (exec / file path / URL / template) added, no auth, Origin, Host, key or
  path-check code touched; the handler-side hunks are annotations and the `slots_view` lookup.
  - Exception-clause changes checked in both directions: `63eb51a` narrowed
    `except (OSError, AttributeError, subprocess.TimeoutExpired)` to `(OSError, TimeoutExpired)`
    at `_release_slot_when_done` / `session_file` (a `None.stdin` there now surfaces as
    `EngineDied` / `out_of_step` - engine marked ended, the next request restarts it - instead of
    being swallowed), and `cd62f94` widened the solo `generate()`'s two writes to
    `(OSError, AttributeError)` so a request whose engine process was taken ends as an engine
    death (503 with the death note), not as a 400 "the request is malformed (AttributeError...)".
    Neither leaves the engine in a state the server serves requests from unaccounted.
  - Newest reachable surface, since scan 6 made `trace_otlp` web-editable (`runconfig.py`
    EDITABLE): the write gate is `_authorized()` + `_own_page` (JSON content type, non-foreign
    Origin), the value goes through the same `endpoint_of` as at start
    (`^https?://[\w.\-/:@]+$`, `/v1/traces` completed, no space/CR/LF), and `api_key`, `host`,
    `cors_origins`, `trusted_origins`, `allowed_hosts`, `mcp_servers`, `before_load` stay outside
    the whitelist - so a page cannot point the exporter at an attacker host and open the server
    at once, and no request data reaches the POST target. Noted, not a finding: the exporter
    POSTs spans to a host the operator's own page can name, which needs code execution as the
    user or an already-trusted origin - outside the remote-attacker model.
  - F-1 above is unchanged and still open: `3ff5850` touched `tracing.py:207` (the clamp) and
    `_loop` (inflight marked before the queue empties) only, not the `exception.message` branch
    at `tracing.py:192-194`.
  - Scan 5/6's drain-race note is fixed by `3ff5850` (functional defect, never an attack path).
  - Suites verified by running (repo root, venv): serve.test_server 271 OK, test_lifecycle 21 OK,
    test_parallel 19 OK, test_slots, test_control_cancel, test_fatal_recovery,
    test_restart_waiters, test_request_accounting - 361 OK (1 skip); test_vram, test_vision_busy,
    test_mcp, test_exif_orientation, test_tracing, test_monitor, test_runconfig, test_security,
    test_frontend - 101 OK (4 skips). Working tree clean, branch `docs/0.1.41-tracing-clamp`.

- 2026-10-10 (scan 6, HEAD dbcf05f): One finding, F-1 above (trace carries conversation text via
  the structured-output error message). Newest code since scan 5 is docs-only
  (`git show dbcf05f`: 8 added / 3 removed lines in docs/DETAILS.md, the clamp, the no-parent root
  span, the 2 s drain - no code, no secrets). Working tree clean.
  - F-1 traced end to end by running, not by reading: see the evidence files above. The
    attribute set is still telemetry-only (13 keys: method, path, status, model, token counts,
    stream, state, ttft, queue_s, load_s, wallclock_s) - the leak is the span's `events`, which
    the earlier scans did not look at.
  - Scan-5's drain-race note reproduces, at a low rate: `python -m serve.test_tracing` passed 6/6
    consecutive full runs and `serve.test_tracing.DeadCollector` passed 10/10 run alone, then a
    verbose full run failed once on `test_requests_survive_a_dead_endpoint`
    (`AssertionError: 0 not greater than 0`, test_tracing.py:236). The window is as scan 5
    described: `_loop` (tracing.py:281-289) drains the queue and only then does
    `self._inflight += 1`, so `close()` (294-300) can read "queue empty, inflight 0" and return
    before the POST starts. Still a functional defect, no attack path - impact is one lost trace.
  - Suites verified by running (repo root, venv): serve/test_security.py 23 OK,
    serve/test_runconfig.py 9 OK, serve/test_request_hardening.py 6 OK, serve/test_mcp.py 25 OK,
    serve/test_tracing.py 9 OK.
  - Routes re-checked, unchanged from scan 5: `_authorized()` gates the monitor/settings/config/MCP
    routes; `runconfig.check` keeps api_key, host, cors_origins, trusted_origins, allowed_hosts,
    mcp_servers, before_load non-editable; `parse_request` Host check on every no-key request;
    `_foreign_page` gates no-key browser-origin /v1 POSTs; `endpoint_of` is still the only
    validator of the export target and stays operator-owned (the `file://`-prefix gap from scan 4
    is unchanged and still not exploitable).

- 2026-10-10 (scan 5, HEAD 9713853): No new vulnerabilities found. Newest code is the
  three tracing fixes in serve/tracing.py and the repaired serve/test_tracing.py; traced:
  - Root span with no parent when no traceparent came (tracing.py:161-167, begin() 137-142):
    the only client-influenced parent ids are parse_traceparent's (^[0-9a-f]+$ exactly 32/16
    hex, all-zero refused) and reach only json.dumps'd OTLP fields of the operator's own
    endpoint - no CRLF, no header/log/span-text injection, no cross-request state.
  - First-token clamp into the request's wall window (tracing.py:210): the operands are the
    server's own perf_counter and the engine's DONE line, no client-controlled value.
  - Shutdown drain (`close()` 294-300 with `_inflight`, wired into the Ctrl+C closers at
    server.py:5914): wait bounded by max(drain_s, FLUSH_S + 0.5); the exporter queue is still
    maxsize=512 with `_dropped(1)` on queue.Full, so a stalled collector cannot grow server
    memory and cannot slow or fail a request.
  - Routes re-checked: `_authorized()` gates GET and POST /metrics, /api/requests, /settings,
    /config, /mcp, /status and /v1/*; runconfig.check rejects every key outside EDITABLE
    (runconfig.py:85-86), so GET/POST /config cannot read or write api_key, host, cors_origins,
    trusted_origins, allowed_hosts, the MCP servers or before_load; runconfig.save writes only
    svc.config_path (`<name>`.bak kept, .tmp then os.replace). Slot filenames still reject / \ :
    \* ? " < > |, a leading dot and control chars; /fonts/ and /web/ reject / and \ with an
    extension allow-list (woff2/css/js/svg).
  - FUNCTIONAL DEFECT (no attack path, not a finding): the new drain has a window - _loop
    takes the batch off the queue before `self._inflight += 1`, so close() can read "queue
    empty, inflight 0" and return before the POST has started. Measured here: `python -m
    serve.test_tracing` is flaky - DeadCollector.test_requests_survive_a_dead_endpoint failed
    1 of 9 (run alone it passed once, then failed in 0.61 s vs 2.65 s), so the commit's
    "9/9 pass" claim does not reproduce on this machine. Impact is losing one trace on
    shutdown. This replaces the scan-4 note that test_tracing.py had 6 ERRORS, which is now
    stale.

- 2026-10-10 (scan 4, v0.1.41 + HEAD c5a6902 + working tree): No new vulnerabilities
  found. The only code change since scan 3 is the tracing default endpoint
  (`http://localhost:4318/v1/traces` -> `http://127.0.0.1:8080/v1/traces`) in
  serve/tracing.py, serve/runconfig.py, serve/server.py (help text) and the docs;
  SECURITY.md, docs/DETAILS.md and docs/TROUBLESHOOTING.md carry the same value,
  .gitignore only. This run traced that change and the paths it touches:
  - The new default points at the port Strata itself is commonly started on, so
    the self-export case was tested for real: POST /v1/traces on Strata's own
    server answers 404, creates NO monitor record and NO trace (the path is not in
    begin_request's list), so spans-to-self cannot loop, cannot grow the record
    list, and cannot feed the exporter. Measured on a server with `api_key` set:
    the export POST (no key) is answered 401 and only counted as a drop; with the
    key it is 404, which prints the "not an OTLP trace endpoint" line and stops
    exporting - no loop, no record, no growth either way. Verified by running
    (c:\Users\Public\scan4_verify.py, scan4_key.py), not by reading.
  - endpoint_of re-checked against the new value: the regex
    ^https?://[\w.\-/:@]+$ still rejects space, CR, LF, `javascript:`, brackets and
    any character outside the class; a bare host is completed to /v1/traces;
    runconfig.check calls the same endpoint_of, so a typo still stops the start.
    One gap (measured, not exploitable - see the test-defect note): a value that
    already carries a non-http scheme gets "http://" prepended, so `file:///c:/x`
    is accepted as `http://file:///c:/x/v1/traces`. The endpoint stays
    operator-owned (config/CLI/env) - no request data reaches the fetch target, so
    moving the default introduces no SSRF.
  - Trace content re-verified by running (the repo's own tests for this are broken,
    see below): with tracing on and the monitor off, a request carrying a secret
    prompt exports spans whose attribute keys are only the documented telemetry set
    (timings, token counts, model, path, status) - the prompt text and the answer
    text appear in NO exported byte.
  - W3C header handling re-verified by running: the response traceparent is
    exactly 00-<32hex>-<16hex>-01 and names the exported root span; a client
    traceparent is adopted as the root's parent with its own span id kept; an
    inbound tracestate ("vendor=evil<>;X-Injected=1") is parsed and NEVER emitted -
    no CR/LF and no attacker text leaves the process in any span, header, or log.
  - Verified by running: serve/test_security.py 23 OK, serve/test_runconfig.py 9 OK,
    serve/test_request_hardening.py 6 OK.
  - NOT OK, tracked as a test defect (not a vulnerability, no attack path):
    serve/test_tracing.py runs 9 tests with 6 ERRORS, and it fails identically at
    HEAD c5a6902 (verified with git stash), so it is not caused by the endpoint
    change. Two independent causes:
    1. Four tests call `Request.request(self, ...)` - no such name exists in the
       file (the helper is the module function `request`), so they error out
       before doing anything: OneTracePerRequest.test_answer_carries_this_request_span,
       test_a_trace_only_record_never_leaves_text,
       ClientAsParent.test_traceparent_header_links_the_caller,
       DeadCollector.test_requests_survive_a_dead_endpoint.
    2. ClockEngine.replay uses `super().generate(...)` inside a nested generator,
       which raises `RuntimeError: super(): no arguments` on Python 3.15 - every
       request through that engine fails, which is what takes
       TracingOff.test_off_by_default_exports_nothing and
       OneTracePerRequest.test_two_requests_export_two_traces down.
    3. Minor: Collector's inner Handler appends to `self.received`, which the
       handler object does not have (it belongs to the outer Collector), printing a
       thread traceback.
    Consequence: the "a trace carries no conversation text" property that
    SECURITY.md promises has NO working automated test; scan 3's claim rested on
    reading the code. This scan replaced it with a direct run (21/22 checks passed).
    The one failing check: `endpoint_of("file:///c:/x")` -> accepted as
    `http://file:///c:/x/v1/traces`, because the scheme prefix is prepended before
    the regex. Measured: the host is the literal name `file`, so the export POST
    dies in `getaddrinfo` (Errno 11001) and is only counted as a drop - no local
    path is read, no file is touched. Not exploitable; worth tightening the check
    to reject a value that already carries a scheme. Fix the test file, then re-run.

- 2026-10-10 (scan 2, v0.1.41 code - git diff fb58e0d..HEAD shows no serve/tools/setup
  code changes since scan 1, docs-only): No new vulnerabilities found. This run
  covered the areas scan 1 did not inspect:
  - Web app XSS (serve/web/app.js): every server/model-derived string reaching
    innerHTML goes through esc() (escapes & < > " '); the markdown renderer
    escapes text BEFORE adding tags, inline code re-escaped after extraction,
    links only http(s) with rel="noopener noreferrer"; tool-call args/results
    (MCP output, untrusted) rendered via esc() in `<pre>`. img.src from
    attachments is same-origin /web data - no attacker-controlled URL scheme.
    No new Function/eval/document.write.
  - POST /config (runconfig.py): whitelist of 14 keys only; security keys
    (host, api_key, cors_origins, trusted_origins, allowed_hosts, mcp_servers,
    before_load) are explicitly non-editable and preserved untouched; gate =
    API key + _own_page (JSON content-type + non-foreign Origin); trace_otlp
    value validated by the same tracing.endpoint_of regex as at start.
  - /slots filename (slot_filename_problem): rejects separators, drive/stream
    forms, devices, leading dot, trailing dot/space, control chars, >200 bytes;
    save dir created 0o700; restore uses os.lstat (no symlink follow).
  - before_load shell= (server.py ~2805): subprocess.run(cmd,
    shell=isinstance(cmd, str)) - cmd is only ever the config's "before_load"
    key or --before-load flag (user-owned config; runconfig cannot write it,
    no request path reaches it). Same trust class as mcp_servers, already
    accepted in scan 1. Not a request-reachable sink.
  - gpu_speed_scores: subprocess.run([sys.executable, "-c", code]) with a
    fixed literal string, no interpolation.
  - tools/strata_mcp.py: spawn_detached/taskkill use list argv, int(pid),
    no shell=True; install-job spec is self-written JSON in own state dir.
  - Vision.load/download re-checked: UNC/foreign file:// hosts refused before
    any path access; IMAGE_URL_MAX read cap intact.
  - Verified by running: serve/test_security.py 23 OK, serve/test_mcp.py 25 OK,
    serve/test_request_hardening.py 6 OK, serve/test_runconfig.py 9 OK
    (run from repo root: python -m serve.test_...).
- 2026-10-10 (scan, v0.1.41 batch): No new vulnerabilities found. Inspected most
  closely:
  - API key handling in serve/server.py: key_matches uses hmac.compare_digest per
    key (comma-separated keys, latin-1 fallback); empty-key startup warnings; no
    key values logged.
  - DNS-rebinding/CSRF gating: `parse_request` Host check on every request
    when no key; with a key auth is required; `.localhost` suffix rule is
    browser-safe; `_foreign_page`/`origin_allowed` gate no-key /v1 POSTs;
    `_foreign_origin` gates /settings, /unload and MCP tool calls; `_cors`
    emits headers only for `cors_origins` on /v1/*.
  - Static serving of /fonts/ and /web/: "/" and "\" rejected, extension
    allow-list (woff2/css/js/svg) - no traversal.
  - Vision image sources (Vision.load/download): data:/http(s)/local path by
    design; UNC and foreign file:// hosts refused; IMAGE_URL_MAX read cap;
    embedding cache keyed by image hash, not client-chosen names.
  - Jinja chat template rendered with ImmutableSandboxedEnvironment; control
    tokens in message text marked to private-use codepoints (LITERAL_TAGS) before
    rendering.
  - Subprocess/HTTP sinks: MCP Popen and taskkill only from user config/own pid;
    MCP HTTP and OTel tracing endpoints only from config/env (regex-validated,
    local default, opt-in). No request data reaches exec/fetch/write paths.
  - Body handling: chunked cap 256 MiB (STRATA_MAX_BODY_MIB), bad Content-Length
    answered before read.
  - CMake FetchContent_Populate strata_llamacpp policy-pin (CMP0169 OLD) - build
    hygiene, not security.
- 2026-10-10 (scan 3, v0.1.41 + HEAD c5a6902): No new vulnerabilities found.
  Newest code since scan 2 is the opt-in OTLP tracing module; this run traced
  the newest code and the framing/MCP-execution paths end to end:
  - serve/tracing.py (OTLP): the `traceparent` response header is
    `00-<32hex>-<16hex>-01`, the client trace_id validated ^[0-9a-f]+$ and
    trace_id/span_id all-zero rejected - no CRLF/header/log injection; inbound
    tracestate is parsed into TraceContext but never emitted (traceparent() and
    the span attrs omit it). The exporter POSTs only to the operator's
    config/env endpoint via endpoint_of regex ^https?://[\w.\-/:@]+$ +
    /v1/traces completion (no space/CR/LF, local default); request data never
    reaches the fetch target - no attacker-controlled SSRF. Tracing on + monitor
    off: begin_request/_captured keep timings + token counts only, prompt and
    answer text never recorded, so no conversation text reaches a collector.
  - HTTP framing (server.py _body/_read_chunked/end_headers): Transfer-Encoding
    wins over Content-Length per RFC 9112, size checked before each chunk is
    allocated (BadBody 413), malformed chunk/CRLF -> 400, and every response
    carries Connection: close (one request per connection) with a bounded drain
    (DRAIN_SECONDS, read1) - no CL.TE/TE.CL desync, so no response poisoning of
    a later victim request.
  - MCP tool execution (run_with_mcp + _post/_foreign_page/_own_page): plain
    /v1 API requests never receive hub tools; tool calls gated to Strata's own
    page (JSON content-type + non-foreign Origin) and on a key-protected network
    server /v1 needs the API key - no clean remote-attacker -> tool-exec chain.
    The prompt-injection -> tool-exec risk stays the documented, opt-in,
    origin-gated design (SECURITY.md), not a new finding.
  - `parse_request` Host check on every no-key request (DNS rebinding); with a key
    auth required; `_foreign_page` gates no-key browser-origin /v1 POSTs, no-Origin
    (curl/SDK) allowed within the trust boundary.
