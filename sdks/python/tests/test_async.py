from __future__ import annotations

import unittest

from _support import API_KEY, FakeAPI, Reply, fixture

from tasktohuman import AsyncTaskToHuman, ConflictError, PermissionDeniedError, WaitTimeoutError

TASK_ID = "01a1e3a7-6489-7106-aa3a-c976287f9999"


class AsyncClientTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.api = FakeAPI().start()
        self.addCleanup(self.api.stop)
        self.client = AsyncTaskToHuman(API_KEY, base_url=self.api.base_url, timeout=5)

    async def test_create_get_list_cancel(self) -> None:
        create = self.api.queue_fixture("create")
        task = await self.client.create_task(
            "approve_refund",
            title=create["request"]["body"]["title"],
            payload=create["request"]["body"]["payload"],
            deadline_minutes=120,
            idempotency_key="refund-4821",
        )
        self.assertEqual(task, create["response"]["body"])
        self.assertEqual(self.api.requests[-1].headers["idempotency-key"], "refund-4821")

        self.api.queue_fixture("get-resolved")
        self.assertEqual((await self.client.get_task(TASK_ID))["state"], "resolved")

        listed = self.api.queue_fixture("list")
        self.assertEqual(await self.client.list_tasks(state="notified", task_type="approve_refund", limit=2), listed["response"]["body"])
        self.assertEqual(self.api.requests[-1].path, listed["request"]["path"])

        base = fixture("get")["response"]["body"]
        self.api.queue(200, {"data": [base], "next_cursor": "page-2"})
        self.api.queue(200, {"data": [base]})
        self.assertEqual([task["id"] async for task in self.client.iter_tasks(state="notified", limit=1)], [TASK_ID, TASK_ID])
        self.assertEqual(self.api.requests[-1].path, "/v1/tasks?state=notified&cursor=page-2&limit=1")

        details = self.api.queue_fixture("list-finished-details")
        page = await self.client.list_tasks(finished_after="2026-11-16T09:00:00Z", expand="details", limit=1)
        self.assertEqual(page, details["response"]["body"])
        self.assertIn("expand=details", self.api.requests[-1].path)

        self.api.queue(200, {"data": [], "next_cursor": None})
        self.assertEqual([t async for t in self.client.iter_tasks(finished_after="2026-11-16T09:00:00Z", expand="details")], [])
        self.assertIn("expand=details", self.api.requests[-1].path)

        self.api.queue_fixture("cancel-finished")
        with self.assertRaises(ConflictError) as ctx:
            await self.client.cancel_task(TASK_ID)
        self.assertEqual(ctx.exception.code, "task_already_finished")

    async def test_urgency_and_download(self) -> None:
        self.api.queue_fixture("create")
        await self.client.create_task("approve_refund", urgency="high")
        self.assertEqual(self.api.requests[-1].json()["urgency"], "high")
        attachment_id = "0199c1a4-9a00-7b7a-9f43-2f1c6a1d8e55"
        self.api.queue(200, raw=b"\x00\x01", headers={"Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename=a.bin"})
        file = await self.client.download_task_attachment(TASK_ID, attachment_id)
        self.assertEqual((file.content, file.filename), (b"\x00\x01", "a.bin"))
        self.assertEqual(self.api.requests[-1].path, f"/v1/tasks/{TASK_ID}/attachments/{attachment_id}")

    async def test_me_and_entitlements(self) -> None:
        me = self.api.queue_fixture("me")
        self.assertEqual(await self.client.get_me(), me["response"]["body"])
        ent = self.api.queue_fixture("entitlements")
        self.assertEqual(await self.client.get_entitlements(), ent["response"]["body"])

    async def test_approvers_task_types_and_humans(self) -> None:
        human = "0199c1a4-6d2e-7b7a-9f43-2f1c6a1d8e55"
        group = "0199c1a4-7000-7b7a-9f43-2f1c6a1d8e55"
        self.api.queue_fixture("create")
        await self.client.create_task("approve_refund", approvers=[{"step": 1, "human": human}])
        self.assertEqual(self.api.requests[-1].json()["approvers"], [{"step": 1, "human": human}])

        self.api.queue_fixture("create")
        await self.client.create_task("approve_refund")
        self.assertNotIn("approvers", self.api.requests[-1].json())

        chain = [{"human": human, "wait_seconds": 3600}]
        self.api.queue_fixture("create")
        await self.client.create_task("approve_refund", chain=chain)
        self.assertEqual(self.api.requests[-1].json()["chain"], chain)

        types = {"data": [], "next_cursor": None}
        self.api.queue(200, types)
        self.assertEqual(await self.client.list_task_types(limit=10, cursor="c"), types)
        self.assertEqual(self.api.requests[-1].path, "/v1/task-types?limit=10&cursor=c")

        one = self.api.queue_fixture("task-type")
        self.assertEqual(await self.client.get_task_type("approve_refund"), one["response"]["body"])
        self.assertEqual(self.api.requests[-1].path, "/v1/task-types/approve_refund")
        requests = len(self.api.requests)
        with self.assertRaises(ValueError):
            await self.client.get_task_type("../me")
        self.assertEqual(len(self.api.requests), requests)

        humans = {"data": [{"id": human, "name": "Marta"}], "next_cursor": None}
        self.api.queue(200, humans)
        self.assertEqual(await self.client.list_humans(group=group, limit=10, cursor="c"), humans)
        self.assertEqual(self.api.requests[-1].path, f"/v1/humans?group={group}&limit=10&cursor=c")

        self.api.queue(403, {"title": "x", "status": 403, "code": "feature_not_in_plan", "feature": "routing.approver_at_creation"})
        with self.assertRaises(PermissionDeniedError) as ctx:
            await self.client.list_humans()
        self.assertEqual(ctx.exception.problem["feature"], "routing.approver_at_creation")

    async def test_create_error_carries_the_key(self) -> None:
        self.api.queue_fixture("validation")
        with self.assertRaises(Exception) as ctx:
            await self.client.create_task("approve_refund", idempotency_key="k-1")
        self.assertEqual(getattr(ctx.exception, "idempotency_key", None), "k-1")

    async def test_invalid_id_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            await self.client.get_task("../me")
        self.assertEqual(self.api.requests, [])

    async def test_wait_for_decision(self) -> None:
        pending = dict(fixture("get")["response"]["body"])
        self.api.queue(200, pending)
        self.api.queue(200, pending)
        self.api.queue_fixture("get-resolved")
        task = await self.client.wait_for_decision(TASK_ID, initial_interval=0.01, max_interval=0.02)
        self.assertEqual(task["state"], "resolved")
        self.assertEqual(len(self.api.requests), 3)

    async def test_wait_timeout(self) -> None:
        self.api.default = Reply(200, fixture("get")["response"]["body"])
        with self.assertRaises(WaitTimeoutError) as ctx:
            await self.client.wait_for_decision(TASK_ID, timeout=0.1, initial_interval=0.02, max_interval=0.04)
        self.assertEqual(ctx.exception.task["state"], "notified")


if __name__ == "__main__":
    unittest.main()
