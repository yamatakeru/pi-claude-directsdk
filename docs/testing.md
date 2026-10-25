# Verification

Verification has two layers. The offline regression suite runs in seconds on Node 22 and covers transport contracts with a fake `claude` child and loopback endpoints. The installed-Pi harness runs the operator’s real `pi` executable with real settings, credentials, tools, and extensions. It uses a private copy of the user’s configuration and replaces only the DirectSDK extension source with the local checkout. This prevents the installed package from overwriting the local code during extension loading.

## Offline regression suite

```sh
npm test
```

Run it on Node 22. The suite uses `node:test` and needs no subscription credentials. It covers contracts that the installed-Pi harness cannot guard cheaply:

- The admission relay forwards one upstream Messages request and rejects a second locally, including the tool-change beta and request rewrite.
- The signed-thinking carrier restores only while the visible projection matches.
- Conflicting auth and backend overrides are rejected without the test bypass.
- The usage-credit guard stops an overage turn, permits it with `CLAUDE_DIRECTSDK_ALLOW_USAGE_CREDITS=1`, and marks the error non-retryable.
- The tool-change plan emits deferred additions, removals, and assistant-boundary injections only when model metadata supports them.

The tests use a temporary fake executable in the stream tests. They do not prove real Claude generation, native cache reuse, or upstream acceptance of the beta fields. The installed-Pi harness remains the end-to-end gate.

## Harness requirements

- Python 3 and the user’s installed Pi on `PATH`.
- Claude Code installed and authenticated for paid scenarios.
- A discovered model in the user’s Pi configuration or verified model snapshot.

Use `--pi /absolute/path/to/pi` or `PI_VERIFY_PI` to select another installed executable. The harness excludes repository `node_modules` directories from automatic executable lookup.

## Verified environments

The current maintainer installation is Pi 1.3.0, confirmed with `pi --version`. The offline startup scenario (`npm run verify`) passes on this installation with no stderr and no observed Claude child starts. Paid model calls have not been reverified on Pi 1.3.0.

Before v0.1.7 was released, both compiled-Pi fixes passed these checks on macOS arm64 with compiled Pi 1.2.0 / Bun 1.3.14 and Claude Code 2.1.281:

- The emitted MCP helper command completed initialization and tool listing, and denied native tool execution. The pre-fix command started Pi instead and failed in an empty offline configuration.
- The real CLI discovery flow returned seven picker models under Node 26.10.0 and compiled Pi. The pre-fix compiled runtime failed during server cleanup.
- The compiled Pi model picker completed live catalog refresh in a private configuration. A separate offline process listed 13 DirectSDK entries, including aliases.
- Six paid calls to `claude-haiku-4-5-20251001` covered a fresh response and a four-turn conversation. The conversation remembered a marker, read a real file through Pi's `read` tool, recalled both values, and recalled them again after restarting Pi and resuming.
- Each model call in the four-turn conversation admitted one upstream request with none blocked. The conversation produced no unintended Pi sessions or stderr errors.

The paid conversation checks used both fixes together. The protocol, discovery, model-picker, and multi-turn conversation checks used temporary verification scripts, not permanent harness scenarios. They do not add repeatable tool-round-trip coverage to the repository. The short paid conversations reported no cache reads and do not verify warm-cache reuse. Separate long-session cache measurements are recorded in [transport-measurements.md](transport-measurements.md).

The two compiled-Pi fixes have not been verified locally on Linux. Earlier Linux lifecycle and cache measurements remain separate evidence; they do not cover these fixes.

## Scenarios

### Offline startup

```sh
npm run verify
```

Equivalent command:

```sh
python3 scripts/verify.py startup
```

The harness runs offline model listing through the installed Pi. It checks the process result and verifies that no Claude child starts. This is not an interactive editor-readiness benchmark.

### Fresh model request

```sh
python3 scripts/verify.py fresh --paid
```

The harness starts a real Pi session and requests a short greeting from Haiku 5.5. It requires a successful terminal response, nonempty visible text, and output usage. It does not require exact model wording. Pi can exit successfully after a model error.

### Complete existing-session replay

