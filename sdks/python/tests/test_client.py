from __future__ import annotations

import json
import unittest
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Any

from _support import API_KEY, FakeAPI, Reply, fixture, unused_port_url

import tasktohuman
from tasktohuman import (
    APIConnectionError,
    APIError,
    AttachmentRemovedError,
    AuthenticationError,
    ConflictError,
    LimitReachedError,
    NotEnoughCreditsError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    ServerError,
    TaskToHuman,
    UnprocessableError,
    ValidationError,
    WaitTimeoutError,
)

TASK_ID = "01a1e3a7-6489-7106-aa3a-c976287f9999"


def notified_task(task_id: str = TASK_ID) -> dict[str, Any]:
    body = dict(fixture("create")["response"]["body"])
    body["id"] = task_id
    return body


class ClientTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.api = FakeAPI().start()
        self.addCleanup(self.api.stop)
        self.client = TaskToHuman(API_KEY, base_url=self.api.base_url, timeout=5)
        self.sleeps: list[float] = []
        self.client._transport._sleep = self.sleeps.append

    def call_create(self, example: dict[str, Any]) -> Any:
        body = example["request"]["body"]
        return self.client.create_task(
            body["task_type"],
            title=body.get("title"),
            payload=body.get("payload"),
            deadline_minutes=body.get("deadline_minutes"),
            idempotency_key=example["request"].get("headers", {}).get("Idempotency-Key"),
        )


