"""The clients: ``TaskToHuman`` (sync) and ``AsyncTaskToHuman`` (a thin async wrapper)."""

from __future__ import annotations

import asyncio
import re
import ssl
import time
import uuid
from datetime import datetime, timezone
from email.message import Message
from email.utils import collapse_rfc2231_value
from typing import Any, AsyncIterator, Callable, Iterator, Sequence, cast

from ._errors import TaskToHumanError, WaitTimeoutError
from ._http import DEFAULT_BASE_URL, Transport
from ._types import (
    FINISHED_STATES,
    Approver,
    AttachmentFile,
    ChainStep,
    Entitlements,
    HumanList,
    Me,
    Task,
    TaskList,
    TaskType,
    TaskTypeList,
)

_UUID = re.compile(r"[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}")


def _task_path(task_id: str, suffix: str = "") -> str:
    # Refuse anything that is not a UUID, so an id can never change the request target.
    if not isinstance(task_id, str) or not _UUID.fullmatch(task_id):
        raise ValueError("task_id must be a task id (a UUID)")
    return f"/v1/tasks/{task_id}{suffix}"


_TASK_TYPE_KEY = re.compile(r"[A-Za-z0-9_-]{1,255}")


def _task_type_path(key: str) -> str:
    # Task type keys are letters, digits, "_" and "-": nothing else may change the request target.
    if not isinstance(key, str) or not _TASK_TYPE_KEY.fullmatch(key):
        raise ValueError("key must be a task type key (letters, digits, _ and -, such as approve_refund)")
    return f"/v1/task-types/{key}"


def _attachment_path(task_id: str, attachment_id: str) -> str:
    if not isinstance(attachment_id, str) or not _UUID.fullmatch(attachment_id):
        raise ValueError("attachment_id must be an attachment id (a UUID)")
    return _task_path(task_id, f"/attachments/{attachment_id}")


def _filename(headers: Message) -> str | None:
    # Content-Disposition's filename* (RFC 6266, UTF-8) wins over its plain, ASCII-only filename.
    plain: str | None = None
    for key, value in headers.get_params(failobj=[], header="content-disposition")[1:]:
        if key == "filename" and isinstance(value, tuple):
            return collapse_rfc2231_value(value)
        if key == "filename" and isinstance(value, str) and plain is None:
            plain = value
    return plain


_IDEMPOTENCY_KEY = re.compile(r"[\x21-\x7e](?:[\x20-\x7e]{0,253}[\x21-\x7e])?")


def _time_param(value: str | datetime) -> str:
    # A datetime is sent in UTC with a "Z", as the TypeScript SDK does; a naive one is ambiguous.
    if not isinstance(value, datetime):
        return value
    if value.tzinfo is None:
        raise ValueError("a time filter needs a timezone-aware datetime")
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _page_query(limit: int | None, cursor: str | None) -> dict[str, str]:
    query: dict[str, str] = {}
    if limit is not None:
        query["limit"] = str(limit)
    if cursor is not None:
        query["cursor"] = cursor
    return query


