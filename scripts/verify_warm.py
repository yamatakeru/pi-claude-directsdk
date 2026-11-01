"""Three-turn cache measurement through one installed Pi RPC process."""
import json
import queue
import signal
import subprocess
import threading
import time

REQUEST_LIMIT = 3
PROMPT = "For this verification only, reply with a short greeting. Do not call tools."
GUARD = """export default function (pi) {
  let ready = false;
  let turnRequests = 0;
  let totalRequests = 0;
  pi.registerCommand("claude-native-warm-ready", {
    description: "Enable the warm benchmark's three-request budget",
    handler: async () => { ready = true; },
  });
  pi.on("before_agent_start", () => { turnRequests = 0; });
  pi.on("before_provider_request", () => {
    // Stop before the provider can spawn Claude; later payload handlers cannot
    // override this budget. This guard exists only in the private benchmark.
    if (!ready || turnRequests >= 1 || totalRequests >= 3) process.exit(78);
    turnRequests++;
    totalRequests++;
  });
  pi.on("tool_call", () => ({ block: true, reason: "Warm verification forbids tool execution" }));
  pi.on("cache_warming_decision", () => ({ action: "stop" }));
}
"""


def run_warm(args, executable, env, directory, report):
    guard = directory / "agent" / "warm-guard.ts"
    guard.write_text(GUARD)
    settings_path = directory / "agent" / "settings.json"
    settings = json.loads(settings_path.read_text())
    settings["extensions"].append(str(guard))
    settings_path.write_text(json.dumps(settings))
    sessions = directory / "sessions"
    sessions.mkdir()
    command = [executable, "--mode", "rpc", "--model", args.model, "--thinking", "minimal",
               "--session-dir", str(sessions)]
    if args.session is not None:
        source = args.session.resolve(strict=True)
        snapshot = directory / "input-session.jsonl"
        data = source.read_bytes()
        for line in data.splitlines():
            if line:
                json.loads(line)
        snapshot.write_bytes(data)
        command += ["--fork", str(snapshot)]
        report({"session_snapshot_bytes": len(data)})
    env["PI_CLAUDE_NATIVE_PROMPT_HASHES"] = "1"
    events = queue.Queue(maxsize=256)
    stopping = threading.Event()
    stderr_bytes = [0]
    reader_errors = []
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=env, start_new_session=True)

    def publish(value):
        while not stopping.is_set():
            try:
                events.put(value, timeout=0.1)
                return
            except queue.Full:
                continue

    def stdout():
        try:
            while True:
                line = process.stdout.readline(16 * 1024 * 1024 + 1)
                if not line:
                    break
                if len(line) > 16 * 1024 * 1024:
                    raise RuntimeError("Pi RPC record exceeds 16 MiB")
                publish(json.loads(line))
        except Exception as error:
            reader_errors.append(error)
            publish(error)
        finally:
            publish(RuntimeError("Pi RPC output closed unexpectedly"))

    def stderr():
        try:
            while chunk := process.stderr.read(8192):
                stderr_bytes[0] += len(chunk)
        except Exception as error:
            reader_errors.append(error)
            publish(error)

    readers = [threading.Thread(target=stdout, daemon=True), threading.Thread(target=stderr, daemon=True)]
    for reader in readers:
        reader.start()
    sequence = 0

    def send(kind, **values):
        nonlocal sequence
        sequence += 1
        identifier = str(sequence)
        process.stdin.write(json.dumps({"id": identifier, "type": kind, **values}).encode() + b"\n")
        process.stdin.flush()
        return identifier

    def receive(deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Pi RPC deadline exceeded; increase --timeout")
        try:
            event = events.get(timeout=remaining)
        except queue.Empty as error:
            raise TimeoutError("Pi RPC deadline exceeded; increase --timeout") from error
        if isinstance(event, Exception):
            raise event
        if event.get("type") == "response" and not event.get("success"):
            raise RuntimeError("Pi rejected RPC command: " + str(event.get("command")))
        if event.get("type") in ("tool_execution_start", "compaction_start", "auto_retry_start"):
            raise RuntimeError("Unexpected benchmark work: " + event["type"])
        return event

    def rpc(kind, **values):
        identifier = send(kind, **values)
        deadline = time.monotonic() + min(args.timeout, 30)
        while True:
            event = receive(deadline)
            if event.get("type") == "response" and event.get("id") == identifier:
                return event.get("data")

    rows = []
    completed = False
    try:
        state = rpc("get_state")
        selected = (state or {}).get("model") or {}
        if f"{selected.get('provider')}/{selected.get('id')}" != args.model:
            raise RuntimeError("Pi did not select the requested benchmark model")
        rpc("set_auto_retry", enabled=False)
        rpc("set_auto_compaction", enabled=False)
        commands = rpc("get_commands")
        if not any(command.get("name") == "claude-native-warm-ready" for command in commands["commands"]):
            raise RuntimeError("Warm request-budget guard did not load")
        rpc("prompt", message="/claude-native-warm-ready")
        report({"stage": "ready", "model": args.model, "paid_request_limit": REQUEST_LIMIT,
                "dry_run": args.dry_run})
        if not args.dry_run:
            for turn in range(1, REQUEST_LIMIT + 1):
                started = time.monotonic()
                deadline = started + args.timeout
                assistant = None
                acknowledged = False
                identifier = send("prompt", message=PROMPT)
                while True:
                    event = receive(deadline)
                    if event.get("type") == "response" and event.get("id") == identifier:
                        acknowledged = True
                    if event.get("type") == "message_end" and event.get("message", {}).get("role") == "assistant":
                        if assistant is not None:
                            raise RuntimeError("Warm turn produced more than one assistant response")
                        assistant = event["message"]
                        if assistant.get("stopReason") != "stop":
                            raise RuntimeError("Warm turn did not finish successfully: " + str(assistant.get("stopReason")))
                    if event.get("type") == "agent_settled":
                        break
                if not acknowledged:
                    raise RuntimeError("Pi settled before acknowledging the benchmark prompt")
                if assistant is None:
                    raise RuntimeError("Warm turn produced no assistant response")
                diagnostics = [item for item in assistant.get("diagnostics", [])
                               if item.get("type") == "pi-claude-native/meta"]
                if len(diagnostics) != 1:
                    raise RuntimeError("Warm turn needs exactly one transport diagnostic")
                details = diagnostics[0]["details"]
                if details["upstreamRequests"] != 1 or details["blockedRequests"] != 0:
                    raise RuntimeError("Warm turn did not admit exactly one clean upstream request")
                measurements = details["measurements"]
                hashes = measurements["prefixHashes"]
                if not hashes["piSystemPromptSha256"] or not hashes["piToolDefinitionsSha256"]:
                    raise RuntimeError("Warm turn is missing Pi prefix hashes")
                if rows and hashes != rows[0]["measurements"]["prefixHashes"]:
                    raise RuntimeError("Pi system prompt or tool definitions changed between warm turns")
                usage = assistant["usage"]
                if usage["output"] <= 0 or measurements["cacheReadShare"] is None:
                    raise RuntimeError("Warm turn is missing output or cache measurements")
                row = {"run": turn, "success": True, "wall_ms": round((time.monotonic() - started) * 1000, 3),
                       "usage": {key: usage[key] for key in ("input", "output", "cacheRead", "cacheWrite")},
                       "measurements": measurements}
                report(row)
                rows.append(row)
        completed = True
    except Exception as error:
        report({"stage": "failed", "success": False, "completed_requests": len(rows), "error": str(error)})
        raise
    finally:
        # Stop RPC before removing the private fork, copied config, and guard.
        stopping.set()
        try:
            if process.poll() is None:
                if not completed:
                    signal_process(process.pid, signal.SIGINT)
                process.stdin.close()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    signal_process(process.pid, signal.SIGINT)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        signal_process(process.pid, signal.SIGKILL)
                        process.wait(timeout=5)
        finally:
            # Claude owns detached process groups, including when Pi exited early.
            trace_path = directory / "native.jsonl"
            records = [json.loads(line) for line in trace_path.read_text().splitlines()] if trace_path.exists() else []
            active = {row["pid"] for row in records if row.get("kind") == "claude-spawn" and row.get("pid")} - {
                row["pid"] for row in records if row.get("kind") == "claude-exit" and row.get("pid")}
            for pid in active:
                signal_process(pid, signal.SIGKILL)
            for reader in readers:
                reader.join(timeout=5)
            process.stdout.close()
            process.stderr.close()
            if not process.stdin.closed:
                process.stdin.close()
        if any(reader.is_alive() for reader in readers):
            raise RuntimeError("Pi descendants kept RPC streams open during cleanup")
        if reader_errors:
            raise RuntimeError("Cannot read Pi RPC streams") from reader_errors[0]
        if process.returncode == 78:
            raise RuntimeError("Warm request-budget guard stopped an unexpected provider call")
        if completed and process.returncode != 0:
            raise RuntimeError("Pi failed while shutting down the warm benchmark")
    trace = directory / "native.jsonl"
    records = [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []
    starts = [row for row in records if row.get("kind") == "claude-spawn"]
    exits = [row for row in records if row.get("kind") == "claude-exit"]
    discovery = {row["pid"] for row in records if row.get("kind") == "native-discovery" and row.get("success")}
    request_starts = [row for row in starts if row["pid"] not in discovery]
    request_exits = [row for row in exits if row["pid"] not in discovery]
    expected = 0 if args.dry_run else REQUEST_LIMIT
    if (len(request_starts) != expected or len(request_exits) != expected
            or {row["pid"] for row in request_starts} != {row["pid"] for row in request_exits}
            or any(row["code"] != 0 for row in exits)):
        raise RuntimeError("Warm benchmark native-child count or exit status did not match the request budget")
    report({"stage": "complete", "success": True, "requests": len(rows), "discovery_children": len(discovery), "stderr_bytes": stderr_bytes[0],
            "pi_prefix_hashes_stable": True if rows else None})


def signal_process(pid, sig):
    # Only terminate a process group the observed process itself leads.
    import os
    try:
        if os.getpgid(pid) == pid:
            os.killpg(pid, sig)
    except ProcessLookupError:
        pass  # The observed process has already exited.
