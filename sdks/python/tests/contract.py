"""Live contract run against a TaskToHuman API. Run by hand, never in CI.

Uses a TEST key only (tth_test_...), so nobody real is notified:

    TTH_API_BASE=http://api.localhost:8080 TTH_API_KEY=tth_test_... \
    TTH_TASK_TYPE=approve_refund PYTHONPATH=src python3 tests/contract.py

The task type must accept the payload below (shaped like the docs' approve_refund).
Not collected by unittest discovery (the file name does not start with test_).
"""

from __future__ import annotations

import os
import sys
import uuid

from tasktohuman import AuthenticationError, ConflictError, TaskToHuman, ValidationError


def main() -> None:
    base = os.environ.get("TTH_API_BASE", "http://api.localhost:8080")
    key = os.environ["TTH_API_KEY"]
    task_type = os.environ.get("TTH_TASK_TYPE", "approve_refund")
    if not key.startswith("tth_test_"):
        sys.exit("refusing to run: TTH_API_KEY must be a test key (tth_test_...)")

    tth = TaskToHuman(key, base_url=base)
    me = tth.get_me()
    assert me["key"]["mode"] == "test", me
    tth.get_entitlements()

    idem = f"sdk-py-contract-{uuid.uuid4()}"
    payload = {"order_id": "4821", "amount": 249, "reason": "SDK contract run"}
    first = tth.create_task(task_type, title="SDK contract run", payload=payload, idempotency_key=idem)
    again = tth.create_task(task_type, title="SDK contract run", payload=payload, idempotency_key=idem)
    assert first["id"] == again["id"] and first["test"] is True, (first, again)

    got = tth.get_task(first["id"])
    assert got["payload"] == payload and got.get("payload_sha256"), got
    assert any(t["id"] == first["id"] for t in tth.list_tasks(task_type=task_type, limit=100)["data"])

    cancelled = tth.cancel_task(first["id"])
    assert cancelled["state"] == "cancelled", cancelled
    assert tth.get_task(first["id"])["state"] == "cancelled"
    try:
        tth.cancel_task(first["id"])
        raise AssertionError("second cancel should fail")
    except ConflictError as err:
        assert err.code == "task_already_finished" and err.state == "cancelled", err.problem

    assert tth.wait_for_decision(first["id"], timeout=5)["state"] == "cancelled"

    try:
        tth.create_task(task_type, payload={"order_id": "4821", "amount": "not a number"})
        raise AssertionError("invalid payload should fail")
    except ValidationError as err:
        assert err.code == "validation_failed" and err.errors, err.problem

    try:
        TaskToHuman("tth_test_wrong", base_url=base, max_retries=0).get_me()
        raise AssertionError("bad key should fail")
    except AuthenticationError as err:
        assert err.code == "unauthorized", err.problem

    print("contract OK")


if __name__ == "__main__":
    main()
