#!/usr/bin/env python3
"""
Mock LLM server — optional, zero-dependency stand-in for a real LLM provider.

Use this instead of a real OpenAI/Anthropic API key if you don't want to pay
for or share one. It speaks the OpenAI Chat Completions shape closely enough
that most OpenAI client libraries can point at it directly (set the client's
base URL to this server, e.g. http://localhost:4001/v1, with any dummy API
key string — this server does not check it).

It does NOT generate real AI summaries. It returns a short templated
response that echoes back a snippet of what it was sent, so you (and anyone
reviewing this) can confirm your code actually calls it, sends real context,
and handles its response, timeouts, and failures correctly.

Run it with zero setup, no pip install required:

    python3 mock-llm-server.py            # listens on :4001
    PORT=5000 python3 mock-llm-server.py  # or a custom port

Endpoints:

    POST /v1/chat/completions
        Standard OpenAI-shaped request/response. Behavior can be controlled
        via the endpoints below (useful for testing your timeout/retry and
        resilience handling on purpose).

    GET  /control/stats
        Returns how many completions have been served, e.g.:
        {"callCount": 3}
        Handy for confirming your code skips the call when nothing changed,
        by checking this count doesn't grow when you poll an unchanged
        listing.

    POST /control/configure
        Body: {"latencyMs": 20000, "failNext": 1}
        - latencyMs: artificial delay (ms) added before every response,
          until changed again. Use this to test that your LLM call has a
          real timeout and doesn't block anything else.
        - failNext: the next N completion requests return HTTP 500 instead
          of a normal response (then behavior reverts to normal). Use this
          to test that a failed call doesn't crash your process or lose the
          underlying snapshot.

    POST /control/reset
        Resets call count, latency, and pending failures back to defaults.
"""

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

state_lock = threading.Lock()
state = {
    "callCount": 0,
    "latencyMs": 0,
    "failNext": 0,
}


def build_chat_response(user_content: str) -> dict:
    snippet = user_content.strip().replace("\n", " ")[:160]
    content = f'Mock AI summary (not a real model). Based on what you sent: "{snippet}"'
    prompt_tokens = max(1, len(user_content) // 4)
    completion_tokens = max(1, len(content) // 4)
    return {
        # Full OpenAI Chat Completions shape (id, object, created, model,
        # choices with logprobs, and usage) — the official OpenAI client
        # libraries validate the response against this schema and will
        # reject a payload missing any of these fields.
        "id": f"mock-chatcmpl-{int(time.time() * 1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": "mock-llm",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": content,
                },
                "logprobs": None,
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return {}

    def do_POST(self):
        if self.path.startswith("/v1/chat/completions"):
            body = self._read_json_body()
            messages = body.get("messages") or []
            last_user_content = ""
            for message in reversed(messages):
                if message.get("role") == "user":
                    last_user_content = str(message.get("content", ""))
                    break

            with state_lock:
                latency_ms = state["latencyMs"]
                should_fail = state["failNext"] > 0
                if should_fail:
                    state["failNext"] -= 1

            if latency_ms > 0:
                time.sleep(latency_ms / 1000.0)

            if should_fail:
                self._send_json(
                    500,
                    {"error": {"message": "mock-llm-server: injected failure", "type": "mock_failure"}},
                )
                return

            with state_lock:
                state["callCount"] += 1

            self._send_json(200, build_chat_response(last_user_content))
            return

        if self.path.startswith("/control/configure"):
            body = self._read_json_body()
            with state_lock:
                if "latencyMs" in body:
                    state["latencyMs"] = int(body["latencyMs"])
                if "failNext" in body:
                    state["failNext"] = int(body["failNext"])
            self._send_json(200, {"ok": True, "state": dict(state)})
            return

        if self.path.startswith("/control/reset"):
            with state_lock:
                state["callCount"] = 0
                state["latencyMs"] = 0
                state["failNext"] = 0
            self._send_json(200, {"ok": True, "state": dict(state)})
            return

        self._send_json(404, {"error": "not found"})

    def do_GET(self):
        if self.path.startswith("/control/stats"):
            with state_lock:
                self._send_json(200, {"callCount": state["callCount"]})
            return
        if self.path.startswith("/health"):
            self._send_json(200, {"status": "ok"})
            return
        self._send_json(404, {"error": "not found"})

    def log_message(self, format, *args):
        print(f"[mock-llm] {self.address_string()} - {format % args}")


def main():
    port = int(os.environ.get("PORT", "4001"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Mock LLM server listening on :{port} (POST /v1/chat/completions)")
    server.serve_forever()


if __name__ == "__main__":
    main()