class RecordedFixtureTests(ClientTestCase):
    def test_create_sends_the_documented_request(self) -> None:
        example = self.api.queue_fixture("create")
        task = self.call_create(example)
        self.assertEqual(task, example["response"]["body"])
        sent = self.api.requests[0]
        self.assertEqual(sent.method, "POST")
        self.assertEqual(sent.path, "/v1/tasks")
        self.assertEqual(sent.json(), example["request"]["body"])
        self.assertEqual(sent.headers["idempotency-key"], "refund-4821")
        self.assertEqual(sent.headers["authorization"], f"Bearer {API_KEY}")
        self.assertEqual(sent.headers["content-type"], "application/json")
        self.assertEqual(sent.headers["accept"], "application/json")
        self.assertEqual(sent.headers["user-agent"], f"tasktohuman-python/{tasktohuman.__version__}")

    def test_create_omits_unset_fields(self) -> None:
        self.api.queue(201, notified_task())
        self.client.create_task("approve_refund")
        self.assertEqual(self.api.requests[0].json(), {"task_type": "approve_refund"})

    def test_create_sends_every_documented_field(self) -> None:
        self.api.queue(201, notified_task())
        owner = "01a1dcba-b57a-7aa2-b6b1-05d81545c2ba"
        self.client.create_task(
            "approve_refund",
            title="t",
            payload={"order_id": "1"},
            callback_url="https://example.com/hook",
            deadline_minutes=5,
            owner=owner,
            idempotency_key="k",
        )
        self.assertEqual(
            self.api.requests[0].json(),
            {
                "task_type": "approve_refund",
                "title": "t",
                "payload": {"order_id": "1"},
                "callback_url": "https://example.com/hook",
                "deadline_minutes": 5,
                "owner": owner,
            },
        )

    def test_create_sends_urgency(self) -> None:
        self.api.queue(201, {**notified_task(), "urgency": "high", "tags": ["vip"]})
        task = self.client.create_task("approve_refund", urgency="high")
        self.assertEqual(self.api.requests[0].json(), {"task_type": "approve_refund", "urgency": "high"})
        self.assertEqual((task.get("urgency"), task.get("tags")), ("high", ["vip"]))

    def test_create_test_mode_task(self) -> None:
        example = self.api.queue_fixture("create-test")
        task = self.call_create(example)
        self.assertIs(task["test"], True)

    def test_replay_returns_the_original_task(self) -> None:
        example = self.api.queue_fixture("replay")
        task = self.call_create(example)
        self.assertEqual(task["id"], TASK_ID)

    def test_create_without_key_generates_a_uuid(self) -> None:
        self.api.queue(201, notified_task())
        self.client.create_task("approve_refund")
        key = self.api.requests[0].headers["idempotency-key"]
        self.assertRegex(key, r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    def test_get_and_get_resolved(self) -> None:
        for name in ("get", "get-resolved", "get-resolved-test"):
            with self.subTest(name):
                example = self.api.queue_fixture(name)
                task_id = example["request"]["path"].rsplit("/", 1)[1]
                task = self.client.get_task(task_id)
                self.assertEqual(task, example["response"]["body"])
                self.assertEqual(self.api.requests[-1].method, "GET")
                self.assertEqual(self.api.requests[-1].path, example["request"]["path"])
                self.assertEqual(self.api.requests[-1].body, b"")

    def test_resolved_task_carries_payload_hash_and_decision(self) -> None:
        self.api.queue_fixture("get-resolved")
        task = self.client.get_task(TASK_ID)
        self.assertEqual(len(task["payload_sha256"] or ""), 64)
        decision = task["decision"]
        assert decision is not None
        self.assertEqual(decision["action"], "approved")
        self.assertIs(decision["automatic"], False)

    def test_list_encodes_the_query(self) -> None:
        example = self.api.queue_fixture("list")
        tasks = self.client.list_tasks(state="notified", task_type="approve_refund", limit=2)
        self.assertEqual(tasks, example["response"]["body"])
        self.assertEqual(self.api.requests[0].path, example["request"]["path"])

    def test_list_without_filters(self) -> None:
        self.api.queue(200, {"data": []})
        self.assertEqual(self.client.list_tasks(), {"data": []})
        self.assertEqual(self.api.requests[0].path, "/v1/tasks")

    def test_list_time_filters_accept_datetime_and_string(self) -> None:
        self.api.queue(200, {"data": []})
        after = datetime(2026, 11, 1, 8, 30, tzinfo=timezone.utc)
        self.client.list_tasks(created_after=after, created_before="2026-11-02T00:00:00Z")
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.api.requests[0].path).query)
        self.assertEqual(query["created_after"], ["2026-11-01T08:30:00Z"])
        self.assertEqual(query["created_before"], ["2026-11-02T00:00:00Z"])

    def test_list_finished_after_and_cursor_are_sent(self) -> None:
        self.api.queue(200, {"data": []})
        self.api.queue(200, {"data": []})
        after = datetime(2026, 11, 16, 9, 0, tzinfo=timezone.utc)
        self.client.list_tasks(finished_after=after, limit=2)
        self.client.list_tasks(finished_after="2026-11-16T09:00:00Z", cursor="639000000000000000.01a1e3a7", limit=2)
        first = urllib.parse.parse_qs(urllib.parse.urlsplit(self.api.requests[0].path).query)
        self.assertEqual(first, {"finished_after": ["2026-11-16T09:00:00Z"], "limit": ["2"]})
        second = urllib.parse.parse_qs(urllib.parse.urlsplit(self.api.requests[1].path).query)
        self.assertEqual(second["cursor"], ["639000000000000000.01a1e3a7"])

    def test_list_without_next_cursor_is_the_last_page(self) -> None:
        example = self.api.queue_fixture("list")
        page = self.client.list_tasks(finished_after="2026-11-16T09:00:00Z")
        self.assertIsNone(page.get("next_cursor"))
        self.assertTrue(page["data"])
        for task in page["data"]:
            self.assertIn("finished_at", task)
        self.assertEqual(page, example["response"]["body"])

    def test_list_with_expand_details_gives_each_task_as_get_task_does(self) -> None:
        example = self.api.queue_fixture("list-finished-details")
        page = self.client.list_tasks(finished_after="2026-11-16T09:00:00Z", expand="details", limit=1)
        self.assertEqual(page, example["response"]["body"])
        sent, recorded = (urllib.parse.urlsplit(path) for path in (self.api.requests[0].path, example["request"]["path"]))
        self.assertEqual(sent.path, recorded.path)
        self.assertEqual(urllib.parse.parse_qs(sent.query), urllib.parse.parse_qs(recorded.query))
        task = page["data"][0]
        self.assertEqual(
            task.get("payload"),
            {"order_id": "4821", "amount": 249, "reason": "Arrived damaged", "customer_email": "marta@example.com"},
        )
        self.assertRegex(task.get("payload_sha256") or "", r"^[0-9a-f]{64}$")
        decision = task["decision"]
        assert decision is not None
        self.assertEqual(decision["comment"], "Photos confirm the damage.")
        self.assertEqual(decision.get("attachments"), [])
        # Every key of a single read is there.
        self.assertLessEqual(set(fixture("get-resolved")["response"]["body"]), set(task))
        self.assertEqual(page.get("next_cursor"), example["response"]["body"]["next_cursor"])

    def test_iter_tasks_passes_expand_on(self) -> None:
        self.api.queue(200, {"data": [], "next_cursor": None})
        self.assertEqual(list(self.client.iter_tasks(finished_after="2026-11-16T09:00:00Z", expand="details")), [])
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.api.requests[0].path).query)
        self.assertEqual(query["expand"], ["details"])

    def test_list_pages_through_a_tie_once_each(self) -> None:
        base = fixture("get-resolved")["response"]["body"]
        a, b, c = ({**base, "id": TASK_ID[:-1] + n} for n in "abc")
        self.api.queue(200, {"data": [a, b], "next_cursor": "page-2"})
        self.api.queue(200, {"data": [c]})
        seen: list[str] = []
        cursor: str | None = None
        while True:
            page = self.client.list_tasks(finished_after=base["finished_at"], limit=2, cursor=cursor)
            seen += [task["id"] for task in page["data"]]
            cursor = page.get("next_cursor")
            if cursor is None:
                break
        self.assertEqual(seen, [a["id"], b["id"], c["id"]])
        self.assertEqual(len(self.api.requests), 2)
        self.assertNotIn("cursor=", self.api.requests[0].path)
        self.assertIn("cursor=page-2", self.api.requests[1].path)

    def test_list_pages_the_default_order_with_cursor(self) -> None:
        base = fixture("get")["response"]["body"]
        a, b, c = ({**base, "id": TASK_ID[:-1] + n} for n in "abc")
        self.api.queue(200, {"data": [a, b], "next_cursor": "639000000000000000.01a1e3a7"})
        self.api.queue(200, {"data": [c]})
        first = self.client.list_tasks(state="notified", limit=2)
        self.assertEqual(first.get("next_cursor"), "639000000000000000.01a1e3a7")
        second = self.client.list_tasks(state="notified", limit=2, cursor=first.get("next_cursor"))
        self.assertIsNone(second.get("next_cursor"))
        self.assertEqual([t["id"] for t in first["data"] + second["data"]], [a["id"], b["id"], c["id"]])
        self.assertEqual(self.api.requests[0].path, "/v1/tasks?state=notified&limit=2")
        self.assertEqual(self.api.requests[1].path, "/v1/tasks?state=notified&cursor=639000000000000000.01a1e3a7&limit=2")

    def test_iter_tasks_follows_next_cursor_with_the_same_filters(self) -> None:
        base = fixture("get")["response"]["body"]
        tasks = [{**base, "id": TASK_ID[:-1] + n} for n in "abcde"]
        self.api.queue(200, {"data": tasks[:2], "next_cursor": "page-2"})
        self.api.queue(200, {"data": tasks[2:4], "next_cursor": "page-3"})
        self.api.queue(200, {"data": tasks[4:]})
        every = self.client.iter_tasks(task_type="approve_refund", limit=2)
        self.assertEqual(len(self.api.requests), 0)  # nothing is asked before the first task is read
        self.assertEqual([task["id"] for task in every], [task["id"] for task in tasks])
        self.assertEqual(
            [request.path for request in self.api.requests],
            [
                "/v1/tasks?task_type=approve_refund&limit=2",
                "/v1/tasks?task_type=approve_refund&cursor=page-2&limit=2",
                "/v1/tasks?task_type=approve_refund&cursor=page-3&limit=2",
            ],
        )

    def test_iter_tasks_asks_for_pages_of_100_starts_from_a_cursor_and_stops_with_the_caller(self) -> None:
        base = fixture("get")["response"]["body"]
        self.api.queue(200, {"data": [base, base], "next_cursor": "more"})
        self.api.queue(200, {"data": [base, base], "next_cursor": "more"})
        seen = 0
        for task in self.client.iter_tasks(cursor="page-2"):
            self.assertEqual(task["id"], base["id"])
            seen += 1
            if seen == 3:
                break
        self.assertEqual(
            [request.path for request in self.api.requests],
            ["/v1/tasks?cursor=page-2&limit=100", "/v1/tasks?cursor=more&limit=100"],
        )

    def test_iter_tasks_makes_one_call_when_the_list_fits_one_page(self) -> None:
        example = self.api.queue_fixture("list")
        self.assertEqual(list(self.client.iter_tasks(finished_after="2026-11-16T09:00:00Z")), example["response"]["body"]["data"])
        self.assertEqual(len(self.api.requests), 1)

    def test_cancel(self) -> None:
        example = self.api.queue_fixture("cancel")
        task_id = example["request"]["path"].split("/")[3]
        task = self.client.cancel_task(task_id)
        self.assertEqual(task["state"], "cancelled")
        self.assertEqual(self.api.requests[0].method, "POST")
        self.assertEqual(self.api.requests[0].path, example["request"]["path"])

    def test_cancel_finished_is_a_conflict_with_state_and_action(self) -> None:
        example = self.api.queue_fixture("cancel-finished")
        task_id = example["request"]["path"].split("/")[3]
        with self.assertRaises(ConflictError) as ctx:
            self.client.cancel_task(task_id)
        err = ctx.exception
        self.assertEqual(err.status, 409)
        self.assertEqual(err.code, "task_already_finished")
        self.assertEqual(err.state, "cancelled")
        self.assertEqual(err.action, "cancelled")
        self.assertEqual(err.trace_id, example["response"]["body"]["traceId"])
        self.assertEqual(len(self.api.requests), 1)

    def test_idempotency_conflict(self) -> None:
        example = self.api.queue_fixture("conflict")
        with self.assertRaises(ConflictError) as ctx:
            self.call_create(example)
        self.assertEqual(ctx.exception.code, "idempotency_conflict")
        self.assertEqual(ctx.exception.idempotency_key, example["request"]["headers"]["Idempotency-Key"])

    def test_out_of_credits_is_a_not_enough_credits_error_and_is_not_retried(self) -> None:
        example = self.api.queue_fixture("not-enough-credits")
        self.api.queue_fixture("create")  # what a retry would get: there must be none
        with self.assertRaises(NotEnoughCreditsError) as ctx:
            self.call_create(example)
        err = ctx.exception
        body = example["response"]["body"]
        self.assertIsInstance(err, LimitReachedError)
        self.assertEqual((err.status, err.code), (402, "not_enough_credits"))
        self.assertEqual(
            (err.needed, err.available, err.held, err.reason, err.auto_buy),
            (body["needed"], body["available"], body["held"], body["reason"], body["auto_buy"]),
        )
        self.assertEqual(err.idempotency_key, example["request"]["headers"]["Idempotency-Key"])
        self.assertEqual(err.trace_id, body["traceId"])
        held = f" and {body['held']} are held by open tasks" if body["held"] else ""
        self.assertIn(f"It needs {body['needed']} credits; {body['available']} are free{held}.", str(err))
        self.assertIn("buy a credit pack or turn on automatic buying", str(err))
        self.assertEqual(len(self.api.requests), 1)
        self.assertEqual(self.sleeps, [])

    def test_other_402_codes_stay_a_plain_limit_reached_error(self) -> None:
        for code in ("task_limit_reached", "test_task_limit_reached"):
            with self.subTest(code):
                before = len(self.api.requests)
                self.api.queue(402, {"title": "used up", "status": 402, "code": code, "reason": "plan_limit", "max": 100})
                with self.assertRaises(LimitReachedError) as ctx:
                    self.client.create_task("approve_refund")
                self.assertIs(type(ctx.exception), LimitReachedError)
                self.assertEqual(ctx.exception.problem["max"], 100)
                self.assertEqual(len(self.api.requests) - before, 1)

    def test_validation_errors_name_each_field(self) -> None:
        example = self.api.queue_fixture("validation")
        with self.assertRaises(ValidationError) as ctx:
            self.call_create(example)
        err = ctx.exception
        self.assertEqual(err.code, "validation_failed")
        assert err.errors is not None
        self.assertEqual(err.errors["payload.amount"][0]["code"], "field_invalid")
        self.assertEqual(len(self.api.requests), 1)

    def test_unknown_property(self) -> None:
        self.api.queue_fixture("unknown-property")
        with self.assertRaises(ValidationError) as ctx:
            self.client.create_task("approve_refund")
        assert ctx.exception.errors is not None
        codes = {m["code"] for messages in ctx.exception.errors.values() for m in messages}
        self.assertIn("unknown_property", codes)

    def test_unauthorized(self) -> None:
        self.api.queue_fixture("unauthorized")
        with self.assertRaises(AuthenticationError) as ctx:
            self.client.get_me()
        self.assertEqual(ctx.exception.code, "unauthorized")
        self.assertEqual(len(self.api.requests), 1)

    def test_me_and_entitlements(self) -> None:
        for name, call in (("me", self.client.get_me), ("me-test", self.client.get_me), ("entitlements", self.client.get_entitlements)):
            with self.subTest(name):
                example = self.api.queue_fixture(name)
                self.assertEqual(call(), example["response"]["body"])
                self.assertEqual(self.api.requests[-1].path, example["request"]["path"])