```sh
python3 scripts/verify.py session --paid --session /absolute/path/to/session.jsonl
```

The harness copies every session entry into a private temporary snapshot. Pi forks that snapshot and submits the verification prompt. It does not filter errors, replace tools, remove thinking, shorten history, or write to the original session. The user’s working directory, credential values, tool inventory, and other extensions remain in effect. Configuration and credentials are copied privately, not written back.

This is the primary regression check for provider switching and accumulated session history. A fresh request passing does not establish that an existing session works.

### Same-process warm-cache measurement

Check RPC setup without model requests:

```sh
python3 scripts/verify.py warm --dry-run
```

After approving three paid model requests, run:

```sh
python3 scripts/verify.py warm --paid --session /absolute/path/to/session.jsonl
```

Omit `--session` to start without existing history. The scenario keeps one Pi RPC process alive for exactly three greeting prompts. It disables Pi auto-retry, auto-compaction, and idle cache warming. It snapshots an existing session once and retains the original tool declarations and other extensions.

A private benchmark extension blocks tool execution and allows at most one agent provider request per prompt and three in total. An unexpected provider call stops Pi with exit code `78` before the provider runs. This guard applies only to the benchmark, not normal provider behavior. Do not use extensions that independently make model calls outside Pi's agent request path.

Each turn must produce one successful assistant response and admit exactly one upstream request. The harness rejects unexpected tools, retries, compaction, changed Pi prompt/tool hashes, or mismatched native-child counts. Guarded model-discovery children are counted separately because their initialize handshake does not make a model request.

The summary reports wall time, token usage, cache-read share, phase timings, replay counts, request bytes, connection reuse, and Pi prefix hashes. It does not save model response text or native request bodies. It reports reuse without asserting a universal percentage: cache size thresholds, lifetime, model, and actual prompt changes affect results. The hashes cover Pi inputs, not CLI-added context.

`--dry-run` initializes RPC, checks the model and guard, and sends no model prompts. A discovery child can still start. Dry-run success does not establish successful generation or warm-cache reuse. For this scenario, `--timeout` bounds each prompt; initialization commands have a maximum of 30 seconds, followed by bounded shutdown.

## Options and safety

- `--model provider/model` selects the model. The default is `claude-directsdk/claude-haiku-5-5`.
- `--extension PATH` selects the extension. The default is this checkout’s entry point.
- `--timeout SECONDS` bounds the scenario. The default is 120 seconds.
- `--paid` explicitly approves real model requests. Without it, paid scenarios refuse to run.

Run from the same project directory as the original session. Existing tool permissions and extension behavior still apply. The verification prompt asks the model not to call tools, but the harness does not replace the user’s tool inventory.

Private artifacts go to `/tmp/pi-directsdk-verify-*`. The harness removes copied configuration, credentials, input snapshots, and Pi-generated test sessions after the run. It retains summaries and bounded native error diagnostics. It does not save model responses, credentials, or successful native transcript records. Native errors can quote input fragments; inspect the diagnostics before sharing them.

The observer records real Claude process starts, replay acknowledgments, terminal result errors, and exits. It does not substitute native responses or alter the provider request. For the fresh and session scenarios, automatic Pi retries can consume additional allowance if enabled in the user's settings. The warm scenario explicitly disables them and installs its request-budget guard.

## Build checks and CI

```sh
npm run check
npm run build
npm test
```

The first two commands check types and compilation. `npm test` runs the offline regression suite on Node 22, including the fork's fixture tests for its request rewrites and relay failure handling, grouped by fork issue. Branch, pull request, and release CI run all three checks. Paid runtime verification stays local because CI is not the user’s Pi installation and has no approved subscription credentials.

The permanent harness does not yet exercise an in-process `/reload`, forced subprocess stalls, cancellation, or an explicit tool round trip. Temporary checks described above do not extend the supported scenarios.


Separate temporary Linux supervisor checks verified forced write/read/exit stalls and cancellation using real subprocesses and process groups. A three-request installed-Pi check verified cache reuse after restarting Pi. These checks are recorded in [transport-measurements.md](transport-measurements.md#linux-lifecycle-and-cross-restart-verification); they are not additional scenarios in the supported harness.
