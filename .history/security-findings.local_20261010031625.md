# Security scan log (local, not version controlled)

Running log for the scheduled security review. Read this before each scan; do not
re-report anything listed here; append new validated findings after each run. Only
findings with a full attack path (attacker, input they control, route to the
vulnerable code, concrete impact) belong here.

## Findings

_None validated to date._

## Run history

- 2026-10-10 (scan 2, v0.1.41 code - git diff fb58e0d..HEAD shows no serve/tools/setup
  code changes since scan 1, docs-only): No new vulnerabilities found. This run
  covered the areas scan 1 did not inspect:
  - Web app XSS (serve/web/app.js): every server/model-derived string reaching
    innerHTML goes through esc() (escapes & < > " '); the markdown renderer
    escapes text BEFORE adding tags, inline code re-escaped after extraction,
    links only http(s) with rel="noopener noreferrer"; tool-call args/results
    (MCP output, untrusted) rendered via esc() in <pre>. img.src from
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
  - DNS-rebinding/CSRF gating: parse_request Host check on every request when no
    key; with a key auth is required; .localhost suffix rule is browser-safe;
    _foreign_page/origin_allowed gate no-key /v1 POSTs; _foreign_origin gates
    /settings, /unload and MCP tool calls; _cors emits headers only for
    cors_origins on /v1/*.
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