class QuorumTests(ClientTestCase):
    def test_task_on_a_consensus_step_carries_quorum(self) -> None:
        body = dict(fixture("get-resolved")["response"]["body"])
        body["quorum"] = {
            "needed": 2,
            "approvals": 2,
            "rejections": 1,
            "outcome": "met",
            "answers": [
                {"by": {"id": "01a1dcba-b57a-7aa2-b6b1-05d81545c2ba", "name": "Ana"}, "override": False, "answer": "approved", "at": "2026-11-16T09:12:03.120Z", "comment": None},
                {"by": {"id": "01a1dcba-c3f0-7d1e-9a52-6e0b4f7a1c33", "name": "Bruno"}, "override": False, "answer": "rejected", "at": "2026-11-16T09:15:41.004Z", "comment": "Too high for this customer."},
                {"by": {"id": "01a1dcba-d0aa-7f20-8c11-2b9e5d3f6a44", "name": "Carla"}, "override": False, "answer": "approved", "at": "2026-11-16T09:19:54.377Z", "comment": "Photos confirm the damage."},
            ],
        }
        self.api.queue(200, body)
        task = self.client.get_task(TASK_ID)
        quorum = task.get("quorum")
        assert quorum is not None
        self.assertEqual(quorum["outcome"], "met")
        self.assertEqual([a["answer"] for a in quorum["answers"]], ["approved", "rejected", "approved"])

    def test_single_human_task_has_no_quorum_key(self) -> None:
        self.api.queue_fixture("get")
        self.assertNotIn("quorum", self.client.get_task(fixture("get")["request"]["path"].rsplit("/", 1)[1]))


HUMAN_ID = "0199c1a4-6d2e-7b7a-9f43-2f1c6a1d8e55"
GROUP = {"id": "0199c1a4-7000-7b7a-9f43-2f1c6a1d8e55", "name": "Finance approvers"}
TASK_TYPES = {
    "data": [
        {
            "key": "approve_refund",
            "name": "Approve a refund",
            "kind": "approval",
            "steps": [
                {"step": 1, "assignment": "at_creation"},
                {"step": 2, "assignment": "group", "group": GROUP},
                {"step": 3, "assignment": "human"},
                {"step": 4, "assignment": "at_creation", "approvals_needed": 2, "max_approvers": 3},
            ],
            "chain_override": False,
            "fields": [
                {"key": "order_id", "label": "Order", "type": "text", "required": True, "sensitive": False, "editable": False}
            ],
            "default_deadline_minutes": None,
        }
    ],
    "next_cursor": None,
}
MARTA = {"id": HUMAN_ID, "name": "Marta"}
RUI = {"id": "0199c1a4-6d2e-7b7a-9f43-2f1c6a1d8e56", "name": None}


