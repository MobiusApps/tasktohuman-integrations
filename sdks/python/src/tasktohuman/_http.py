"""The HTTP transport: standard library only (urllib)."""

from __future__ import annotations

import http.client
import json
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from email.message import Message
from typing import Any, Callable, Literal, Mapping

from ._errors import APIConnectionError, APIError, TaskToHumanError, error_for
from ._version import __version__

DEFAULT_BASE_URL = "https://api.tasktohuman.com"
USER_AGENT = f"tasktohuman-python/{__version__}"

# A Retry-After longer than this is not waited for: the error is raised at once.
MAX_RETRY_AFTER = 60

# "safe": retried on 429, 5xx and network errors (GET, and create with its
# idempotency key). "rate_limit": retried on 429 only (cancel, where a lost
# success followed by a retry would surface as a misleading 409).
RetryPolicy = Literal["safe", "rate_limit"]

_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """The API never redirects; following one would send the key elsewhere."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None  # urllib then raises HTTPError with the 3xx status


def normalize_base_url(base_url: str) -> str:
    """Trim trailing slashes; refuse ``http:`` except for a local host."""
    url = base_url.strip().rstrip("/")
    parts = urllib.parse.urlsplit(url)
    host = (parts.hostname or "").lower()
    if not host or parts.scheme not in ("https", "http"):
        raise ValueError("base_url must be an absolute https URL")
    if parts.scheme == "http" and not (host in _LOCAL_HOSTS or host.endswith(".localhost")):
        raise ValueError("base_url must use https (http is allowed only for localhost)")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("base_url must not contain credentials, a query or a fragment")
    return url


def _parse_retry_after(value: str | None) -> int | None:
    if value is None:
        return None
    value = value.strip()
    return int(value) if value.isascii() and value.isdigit() else None


class Transport:
    """Sends one API call, with retries. Holds the key; never shows it."""

    def __init__(
        self,
        api_key: str,
        base_url: str,
        timeout: float,
        max_retries: int,
        ssl_context: ssl.SSLContext | None,
    ) -> None:
        key = api_key.strip() if isinstance(api_key, str) else ""
        if not re.fullmatch(r"[\x21-\x7e]+", key):
            # Never echo the key: it may be a real one with a stray newline.
            raise ValueError("api_key must be a tth_live_/tth_test_ key (printable ASCII, no spaces)")
        if max_retries < 0:
            raise ValueError("max_retries must be 0 or more")
        self.__api_key = key
        self.base_url = normalize_base_url(base_url)
        self.timeout = timeout
        self.max_retries = max_retries
        self._opener = urllib.request.build_opener(
            _RefuseRedirects(), urllib.request.HTTPSHandler(context=ssl_context)
        )
        self._sleep: Callable[[float], None] = time.sleep

    def __repr__(self) -> str:
        return f"Transport(base_url={self.base_url!r}, api_key='***')"

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Mapping[str, str] | None = None,
        body: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        retry: RetryPolicy = "safe",
    ) -> Any:
        raw, _ = self.request_raw(method, path, query=query, body=body, headers=headers, retry=retry)
        try:
            return json.loads(raw)
        except ValueError:
            raise TaskToHumanError("the API answered with a body that is not JSON") from None

    def request_raw(
        self,
        method: str,
        path: str,
        *,
        query: Mapping[str, str] | None = None,
        body: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        retry: RetryPolicy = "safe",
    ) -> tuple[bytes, Message]:
        """The answer's body and headers, unparsed (for downloads); errors and retries as ``request``."""
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        data = None if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        all_headers = {
            "Authorization": "Bearer " + self.__api_key,
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        }
        if data is not None:
            all_headers["Content-Type"] = "application/json"
        if headers:
            all_headers.update(headers)

        attempt = 0
        while True:
            try:
                return self._send(method, url, data, all_headers)
            except APIError as err:
                retryable = err.status == 429 or (retry == "safe" and err.status >= 500)
                if not retryable or attempt >= self.max_retries:
                    raise
                delay = self._backoff(attempt)
                if err.status in (429, 503) and err.retry_after is not None:
                    if err.retry_after > MAX_RETRY_AFTER:
                        raise
                    delay = float(err.retry_after)
            except APIConnectionError:
                if retry != "safe" or attempt >= self.max_retries:
                    raise
                delay = self._backoff(attempt)
            self._sleep(delay)
            attempt += 1

    @staticmethod
    def _backoff(attempt: int) -> float:
        return 0.5 * float(1 << attempt)

    def _send(self, method: str, url: str, data: bytes | None, headers: dict[str, str]) -> tuple[bytes, Message]:
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with self._opener.open(req, timeout=self.timeout) as resp:
                return resp.read(), resp.headers
        except urllib.error.HTTPError as exc:
            err = _error_from_response(exc.code, exc.headers, _read_quietly(exc))
            exc.close()
            raise err from None
        except (urllib.error.URLError, http.client.HTTPException, OSError) as exc:
            reason = getattr(exc, "reason", None) or exc
            raise APIConnectionError(f"request to {urllib.parse.urlsplit(url).netloc} failed: {reason}") from exc


def _read_quietly(exc: urllib.error.HTTPError) -> bytes:
    try:
        return exc.read()
    except (OSError, http.client.HTTPException):
        return b""


def _error_from_response(status: int, headers: Any, raw: bytes) -> APIError:
    problem: dict[str, Any] = {}
    try:
        parsed = json.loads(raw) if raw else None
    except ValueError:
        parsed = None
    if isinstance(parsed, dict) and isinstance(parsed.get("code"), str):
        problem = parsed
    retry_after = _parse_retry_after(headers.get("Retry-After") if headers is not None else None)
    return error_for(status, problem, retry_after)
