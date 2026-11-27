"""Typed errors. Branch on ``APIError.code``, as the Errors page says.

No error ever holds the request, its headers or the API key.
"""

from __future__ import annotations

from typing import Any, Mapping

# Codes for an error body that is not a problem document (for example a proxy's
# HTML page). They are the API's own codes; ``http_<status>`` is the last resort.
_FALLBACK_CODES = {
    401: "unauthorized",
    404: "not_found",
    429: "rate_limited",
}


class TaskToHumanError(Exception):
    """Base class of every error this package raises.

    ``idempotency_key`` is set on every error raised by ``create_task``: retry
    with that same key and the API returns the task instead of creating a
    second one.
    """

    idempotency_key: str | None = None


class APIError(TaskToHumanError):
    """The API answered with an error status.

    ``problem`` is the raw problem document (with ``feature``,
    ``available_from``, ``reason``, ``limit``, ``max``, ``state``, ``action``
    when the code adds them).
    """

    def __init__(self, status: int, problem: Mapping[str, Any], retry_after: int | None = None) -> None:
        self.status = status
        self.problem: dict[str, Any] = dict(problem)
        self.code: str = str(problem.get("code") or fallback_code(status))
        self.title: str = str(problem.get("title") or f"HTTP {status}")
        self.errors: dict[str, list[dict[str, str]]] | None = problem.get("errors")
        self.trace_id: str | None = problem.get("traceId")
        self.retry_after = retry_after
        super().__init__(f"{status} {self.code}: {self.title}")


class ValidationError(APIError):
    """400: fix the request. ``errors`` names each field (``payload.<key>``)."""


class AuthenticationError(APIError):
    """401: the key is missing, malformed, unknown or revoked."""


class LimitReachedError(APIError):
    """402: a monthly or test allowance, or a cap, is used up. Never retried.

    The organization being out of credits is the subclass ``NotEnoughCreditsError``.
    """


class NotEnoughCreditsError(LimitReachedError):
    """402 ``not_enough_credits``: the organization's credits cannot cover the most this task could cost.

    The task was not created and nothing was stored, not even the idempotency
    key. Never retried: a retry cannot succeed until someone in the
    organization buys a credit pack or turns on automatic buying in the app
    (Plan > Credits). Then retry with the same ``idempotency_key``.

    ``reason`` says why no credits were bought for it: ``no_credits``
    (automatic buying is not possible), ``auto_buy_off``, ``spending_cap``
    (the monthly cap would be passed), ``top_up_failed`` (the card was declined
    or needs authentication) or ``purchases_disabled``; other values may be
    added later.
    """

    def __init__(self, status: int, problem: Mapping[str, Any], retry_after: int | None = None) -> None:
        super().__init__(status, problem, retry_after)
        counts = ""
        if self.needed is not None and self.available is not None:
            held = f" and {self.held} are held by open tasks" if self.held else ""
            counts = f" It needs {self.needed} credits; {self.available} are free{held}."
        self.args = (
            f"{status} {self.code}: {self.title}{counts} Not retried: buy a credit pack or turn on automatic buying"
            " in the app (Plan > Credits), then retry with the same idempotency key.",
        )

    @property
    def needed(self) -> int | None:
        """The credits the task would hold (the most it could cost)."""
        return self.problem.get("needed")

    @property
    def available(self) -> int | None:
        """The organization's free credits now."""
        return self.problem.get("available")

    @property
    def held(self) -> int | None:
        """The credits open tasks hold now; they come back as those tasks end."""
        return self.problem.get("held")

    @property
    def reason(self) -> str | None:
        """Why no credits were bought for the task (see the class docstring)."""
        return self.problem.get("reason")

    @property
    def auto_buy(self) -> bool | None:
        """Whether automatic buying is on for the organization."""
        return self.problem.get("auto_buy")


class PermissionDeniedError(APIError):
    """403: the plan or the organization's state does not allow this. Never retried.

    Among the codes: ``api_key_paused`` (TaskToHuman support paused this key;
    ``problem["until"]`` and the message say until when) and
    ``address_blocked`` (requests from your network are blocked for a while).
    Both last until the rule ends: contact support.
    """


class NotFoundError(APIError):
    """404: no such task for this key (another workspace or mode, or too old)."""


class AttachmentRemovedError(APIError):
    """410 ``attachment_removed``: the file was removed to fit the organization's storage allowance.

    It stays listed on its task with ``removed: True``; the task and its
    decision are kept. Never retried: the file cannot come back.
    """

    def __init__(self, status: int, problem: Mapping[str, Any], retry_after: int | None = None) -> None:
        super().__init__(status, problem, retry_after)
        self.args = (f"{status} {self.code}: {self.title} Not retried: the file cannot be downloaded any more.",)


class ConflictError(APIError):
    """409: ``idempotency_conflict``, or ``task_already_finished`` with ``state`` and ``action``."""

    @property
    def state(self) -> str | None:
        return self.problem.get("state")

    @property
    def action(self) -> str | None:
        return self.problem.get("action")


class UnprocessableError(APIError):
    """422: ``no_owner_available``."""


class RateLimitError(APIError):
    """429: too many requests; ``retry_after`` holds the seconds to wait."""


class ServerError(APIError):
    """5xx: retried automatically where safe; retry later with the same idempotency key."""


class APIConnectionError(TaskToHumanError):
    """The request failed before an answer arrived: network error or timeout. ``__cause__`` has the reason."""


class WaitTimeoutError(TaskToHumanError):
    """``wait_for_decision`` ran out of time. ``task`` is the last task read."""

    def __init__(self, task: Mapping[str, Any]) -> None:
        self.task = task
        super().__init__(f"task {task.get('id')} is still {task.get('state')}")


class SignatureVerificationError(TaskToHumanError):
    """``verify_callback`` refused a callback.

    ``reason`` is ``missing_header``, ``malformed_header``,
    ``timestamp_out_of_tolerance`` or ``no_matching_signature``.
    """

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(f"callback signature refused: {reason}")


_BY_STATUS: dict[int, type[APIError]] = {
    400: ValidationError,
    401: AuthenticationError,
    402: LimitReachedError,
    403: PermissionDeniedError,
    404: NotFoundError,
    409: ConflictError,
    422: UnprocessableError,
    429: RateLimitError,
}


def fallback_code(status: int) -> str:
    if status >= 500:
        return "server_error"
    return _FALLBACK_CODES.get(status, f"http_{status}")


def error_for(status: int, problem: Mapping[str, Any], retry_after: int | None = None) -> APIError:
    """Build the error class that matches ``status`` (and, for 402 ``not_enough_credits`` and 410
    ``attachment_removed``, the code)."""
    if status == 402 and problem.get("code") == "not_enough_credits":
        return NotEnoughCreditsError(status, problem, retry_after)
    if status == 410 and problem.get("code") == "attachment_removed":
        return AttachmentRemovedError(status, problem, retry_after)
    cls = ServerError if status >= 500 else _BY_STATUS.get(status, APIError)
    return cls(status, problem, retry_after)