class ApproverTests(ClientTestCase):
    def test_approvers_are_sent_by_id_and_by_email(self) -> None:
        self.api.queue(201, notified_task())
        self.client.create_task(
            "approve_refund",
            approvers=[{"step": 1, "email": "marta@example.com"}, {"step": 3, "human": HUMAN_ID}],
            idempotency_key="refund-4822",
        )
        self.assertEqual(
            self.api.requests[0].json(),
            {
                "task_type": "approve_refund",
                "approvers": [{"step": 1, "email": "marta@example.com"}, {"step": 3, "human": HUMAN_ID}],
            },
        )

    def test_approvers_are_left_out_when_none_or_empty(self) -> None:
        for approvers in (None, [], ()):
            with self.subTest(approvers=approvers):
                self.api.queue(201, notified_task())
                self.client.create_task("approve_refund", approvers=approvers)
                sent = self.api.requests[-1]
                self.assertNotIn("approvers", sent.json())
                self.assertEqual(sent.body, b'{"task_type":"approve_refund"}')
        self.api.queue(201, notified_task())
        self.client.create_task("approve_refund")
        self.assertNotIn("approvers", self.api.requests[-1].json())

    def test_a_refused_approver_names_the_entry(self) -> None:
        errors = {"approvers.0": [{"code": "approver_not_in_group", "message": "Step 2: not a member of the group."}]}
        self.api.queue(400, {"title": "The request is not valid.", "status": 400, "code": "validation_failed", "errors": errors})
        with self.assertRaises(ValidationError) as ctx:
            self.client.create_task("approve_refund", approvers=[{"step": 2, "human": HUMAN_ID}])
        assert ctx.exception.errors is not None
        self.assertEqual(ctx.exception.errors["approvers.0"][0]["code"], "approver_not_in_group")


class ChainTests(ClientTestCase):
    CHAIN = [
        {"human": HUMAN_ID, "wait_seconds": 3600},
        {
            "approvers": [{"email": "cfo@example.com", "can_decide_alone": True}, {"human": HUMAN_ID}],
            "approvals_needed": 2,
            "wait_seconds": 86400,
            "remind": False,
        },
    ]

    def test_a_non_empty_chain_is_sent_as_given(self) -> None:
        self.api.queue(201, notified_task())
        self.client.create_task("approve_refund", chain=self.CHAIN, idempotency_key="refund-4822")
        self.assertEqual(self.api.requests[0].json(), {"task_type": "approve_refund", "chain": self.CHAIN})

    def test_chain_is_left_out_when_none_or_empty(self) -> None:
        for chain in (None, [], ()):
            with self.subTest(chain=chain):
                self.api.queue(201, notified_task())
                self.client.create_task("approve_refund", chain=chain)
                self.assertEqual(self.api.requests[-1].body, b'{"task_type":"approve_refund"}')

    def test_a_refused_override_carries_the_chain_code(self) -> None:
        errors = {"chain": [{"code": "chain_override_not_allowed", "message": "This task type doesn't allow it."}]}
        self.api.queue(400, {"title": "The request is not valid.", "status": 400, "code": "validation_failed", "errors": errors})
        with self.assertRaises(ValidationError) as ctx:
            self.client.create_task("approve_refund", chain=[{"human": HUMAN_ID, "wait_seconds": 3600}])
        assert ctx.exception.errors is not None
        self.assertEqual(ctx.exception.errors["chain"][0]["code"], "chain_override_not_allowed")


class TaskTypeAndHumanListTests(ClientTestCase):
    def test_list_task_types_returns_the_steps(self) -> None:
        self.api.queue(200, TASK_TYPES)
        listed = self.client.list_task_types()
        self.assertEqual(listed, TASK_TYPES)
        self.assertEqual(self.api.requests[0].method, "GET")
        self.assertEqual(self.api.requests[0].path, "/v1/task-types")
        steps = listed["data"][0]["steps"]
        self.assertEqual([s["step"] for s in steps if s["assignment"] != "human"], [1, 2, 4])
        self.assertEqual((steps[1].get("group") or {}).get("id"), GROUP["id"])
        # An open consensus step: name between approvals_needed and max_approvers people for it.
        self.assertEqual((steps[3].get("approvals_needed"), steps[3].get("max_approvers")), (2, 3))
        self.assertIsNone(steps[0].get("approvals_needed"))

    def test_list_task_types_pages_with_limit_and_cursor(self) -> None:
        self.api.queue(200, {"data": TASK_TYPES["data"], "next_cursor": "c2 +/="})
        self.api.queue(200, {"data": [], "next_cursor": None})
        keys: list[str] = []
        cursor = None
        while True:
            page = self.client.list_task_types(limit=1, cursor=cursor)
            keys += [task_type["key"] for task_type in page["data"]]
            cursor = page["next_cursor"]
            if cursor is None:
                break
        self.assertEqual(keys, ["approve_refund"])
        self.assertEqual(
            [r.path for r in self.api.requests],
            ["/v1/task-types?limit=1", "/v1/task-types?limit=1&cursor=c2+%2B%2F%3D"],
        )

    def test_list_task_types_returns_the_recorded_page_with_fields(self) -> None:
        example = self.api.queue_fixture("task-types")
        listed = self.client.list_task_types(limit=1)
        self.assertEqual(listed, example["response"]["body"])
        self.assertEqual(self.api.requests[0].path, example["request"]["path"])
        refund = listed["data"][0]
        self.assertEqual([f["key"] for f in refund["fields"] if f["required"]], ["order_id", "amount", "reason"])
        self.assertEqual(refund["default_deadline_minutes"], 1440)

    def test_get_task_type_reads_one_type_as_the_list_shows_it(self) -> None:
        example = self.api.queue_fixture("task-type")
        task_type = self.client.get_task_type("approve_refund")
        self.assertEqual(task_type, example["response"]["body"])
        self.assertEqual(self.api.requests[0].method, "GET")
        self.assertEqual(self.api.requests[0].path, example["request"]["path"])
        self.assertEqual(task_type, fixture("task-types")["response"]["body"]["data"][0])
        email = next(f for f in task_type["fields"] if f["type"] == "email")
        self.assertEqual((email["key"], email["sensitive"], email["required"]), ("customer_email", True, False))

    def test_get_task_type_unknown_is_not_found(self) -> None:
        self.api.queue(404, {"title": "Not found.", "status": 404, "code": "not_found"})
        with self.assertRaises(NotFoundError) as ctx:
            self.client.get_task_type("archived_type")
        self.assertEqual(ctx.exception.code, "not_found")
        self.assertEqual([r.path for r in self.api.requests], ["/v1/task-types/archived_type"])

    def test_get_task_type_refuses_a_key_that_could_change_the_path(self) -> None:
        for key in ("", "..", "a/b", "approve_refund?x=1", "approve refund", "a%2Fb", "x" * 256, None):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.client.get_task_type(key)  # type: ignore[arg-type]
        self.assertEqual(self.api.requests, [])

    def test_list_humans_returns_ids_and_names(self) -> None:
        body = {"data": [MARTA, RUI], "next_cursor": None}
        self.api.queue(200, body)
        self.assertEqual(self.client.list_humans(), body)
        self.assertEqual(self.api.requests[0].method, "GET")
        self.assertEqual(self.api.requests[0].path, "/v1/humans")

    def test_list_humans_filters_by_group_and_pages(self) -> None:
        self.api.queue(200, {"data": [MARTA], "next_cursor": "next"})
        self.api.queue(200, {"data": [RUI], "next_cursor": None})
        first = self.client.list_humans(group=GROUP["id"], limit=1)
        second = self.client.list_humans(group=GROUP["id"], limit=1, cursor=first["next_cursor"])
        self.assertEqual(first["data"] + second["data"], [MARTA, RUI])
        self.assertIsNone(second["next_cursor"])
        self.assertEqual(
            [r.path for r in self.api.requests],
            [f"/v1/humans?group={GROUP['id']}&limit=1", f"/v1/humans?group={GROUP['id']}&limit=1&cursor=next"],
        )

    def test_feature_not_in_plan_is_a_permission_error_with_the_feature(self) -> None:
        problem = {
            "type": "https://docs.tasktohuman.com/errors#feature_not_in_plan",
            "title": "Your plan does not include this feature.",
            "status": 403,
            "code": "feature_not_in_plan",
            "feature": "routing.human_groups",
            "available_from": "team",
            "traceId": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        }
        calls = (lambda: self.client.list_humans(group=GROUP["id"]), lambda: self.client.list_task_types())
        for call in calls:
            self.api.queue(403, problem)
            with self.assertRaises(PermissionDeniedError) as ctx:
                call()
            err = ctx.exception
            self.assertEqual(err.status, 403)
            self.assertEqual(err.code, "feature_not_in_plan")
            self.assertEqual(err.title, problem["title"])
            self.assertEqual(err.problem["feature"], "routing.human_groups")
            self.assertEqual(err.problem["available_from"], "team")
            self.assertEqual(err.trace_id, problem["traceId"])
        self.assertEqual(len(self.api.requests), 2)  # a 403 is never retried
        self.assertEqual(self.sleeps, [])

    def test_open_steps_not_available_is_a_permission_error(self) -> None:
        self.api.queue(403, {"title": "Open steps are not available yet.", "status": 403, "code": "open_steps_not_available"})
        with self.assertRaises(PermissionDeniedError) as ctx:
            self.client.list_task_types()
        self.assertEqual(ctx.exception.code, "open_steps_not_available")