class TaskToHuman:
    """Client for the TaskToHuman public API (``/v1``).

    Server-side only: never ship the API key to a browser or an app.

    ``timeout`` applies to each attempt. A call can take longer when it is
    retried: up to ``max_retries`` more attempts, after a 0.5 s then 1 s
    backoff, or after the ``Retry-After`` of a 429/503 when it is 60 s or less.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        max_retries: int = 2,
        ssl_context: ssl.SSLContext | None = None,
    ) -> None:
        self._transport = Transport(api_key, base_url, timeout, max_retries, ssl_context)
        self._sleep: Callable[[float], None] = time.sleep
        self._clock: Callable[[], float] = time.monotonic

    def __repr__(self) -> str:
        return f"TaskToHuman(base_url={self._transport.base_url!r}, api_key='***')"

    # Tasks

    def create_task(
        self,
        task_type: str,
        *,
        title: str | None = None,
        payload: dict[str, Any] | None = None,
        callback_url: str | None = None,
        deadline_minutes: int | None = None,
        owner: str | None = None,
        approvers: Sequence[Approver] | None = None,
        chain: Sequence[ChainStep] | None = None,
        urgency: str | None = None,
        idempotency_key: str | None = None,
    ) -> Task:
        """Create a task and notify its first human (``POST /v1/tasks``).

        Pass an ``idempotency_key`` that names the real-world request (for
        example ``f"refund-{order_id}"``): retrying with it never asks a person
        twice. Without one a UUID is generated and reused for this call's own
        retries; it is on any error raised (``err.idempotency_key``).

        ``approvers`` is only for a task type with open steps (see
        ``list_task_types``): one entry per open step, ``{"step": 1, "human": id}``
        or ``{"step": 1, "email": address}``. It is left out of the request
        when ``None`` or empty.

        ``chain`` is only for a task type with ``chain_override`` (plan feature
        ``routing.chain_override``): this task's own chain, 1 to 10 steps, each
        ``{"human": id, "wait_seconds": n}`` (or ``"email"``) or a consensus
        step with ``approvers`` and ``approvals_needed``. It replaces the task
        type's whole chain and is refused with ``approvers`` or ``owner``. It is
        left out of the request when ``None`` or empty.

        ``urgency`` is ``"normal"`` (the default) or ``"high"``: a high-urgency
        task is marked in the app and its email subjects start with [Urgent];
        it never changes a timer. A routing rule of the workspace may change
        it, and the chain and tags.
        """
        fields: dict[str, Any] = {
            "task_type": task_type,
            "title": title,
            "payload": payload,
            "callback_url": callback_url,
            "deadline_minutes": deadline_minutes,
            "owner": owner,
            "urgency": urgency,
        }
        body = {k: v for k, v in fields.items() if v is not None}
        # No approvers (or chain) means no such property at all: the API reads null or [] as a
        # different request body when it compares a retry with the same Idempotency-Key.
        if approvers:
            body["approvers"] = list(approvers)
        if chain:
            body["chain"] = list(chain)
        key = idempotency_key if idempotency_key is not None else str(uuid.uuid4())
        if not isinstance(key, str) or not _IDEMPOTENCY_KEY.fullmatch(key):
            raise ValueError("idempotency_key must be 1 to 255 printable ASCII characters, no space at either end")
        try:
            return cast(Task, self._transport.request("POST", "/v1/tasks", body=body, headers={"Idempotency-Key": key}))
        except TaskToHumanError as err:
            err.idempotency_key = key
            raise

    def get_task(self, task_id: str) -> Task:
        """One task, with its ``payload``, ``payload_sha256`` and the decision's comment, fields and attachments."""
        return cast(Task, self._transport.request("GET", _task_path(task_id)))

    def download_task_attachment(self, task_id: str, attachment_id: str) -> AttachmentFile:
        """A file the person sent with their answer (``GET /v1/tasks/{id}/attachments/{attachmentId}``).

        ``attachment_id`` is the ``id`` of an entry of ``decision["attachments"]``
        (from ``get_task``, ``cancel_task`` or the callback); the request is
        built from the two ids, never from the entry's ``url``, so the key only
        goes to ``base_url``. Returns the bytes and the file name. Files are not
        virus-scanned. A task or file of another workspace or mode, or older
        than your plan's history, raises ``NotFoundError``; a file removed to
        fit the organization's storage allowance (listed with
        ``removed: True``) raises ``AttachmentRemovedError``.
        """
        content, headers = self._transport.request_raw(
            "GET",
            _attachment_path(task_id, attachment_id),
            headers={"Accept": "application/octet-stream, application/problem+json"},
        )
        return AttachmentFile(content=content, filename=_filename(headers))

    def list_tasks(
        self,
        *,
        state: str | None = None,
        task_type: str | None = None,
        created_after: str | datetime | None = None,
        created_before: str | datetime | None = None,
        finished_after: str | datetime | None = None,
        cursor: str | None = None,
        limit: int | None = None,
        expand: str | None = None,
    ) -> TaskList:
        """The key's tasks, newest first, without payloads or comments. ``limit`` is 1 to 100 (default 50).

        One page per call: while the answer has a ``next_cursor``
        (``page.get("next_cursor")``), pass it as ``cursor`` with the same
        filters for the next page, or use ``iter_tasks``.

        With ``finished_after``: only finished tasks whose ``finished_at`` is at
        or after that time, oldest finished first, then by id, paged the same way.
        When you poll, send the latest ``finished_at`` you have seen minus a
        margin (for example one minute) and skip the ids you already handled:
        a task can appear shortly after one with a later ``finished_at``.

        With ``finished_after`` and ``expand="details"`` (its only value),
        every task comes as ``get_task`` returns it (``payload``,
        ``payload_sha256``, the decision's comment, fields and attachments),
        so a poll needs no ``get_task`` per task; ``limit`` is then 1 to 25
        (default 25, a larger one is brought down to 25). ``expand`` without
        ``finished_after`` raises ``ValidationError``.
        """
        query: dict[str, str] = {}
        if state is not None:
            query["state"] = state
        if task_type is not None:
            query["task_type"] = task_type
        if created_after is not None:
            query["created_after"] = _time_param(created_after)
        if created_before is not None:
            query["created_before"] = _time_param(created_before)
        if finished_after is not None:
            query["finished_after"] = _time_param(finished_after)
        if cursor is not None:
            query["cursor"] = cursor
        if limit is not None:
            query["limit"] = str(limit)
        if expand is not None:
            query["expand"] = expand
        return cast(TaskList, self._transport.request("GET", "/v1/tasks", query=query))

    def iter_tasks(
        self,
        *,
        state: str | None = None,
        task_type: str | None = None,
        created_after: str | datetime | None = None,
        created_before: str | datetime | None = None,
        finished_after: str | datetime | None = None,
        cursor: str | None = None,
        limit: int | None = None,
        expand: str | None = None,
    ) -> Iterator[Task]:
        """Every task that matches, page after page: ``for task in tth.iter_tasks(state="resolved")``.

        Calls ``list_tasks`` with the same filters and follows ``next_cursor`` to
        the last page; ``limit`` is the page size (default 100; the API brings
        it down to 25 with ``expand="details"``) and ``cursor``, when given, is
        where it starts. Each task comes once, also when tasks
        are created meanwhile. No request is made before the first task is read.
        """
        while True:
            page = self.list_tasks(
                state=state,
                task_type=task_type,
                created_after=created_after,
                created_before=created_before,
                finished_after=finished_after,
                cursor=cursor,
                limit=100 if limit is None else limit,
                expand=expand,
            )
            yield from page["data"]
            cursor = page.get("next_cursor")
            if not cursor:
                return

    def cancel_task(self, task_id: str) -> Task:
        """Cancel an open task. A finished one raises ``ConflictError`` (``task_already_finished``)."""
        return cast(Task, self._transport.request("POST", _task_path(task_id, "/cancel"), retry="rate_limit"))

    def wait_for_decision(
        self,
        task_id: str,
        *,
        timeout: float = 600,
        initial_interval: float = 5,
        max_interval: float = 60,
    ) -> Task:
        """Poll until the task is resolved, expired or cancelled; return it.

        For scripts, tests and short agent turns. In production use a
        ``callback_url`` and ``verify_callback``. Returns the first finish;
        raises ``WaitTimeoutError`` (with ``.task``) when ``timeout`` seconds pass.
        Check ``decision["automatic"]`` before acting on the decision.
        """
        deadline = self._clock() + timeout
        interval = initial_interval
        while True:
            task = self.get_task(task_id)
            if task["state"] in FINISHED_STATES:
                return task
            remaining = deadline - self._clock()
            if remaining <= 0:
                raise WaitTimeoutError(task)
            self._sleep(min(interval, remaining))
            interval = min(interval * 2, max_interval)

    # Task types and humans

    def list_task_types(self, *, limit: int | None = None, cursor: str | None = None) -> TaskTypeList:
        """The workspace's task types, by key (``GET /v1/task-types``), on every plan.

        Each has its ``fields`` (what ``create_task(payload=...)`` takes),
        ``default_deadline_minutes`` and steps. A step whose ``assignment`` is
        ``at_creation`` or ``group`` is open: ``create_task`` must name its
        human in ``approvers``. With ``chain_override``, ``create_task`` may
        send its own ``chain`` instead. One page per call: ``limit`` is 1 to
        100 (default 50); while ``next_cursor`` is not ``None``, pass it as
        ``cursor`` for the next page.
        """
        return cast(TaskTypeList, self._transport.request("GET", "/v1/task-types", query=_page_query(limit, cursor)))

    def get_task_type(self, key: str) -> TaskType:
        """One task type by its key (``GET /v1/task-types/{key}``), exactly as ``list_task_types`` shows it.

        An unknown key, an archived task type or one of another workspace
        raises ``NotFoundError``. A key that is not letters, digits, ``_`` and
        ``-`` raises ``ValueError`` before anything is sent.
        """
        return cast(TaskType, self._transport.request("GET", _task_type_path(key)))

    def list_humans(
        self, *, group: str | None = None, limit: int | None = None, cursor: str | None = None
    ) -> HumanList:
        """The workspace's active humans, ``id`` and ``name`` only (``GET /v1/humans``).

        With ``group`` (a group id from ``list_task_types``), only that group's
        members; an unknown group gives an empty list. Pages like
        ``list_task_types``. Use the ids in ``create_task(approvers=[...])``
        or ``chain``. Raises ``PermissionDeniedError`` (``feature_not_in_plan``)
        without ``routing.approver_at_creation`` or ``routing.chain_override``,
        or with ``group`` without ``routing.human_groups``.
        """
        query: dict[str, str] = {}
        if group is not None:
            query["group"] = group
        query.update(_page_query(limit, cursor))
        return cast(HumanList, self._transport.request("GET", "/v1/humans", query=query))

    # The key and the plan

    def get_me(self) -> Me:
        """The organization, workspace and mode of the key (``GET /v1/me``)."""
        return cast(Me, self._transport.request("GET", "/v1/me"))

    def get_entitlements(self) -> Entitlements:
        """The plan and every feature and limit as it applies now (``GET /v1/entitlements``)."""
        return cast(Entitlements, self._transport.request("GET", "/v1/entitlements"))


