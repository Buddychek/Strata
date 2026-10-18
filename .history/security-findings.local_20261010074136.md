# Security scan log (local, not version controlled)

Running log for the scheduled security review. Read this before each scan; do not
re-report anything listed here; append new validated findings after each run. Only
findings with a full attack path (attacker, input they control, route to the
vulnerable code, concrete impact) belong here.

## Findings

_None validated to date._

## Run history

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