class ErrorMappingTests(ClientTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.client = TaskToHuman(API_KEY, base_url=self.api.base_url, max_retries=0)

    def test_status_classes(self) -> None:
        cases = [
            (402, "task_limit_reached", LimitReachedError),
            (403, "feature_not_in_plan", PermissionDeniedError),
            (404, "not_found", NotFoundError),
            (422, "no_owner_available", UnprocessableError),
            (429, "rate_limited", RateLimitError),
            (500, "server_error", ServerError),
            (418, "teapot", APIError),
        ]
        for status, code, cls in cases:
            with self.subTest(status):
                self.api.queue(status, {"title": "x", "status": status, "code": code, "feature": "intake.api"})
                with self.assertRaises(cls) as ctx:
                    self.client.get_task(TASK_ID)
                self.assertIs(type(ctx.exception), cls)
                self.assertEqual(ctx.exception.code, code)
                self.assertEqual(ctx.exception.problem["feature"], "intake.api")

    def test_non_json_bodies_get_the_documented_codes(self) -> None:
        cases = [(502, "server_error"), (503, "server_error"), (429, "rate_limited"), (401, "unauthorized"), (404, "not_found"), (418, "http_418")]
        for status, code in cases:
            with self.subTest(status):
                self.api.queue(status, raw=b"<html>Bad gateway</html>")
                with self.assertRaises(APIError) as ctx:
                    self.client.get_task(TASK_ID)
                self.assertEqual(ctx.exception.status, status)
                self.assertEqual(ctx.exception.code, code)

    def test_a_paused_key_and_a_blocked_address_are_permission_errors_with_the_message_never_retried(self) -> None:
        # Built inline: fixtures/api has no example of these (it is synced from the server).
        client = TaskToHuman(API_KEY, base_url=self.api.base_url)  # default retries
        client._transport._sleep = self.sleeps.append
        paused = {
            "title": "This API key is paused by TaskToHuman support until 2026-11-27 14:30 UTC. Contact support.",
            "status": 403,
            "code": "api_key_paused",
            "until": "2026-11-27 14:30 UTC",
        }
        blocked = {
            "title": "Access from your network is temporarily blocked. If you think this is a mistake, contact support.",
            "status": 403,
            "code": "address_blocked",
        }
        for problem in (paused, blocked):
            with self.subTest(problem["code"]):
                before = len(self.api.requests)
                self.api.queue(403, problem)
                with self.assertRaises(PermissionDeniedError) as ctx:
                    client.get_task(TASK_ID)
                self.assertEqual(ctx.exception.code, problem["code"])
                self.assertIn(str(problem["title"]), str(ctx.exception))
                self.assertEqual(ctx.exception.problem.get("until"), problem.get("until"))
                self.assertEqual(len(self.api.requests) - before, 1)
        self.assertEqual(self.sleeps, [])

    def test_test_task_limit_is_a_limit_error_with_its_data(self) -> None:
        problem = {"title": "used up", "status": 402, "code": "test_task_limit_reached", "reason": "test_limit", "limit": "limit.test_tasks_month", "max": 10, "available_from": "starter"}
        self.api.queue(402, problem)
        with self.assertRaises(LimitReachedError) as ctx:
            self.client.create_task("approve_refund")
        self.assertEqual(ctx.exception.problem["max"], 10)
        self.assertEqual(len(self.api.requests), 1)


class RetryTests(ClientTestCase):
    def test_429_honours_retry_after_then_succeeds(self) -> None:
        self.api.queue(429, {"title": "slow down", "status": 429, "code": "rate_limited"}, headers={"Retry-After": "7"})
        self.api.queue(200, notified_task())
        self.client.get_task(TASK_ID)
        self.assertEqual(self.sleeps, [7.0])
        self.assertEqual(len(self.api.requests), 2)

    def test_429_gives_up_after_max_retries(self) -> None:
        for _ in range(3):
            self.api.queue(429, {"title": "slow down", "status": 429, "code": "rate_limited"}, headers={"Retry-After": "1"})
        with self.assertRaises(RateLimitError) as ctx:
            self.client.list_tasks()
        self.assertEqual(ctx.exception.retry_after, 1)
        self.assertEqual(len(self.api.requests), 3)
        self.assertEqual(self.sleeps, [1.0, 1.0])

    def test_retry_after_over_60_seconds_is_not_waited_for(self) -> None:
        self.api.queue(429, {"title": "slow down", "status": 429, "code": "rate_limited"}, headers={"Retry-After": "61"})
        with self.assertRaises(RateLimitError) as ctx:
            self.client.get_task(TASK_ID)
        self.assertEqual(ctx.exception.retry_after, 61)
        self.assertEqual(self.sleeps, [])

    def test_non_integer_retry_after_falls_back_to_backoff(self) -> None:
        self.api.queue(429, {"title": "x", "status": 429, "code": "rate_limited"}, headers={"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"})
        self.api.queue(429, {"title": "x", "status": 429, "code": "rate_limited"})
        self.api.queue(200, notified_task())
        self.client.get_task(TASK_ID)
        self.assertEqual(self.sleeps, [0.5, 1.0])

    def test_503_with_retry_after_then_success(self) -> None:
        self.api.queue(503, raw=b"unavailable", headers={"Retry-After": "2"})
        self.api.queue(200, notified_task())
        self.client.get_task(TASK_ID)
        self.assertEqual(self.sleeps, [2.0])

    def test_5xx_backoff(self) -> None:
        self.api.queue(500, {"title": "x", "status": 500, "code": "server_error"})
        self.api.queue(502, raw=b"bad gateway")
        self.api.queue(200, {"data": []})
        self.client.list_tasks()
        self.assertEqual(self.sleeps, [0.5, 1.0])

    def test_create_retries_reuse_the_generated_key(self) -> None:
        self.api.queue(503, {"title": "x", "status": 503, "code": "server_error"})
        self.api.replies.append(Reply(drop=True))
        self.api.queue(201, notified_task())
        self.client.create_task("approve_refund", payload={"order_id": "1"})
        keys = {r.headers["idempotency-key"] for r in self.api.requests}
        bodies = {r.body for r in self.api.requests}
        self.assertEqual(len(self.api.requests), 3)
        self.assertEqual(len(keys), 1)
        self.assertEqual(len(bodies), 1)

    def test_cancel_is_not_retried_on_5xx(self) -> None:
        self.api.queue(503, {"title": "x", "status": 503, "code": "server_error"})
        with self.assertRaises(ServerError):
            self.client.cancel_task(TASK_ID)
        self.assertEqual(len(self.api.requests), 1)

    def test_cancel_is_not_retried_on_a_network_error(self) -> None:
        self.api.replies.append(Reply(drop=True))
        with self.assertRaises(APIConnectionError):
            self.client.cancel_task(TASK_ID)
        self.assertEqual(len(self.api.requests), 1)

    def test_cancel_is_retried_on_429(self) -> None:
        self.api.queue(429, {"title": "x", "status": 429, "code": "rate_limited"}, headers={"Retry-After": "3"})
        self.api.queue_fixture("cancel")
        self.client.cancel_task(TASK_ID)
        self.assertEqual(self.sleeps, [3.0])

    def test_4xx_is_never_retried(self) -> None:
        for status in (400, 401, 402, 403, 404, 409, 422):
            with self.subTest(status):
                before = len(self.api.requests)
                self.api.queue(status, {"title": "x", "status": status, "code": "c"})
                with self.assertRaises(APIError):
                    self.client.create_task("approve_refund")
                self.assertEqual(len(self.api.requests) - before, 1)
        self.assertEqual(self.sleeps, [])

    def test_max_retries_zero(self) -> None:
        client = TaskToHuman(API_KEY, base_url=self.api.base_url, max_retries=0)
        self.api.queue(503, {"title": "x", "status": 503, "code": "server_error"})
        with self.assertRaises(ServerError):
            client.get_task(TASK_ID)
        self.assertEqual(len(self.api.requests), 1)


class NetworkTests(unittest.TestCase):
    def test_network_error_after_retries(self) -> None:
        client = TaskToHuman(API_KEY, base_url=unused_port_url(), timeout=2)
        sleeps: list[float] = []
        client._transport._sleep = sleeps.append
        with self.assertRaises(APIConnectionError) as ctx:
            client.get_task(TASK_ID)
        self.assertIsNotNone(ctx.exception.__cause__)
        self.assertEqual(sleeps, [0.5, 1.0])

    def test_create_network_error_carries_the_idempotency_key(self) -> None:
        client = TaskToHuman(API_KEY, base_url=unused_port_url(), max_retries=0)
        with self.assertRaises(APIConnectionError) as ctx:
            client.create_task("approve_refund")
        self.assertRegex(ctx.exception.idempotency_key or "", r"^[0-9a-f-]{36}$")
        with self.assertRaises(APIConnectionError) as ctx:
            client.create_task("approve_refund", idempotency_key="refund-4821")
        self.assertEqual(ctx.exception.idempotency_key, "refund-4821")


ATTACHMENT_ID = "0199c1a4-9a00-7b7a-9f43-2f1c6a1d8e55"


class AttachmentTests(ClientTestCase):
    def test_decision_fields_and_attachments_are_returned(self) -> None:
        body = dict(fixture("get-resolved")["response"]["body"])
        attachment = {
            "id": ATTACHMENT_ID,
            "field": "receipt",
            "name": "receipt.pdf",
            "size": 3,
            "content_type": "application/pdf",
            "sha256": "ab" * 32,
            "url": f"{self.api.base_url}/v1/tasks/{TASK_ID}/attachments/{ATTACHMENT_ID}",
        }
        body["decision"] = {**body["decision"], "fields": {"note": "ok"}, "attachments": [attachment]}
        self.api.queue(200, body)
        decision = self.client.get_task(TASK_ID)["decision"]
        assert decision is not None
        self.assertEqual(decision.get("fields"), {"note": "ok"})
        self.assertEqual(decision.get("attachments"), [attachment])

    def test_download_returns_the_bytes_and_the_file_name(self) -> None:
        disposition = "attachment; filename=\"receipt _.pdf\"; filename*=UTF-8''receipt%20%E2%82%AC.pdf"
        content = b"%PDF\x00\xff"
        self.api.queue(200, raw=content, headers={"Content-Type": "application/octet-stream", "Content-Disposition": disposition})
        file = self.client.download_task_attachment(TASK_ID, ATTACHMENT_ID)
        self.assertEqual(file, tasktohuman.AttachmentFile(content=content, filename="receipt \u20ac.pdf"))
        sent = self.api.requests[0]
        self.assertEqual((sent.method, sent.path), ("GET", f"/v1/tasks/{TASK_ID}/attachments/{ATTACHMENT_ID}"))
        self.assertEqual(sent.headers["accept"], "application/octet-stream, application/problem+json")
        self.assertEqual(sent.headers["authorization"], f"Bearer {API_KEY}")
        self.assertEqual(repr(file), "AttachmentFile(filename='receipt \u20ac.pdf', size=6)")  # never the bytes

    def test_download_file_name_without_filename_star_or_header(self) -> None:
        self.api.queue(200, raw=b"x", headers={"Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename=scan.png"})
        self.assertEqual(self.client.download_task_attachment(TASK_ID, ATTACHMENT_ID).filename, "scan.png")
        self.api.queue(200, raw=b"", headers={"Content-Type": "application/octet-stream"})
        self.assertEqual(self.client.download_task_attachment(TASK_ID, ATTACHMENT_ID), tasktohuman.AttachmentFile(b"", None))

    def test_download_404_is_not_found_with_or_without_a_problem(self) -> None:
        self.api.queue(404, {"title": "Not found.", "status": 404, "code": "not_found"})
        self.api.queue(404, raw=b"")
        for _ in range(2):
            with self.assertRaises(NotFoundError) as ctx:
                self.client.download_task_attachment(TASK_ID, ATTACHMENT_ID)
            self.assertEqual(ctx.exception.code, "not_found")
        self.assertEqual(len(self.api.requests), 2)

    def test_a_removed_file_is_listed_with_removed_and_its_download_is_an_attachment_removed_error(self) -> None:
        body = dict(fixture("get-resolved")["response"]["body"])
        removed = {
            "id": ATTACHMENT_ID,
            "field": "receipt",
            "name": "",
            "size": 0,
            "content_type": "application/pdf",
            "sha256": "ab" * 32,
            "url": f"{self.api.base_url}/v1/tasks/{TASK_ID}/attachments/{ATTACHMENT_ID}",
            "removed": True,
            "removed_at": "2026-11-20T10:00:00Z",
            "removed_reason": "storage_allowance",
        }
        body["decision"] = {**body["decision"], "attachments": [removed]}
        self.api.queue(200, body)
        decision = self.client.get_task(TASK_ID)["decision"]
        assert decision is not None
        attachments = decision.get("attachments") or []
        self.assertTrue(attachments[0].get("removed"))
        self.assertEqual(attachments[0].get("removed_reason"), "storage_allowance")

        title = "This file was removed to fit the organization's storage allowance. The task and its decision are kept."
        self.api.queue(410, {"title": title, "status": 410, "code": "attachment_removed"})
        with self.assertRaises(AttachmentRemovedError) as ctx:
            self.client.download_task_attachment(TASK_ID, ATTACHMENT_ID)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (410, "attachment_removed"))
        self.assertIn(title, str(ctx.exception))
        self.assertIn("Not retried", str(ctx.exception))
        self.assertEqual(len(self.api.requests), 2)  # the get and one download, never retried

    def test_another_410_code_stays_a_plain_api_error(self) -> None:
        self.api.queue(410, {"title": "Gone.", "status": 410, "code": "gone"})
        with self.assertRaises(APIError) as ctx:
            self.client.download_task_attachment(TASK_ID, ATTACHMENT_ID)
        self.assertIs(type(ctx.exception), APIError)

    def test_download_is_retried_on_a_5xx(self) -> None:
        self.api.queue(503, {"title": "Unavailable.", "status": 503, "code": "server_error"})
        self.api.queue(200, raw=b"ok", headers={"Content-Type": "application/octet-stream"})
        self.assertEqual(self.client.download_task_attachment(TASK_ID, ATTACHMENT_ID).content, b"ok")
        self.assertEqual(len(self.api.requests), 2)

    def test_download_refuses_a_redirect(self) -> None:
        target = FakeAPI().start()
        self.addCleanup(target.stop)
        self.api.queue(302, None, headers={"Location": target.base_url + "/file"})
        with self.assertRaises(APIError) as ctx:
            self.client.download_task_attachment(TASK_ID, ATTACHMENT_ID)
        self.assertEqual(ctx.exception.status, 302)
        self.assertEqual(target.requests, [])

    def test_ids_must_be_uuids(self) -> None:
        for task_id, attachment_id in ((TASK_ID, "../../me"), (TASK_ID, ""), ("../me", ATTACHMENT_ID), (TASK_ID, f"{ATTACHMENT_ID}?x=1")):
            with self.subTest((task_id, attachment_id)), self.assertRaises(ValueError):
                self.client.download_task_attachment(task_id, attachment_id)
        self.assertEqual(self.api.requests, [])


