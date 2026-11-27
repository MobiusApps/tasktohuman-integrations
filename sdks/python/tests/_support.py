"""Test helpers: a local fake API on 127.0.0.1 and the shared fixtures.

The repository root holds the contract shared by both SDKs: openapi/public-v1.json
(the public API's OpenAPI description), fixtures/api/*.json (request/response pairs
checked against the real API) and fixtures/callback-signature.json (checked against
the real signer).
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

# Never send the fake server's traffic through a proxy from the environment.
os.environ["no_proxy"] = os.environ["NO_PROXY"] = "127.0.0.1,localhost"

REPO_ROOT = Path(__file__).resolve().parents[3]  # sdks/python/tests -> repository root
API_KEY = "tth_test_SECRETKEYVALUE0123456789"


def load_json(relative: str) -> Any:
    """Read a JSON file relative to the repository root."""
    return json.loads((REPO_ROOT / relative).read_text(encoding="utf-8"))


def fixture(name: str) -> dict[str, Any]:
    return dict(load_json(f"fixtures/api/{name}.json"))


@dataclass
class Recorded:
    method: str
    path: str
    headers: dict[str, str]  # lower-case names
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body)


@dataclass
class Reply:
    status: int = 200
    body: Any = None  # JSON-encoded unless raw is set
    headers: dict[str, str] | None = None
    raw: bytes | None = None
    drop: bool = False  # close the connection without answering


class FakeAPI:
    """Answers queued replies in order; records every request."""

    def __init__(self) -> None:
        self.requests: list[Recorded] = []
        self.replies: list[Reply] = []
        self.default: Reply | None = None
        api = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                api.requests.append(
                    Recorded(self.command, self.path, {k.lower(): v for k, v in self.headers.items()}, body)
                )
                reply = api.replies.pop(0) if api.replies else api.default
                if reply is None:
                    reply = Reply(599, raw=b"no reply queued")
                if reply.drop:
                    self.close_connection = True
                    return
                if reply.raw is not None:
                    data = reply.raw
                    content_type = "text/html"
                else:
                    data = json.dumps(reply.body).encode("utf-8")
                    content_type = "application/problem+json" if reply.status >= 400 else "application/json"
                self.send_response(reply.status)
                headers = {"Content-Type": content_type, **(reply.headers or {})}
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _handle

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def start(self) -> FakeAPI:
        self._thread.start()
        return self

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def queue(self, status: int = 200, body: Any = None, **kwargs: Any) -> None:
        self.replies.append(Reply(status, body, **kwargs))

    def queue_fixture(self, name: str) -> dict[str, Any]:
        """Queue a recorded response from the docs examples; return the whole example."""
        example = fixture(name)
        response = example["response"]
        headers = {k: v for k, v in response.get("headers", {}).items() if k.lower() != "content-type"}
        self.queue(response["status"], response["body"], headers=headers)
        return example


def unused_port_url() -> str:
    """A local URL where nothing listens (for network errors)."""
    import socket

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    return f"http://127.0.0.1:{port}"