class AsyncTaskToHuman:
    """The same calls as :class:`TaskToHuman`, awaitable.

    Each call runs the sync client in a worker thread (``asyncio.to_thread``),
    so there are no extra dependencies. A call already in flight cannot be
    interrupted, only bounded by ``timeout``. ``wait_for_decision`` sleeps with
    ``asyncio.sleep`` between checks.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        max_retries: int = 2,
        ssl_context: ssl.SSLContext | None = None,
    ) -> None:
        self._sync = TaskToHuman(
            api_key, base_url=base_url, timeout=timeout, max_retries=max_retries, ssl_context=ssl_context
        )

    def __repr__(self) -> str:
        return f"AsyncTaskToHuman(base_url={self._sync._transport.base_url!r}, api_key='***')"

    async def create_task(
        self,
        task_type: str,
        *,
        title: str | None = None,
        payload: dict[str, Any] | None = None,
        callback_url: str | None = None,
        deadline_minutes: int | None = None,
        owner: str | None = None,
        approvers: Sequence[Approver] | None = None,
        chain: Sequence[ChainStep] | None = None,
        urgency: str | None = None,
        idempotency_key: str | None = None,
    ) -> Task:
        return await asyncio.to_thread(
            self._sync.create_task,
            task_type,
            title=title,
            payload=payload,
            callback_url=callback_url,
            deadline_minutes=deadline_minutes,
            owner=owner,
            approvers=approvers,
            chain=chain,
            urgency=urgency,
            idempotency_key=idempotency_key,
        )

    async def get_task(self, task_id: str) -> Task:
        return await asyncio.to_thread(self._sync.get_task, task_id)

    async def download_task_attachment(self, task_id: str, attachment_id: str) -> AttachmentFile:
        return await asyncio.to_thread(self._sync.download_task_attachment, task_id, attachment_id)

    async def list_tasks(
        self,
        *,
        state: str | None = None,
        task_type: str | None = None,
        created_after: str | datetime | None = None,
        created_before: str | datetime | None = None,
        finished_after: str | datetime | None = None,
        cursor: str | None = None,
        limit: int | None = None,
        expand: str | None = None,
    ) -> TaskList:
        return await asyncio.to_thread(
            self._sync.list_tasks,
            state=state,
            task_type=task_type,
            created_after=created_after,
            created_before=created_before,
            finished_after=finished_after,
            cursor=cursor,
            limit=limit,
            expand=expand,
        )

    async def iter_tasks(
        self,
        *,
        state: str | None = None,
        task_type: str | None = None,
        created_after: str | datetime | None = None,
        created_before: str | datetime | None = None,
        finished_after: str | datetime | None = None,
        cursor: str | None = None,
        limit: int | None = None,
        expand: str | None = None,
    ) -> AsyncIterator[Task]:
        """Every task that matches, page after page: ``async for task in tth.iter_tasks(state="resolved")``."""
        while True:
            page = await self.list_tasks(
                state=state,
                task_type=task_type,
                created_after=created_after,
                created_before=created_before,
                finished_after=finished_after,
                cursor=cursor,
                limit=100 if limit is None else limit,
                expand=expand,
            )
            for task in page["data"]:
                yield task
            cursor = page.get("next_cursor")
            if not cursor:
                return

    async def cancel_task(self, task_id: str) -> Task:
        return await asyncio.to_thread(self._sync.cancel_task, task_id)

    async def wait_for_decision(
        self,
        task_id: str,
        *,
        timeout: float = 600,
        initial_interval: float = 5,
        max_interval: float = 60,
    ) -> Task:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        interval = initial_interval
        while True:
            task = await self.get_task(task_id)
            if task["state"] in FINISHED_STATES:
                return task
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise WaitTimeoutError(task)
            await asyncio.sleep(min(interval, remaining))
            interval = min(interval * 2, max_interval)

    async def list_task_types(self, *, limit: int | None = None, cursor: str | None = None) -> TaskTypeList:
        return await asyncio.to_thread(self._sync.list_task_types, limit=limit, cursor=cursor)

    async def get_task_type(self, key: str) -> TaskType:
        return await asyncio.to_thread(self._sync.get_task_type, key)

    async def list_humans(
        self, *, group: str | None = None, limit: int | None = None, cursor: str | None = None
    ) -> HumanList:
        return await asyncio.to_thread(self._sync.list_humans, group=group, limit=limit, cursor=cursor)

    async def get_me(self) -> Me:
        return await asyncio.to_thread(self._sync.get_me)

    async def get_entitlements(self) -> Entitlements:
        return await asyncio.to_thread(self._sync.get_entitlements)