class RedirectTests(ClientTestCase):
    def test_redirects_are_refused_and_not_followed(self) -> None:
        target = FakeAPI().start()
        self.addCleanup(target.stop)
        self.api.queue(302, {"title": "moved"}, headers={"Location": target.base_url + "/v1/me"})
        with self.assertRaises(APIError) as ctx:
            self.client.get_me()
        self.assertEqual(ctx.exception.status, 302)
        self.assertEqual(ctx.exception.code, "http_302")
        self.assertEqual(target.requests, [])
        self.assertEqual(len(self.api.requests), 1)

    def test_307_on_create_is_refused(self) -> None:
        self.api.queue(307, None, headers={"Location": self.api.base_url + "/v1/elsewhere"})
        with self.assertRaises(APIError) as ctx:
            self.client.create_task("approve_refund")
        self.assertEqual(ctx.exception.status, 307)
        self.assertEqual(len(self.api.requests), 1)


class InputTests(unittest.TestCase):
    def test_base_url_rules(self) -> None:
        for ok, expected in (
            ("https://api.tasktohuman.com/", "https://api.tasktohuman.com"),
            ("https://api.example.com//", "https://api.example.com"),
            ("http://localhost:8080", "http://localhost:8080"),
            ("http://api.localhost:8080/", "http://api.localhost:8080"),
            ("http://127.0.0.1:9000", "http://127.0.0.1:9000"),
        ):
            with self.subTest(ok):
                self.assertEqual(TaskToHuman(API_KEY, base_url=ok)._transport.base_url, expected)
        for bad in ("http://api.tasktohuman.com", "ftp://x", "api.tasktohuman.com", "https://u:p@x.com", "https://x.com?a=1", "http://localhost.evil.com"):
            with self.subTest(bad), self.assertRaises(ValueError):
                TaskToHuman(API_KEY, base_url=bad)

    def test_default_base_url(self) -> None:
        self.assertEqual(TaskToHuman(API_KEY)._transport.base_url, "https://api.tasktohuman.com")

    def test_api_key_is_required(self) -> None:
        for bad in ("", "   ", None):
            with self.subTest(bad), self.assertRaises(ValueError):
                TaskToHuman(bad)  # type: ignore[arg-type]

    def test_task_id_must_be_a_uuid(self) -> None:
        api = FakeAPI().start()
        self.addCleanup(api.stop)
        client = TaskToHuman(API_KEY, base_url=api.base_url)
        for bad in ("../me", "x?y=1", "01a1e3a7-6489-7106-aa3a-c976287f9999#x", "01a1e3a7-6489-7106-aa3a-c976287f9999/cancel", "", "%2e%2e"):
            with self.subTest(bad):
                with self.assertRaises(ValueError):
                    client.get_task(bad)
                with self.assertRaises(ValueError):
                    client.cancel_task(bad)
                with self.assertRaises(ValueError):
                    client.wait_for_decision(bad)
        self.assertEqual(api.requests, [])

    def test_naive_datetime_is_refused(self) -> None:
        api = FakeAPI().start()
        self.addCleanup(api.stop)
        client = TaskToHuman(API_KEY, base_url=api.base_url)
        with self.assertRaises(ValueError):
            client.list_tasks(created_after=datetime(2026, 11, 1, 8, 30))
        self.assertEqual(api.requests, [])

    def test_aware_datetime_is_sent_in_utc(self) -> None:
        api = FakeAPI().start()
        self.addCleanup(api.stop)
        api.queue(200, {"data": []})
        plus_two = timezone(timedelta(hours=2))
        TaskToHuman(API_KEY, base_url=api.base_url).list_tasks(created_before=datetime(2026, 11, 1, 10, 30, tzinfo=plus_two))
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(api.requests[0].path).query)
        self.assertEqual(query["created_before"], ["2026-11-01T08:30:00Z"])

    def test_bad_idempotency_key_is_refused_before_sending(self) -> None:
        api = FakeAPI().start()
        self.addCleanup(api.stop)
        client = TaskToHuman(API_KEY, base_url=api.base_url)
        for bad in ("", " refund-1", "refund-1 ", "refund\n1", "refund-\u00e9", "x" * 256):
            with self.subTest(bad), self.assertRaises(ValueError):
                client.create_task("approve_refund", idempotency_key=bad)
        self.assertEqual(api.requests, [])


class SecretLeakTests(unittest.TestCase):
    def assert_no_key(self, *texts: str) -> None:
        for text in texts:
            self.assertNotIn(API_KEY, text)
            self.assertNotIn("SECRETKEYVALUE", text)

    def describe(self, err: BaseException) -> list[str]:
        out = [str(err), repr(err), repr(err.args), json.dumps(vars(err), default=repr)]
        cause = err.__cause__ or err.__context__
        if cause is not None:
            out += [str(cause), repr(cause)]
        return out

    def test_repr_hides_the_key(self) -> None:
        client = TaskToHuman(API_KEY)
        self.assert_no_key(repr(client), str(client), repr(client._transport))
        self.assert_no_key(repr(tasktohuman.AsyncTaskToHuman(API_KEY)))

    def test_errors_hide_the_key(self) -> None:
        api = FakeAPI().start()
        self.addCleanup(api.stop)
        client = TaskToHuman(API_KEY, base_url=api.base_url, max_retries=0)
        api.queue_fixture("unauthorized")
        api.queue(500, raw=b"oops")
        for call in (client.get_me, client.get_entitlements):
            with self.assertRaises(APIError) as ctx:
                call()
            self.assert_no_key(*self.describe(ctx.exception))

    def test_key_with_a_newline_is_refused_without_echoing_it(self) -> None:
        for bad in (API_KEY + "\nextra", API_KEY[:8] + "\r\n" + API_KEY[8:], API_KEY + "\u00e9", "tth test key"):
            with self.subTest(repr(bad)), self.assertRaises(ValueError) as ctx:
                TaskToHuman(bad)
            self.assert_no_key(*self.describe(ctx.exception))
            self.assertNotIn(bad.strip(), str(ctx.exception))

    def test_surrounding_whitespace_is_trimmed(self) -> None:
        api = FakeAPI().start()
        self.addCleanup(api.stop)
        api.queue(200, {})
        TaskToHuman(f"  {API_KEY}\n", base_url=api.base_url).get_me()
        self.assertEqual(api.requests[0].headers["authorization"], f"Bearer {API_KEY}")

    def test_network_errors_hide_the_key(self) -> None:
        client = TaskToHuman(API_KEY, base_url=unused_port_url(), max_retries=0)
        with self.assertRaises(APIConnectionError) as ctx:
            client.create_task("approve_refund")
        self.assert_no_key(*self.describe(ctx.exception))


class WaitTests(ClientTestCase):
    def test_returns_at_once_when_finished(self) -> None:
        self.api.queue_fixture("get-resolved")
        self.client._sleep = self.sleeps.append
        task = self.client.wait_for_decision(TASK_ID)
        self.assertEqual(task["state"], "resolved")
        self.assertEqual(self.sleeps, [])

    def test_backs_off_until_finished(self) -> None:
        for _ in range(5):
            self.api.queue(200, notified_task())
        self.api.queue_fixture("get-resolved")
        self.client._sleep = self.sleeps.append
        task = self.client.wait_for_decision(TASK_ID, initial_interval=5, max_interval=30)
        self.assertEqual(task["state"], "resolved")
        self.assertEqual(self.sleeps, [5, 10, 20, 30, 30])
        self.assertTrue(all(r.path == f"/v1/tasks/{TASK_ID}" for r in self.api.requests))

    def test_every_final_state_ends_the_wait(self) -> None:
        for state in ("resolved", "expired", "cancelled"):
            with self.subTest(state):
                body = notified_task()
                body["state"] = state
                self.api.queue(200, body)
                self.assertEqual(self.client.wait_for_decision(TASK_ID)["state"], state)

    def test_timeout_carries_the_last_task(self) -> None:
        self.api.default = Reply(200, notified_task())
        now = [0.0]
        self.client._clock = lambda: now[0]

        def fake_sleep(seconds: float) -> None:
            self.sleeps.append(seconds)
            now[0] += seconds

        self.client._sleep = fake_sleep
        with self.assertRaises(WaitTimeoutError) as ctx:
            self.client.wait_for_decision(TASK_ID, timeout=12, initial_interval=5, max_interval=60)
        self.assertEqual(ctx.exception.task["state"], "notified")
        self.assertEqual(self.sleeps, [5, 7])  # the last sleep is cut to the time left

    def test_timeout_with_real_time(self) -> None:
        self.api.default = Reply(200, notified_task())
        with self.assertRaises(WaitTimeoutError):
            self.client.wait_for_decision(TASK_ID, timeout=0.1, initial_interval=0.02, max_interval=0.04)


if __name__ == "__main__":
    unittest.main()
