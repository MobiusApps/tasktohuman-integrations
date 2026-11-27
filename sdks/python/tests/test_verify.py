"""verify_callback against the docs' signature vectors (fixtures/callback-signature.json)."""

from __future__ import annotations

import hashlib
import hmac
import json
import typing
import unittest

from _support import load_json

from tasktohuman import CallbackRouting, CallbackTask, RoutingRuleRef, SignatureVerificationError, verify_callback

V = load_json("fixtures/callback-signature.json")
BODY: bytes = V["body"].encode("utf-8")
T: int = V["t"]
SECRET: str = V["secret"]
PREVIOUS: str = V["previous_secret"]
HEADER: str = V["header"]
ROTATION: str = V["header_rotation"]


def sign(secret: str, t: int, body: bytes) -> str:
    return hmac.new(secret.encode("utf-8"), str(t).encode("ascii") + b"." + body, hashlib.sha256).hexdigest()


class VectorTests(unittest.TestCase):
    def test_the_vector_verifies_and_returns_the_task(self) -> None:
        task = verify_callback(BODY, HEADER, SECRET, now=T)
        self.assertEqual(task, json.loads(V["body"]))
        self.assertEqual(task["state"], "resolved")
        self.assertEqual(task.get("urgency"), "high")
        self.assertEqual(task.get("tags"), ["refunds"])
        self.assertEqual(task["routing"]["rule"], {"id": "01a1e3a7-5f10-7c3e-9d42-1b6f0c8e7a11", "name": "Refunds over 200"})

    def test_unrouted_and_older_bodies_verify(self) -> None:
        parsed = json.loads(V["body"])
        unrouted = json.dumps({**parsed, "urgency": "normal", "tags": [], "routing": {"rule": None}}).encode("utf-8")
        task = verify_callback(unrouted, f"t={T},v1={sign(SECRET, T, unrouted)}", SECRET, now=T)
        self.assertIsNone(task["routing"]["rule"])
        older = json.dumps({k: v for k, v in parsed.items() if k not in ("urgency", "tags", "routing")}).encode("utf-8")
        old = verify_callback(older, f"t={T},v1={sign(SECRET, T, older)}", SECRET, now=T)
        self.assertEqual(old.get("urgency", "normal"), "normal")
        self.assertNotIn("routing", old)

    def test_our_hmac_matches_the_vector(self) -> None:
        self.assertEqual(f"t={T},v1={sign(SECRET, T, BODY)}", HEADER)

    def test_rotation_header_verifies_with_either_secret(self) -> None:
        for secret in (SECRET, PREVIOUS):
            with self.subTest(secret):
                verify_callback(BODY, ROTATION, secret, now=T)

    def test_list_of_secrets(self) -> None:
        verify_callback(BODY, HEADER, ["whsec_new_one", SECRET], now=T)
        verify_callback(BODY, HEADER, (SECRET, "whsec_other"), now=T)

    def test_bytearray_body(self) -> None:
        verify_callback(bytearray(BODY), HEADER, SECRET, now=T)

    def test_headers_mapping(self) -> None:
        for headers in ({"TTH-Signature": HEADER}, {"tth-signature": HEADER}, {"Tth-Signature": HEADER, "Content-Type": "application/json"}):
            with self.subTest(headers):
                verify_callback(BODY, headers, SECRET, now=T)

    def test_spaces_around_parts_are_trimmed(self) -> None:
        spaced = ROTATION.replace(",", " , ")
        verify_callback(BODY, spaced, PREVIOUS, now=T)

    def test_unknown_parts_are_ignored(self) -> None:
        verify_callback(BODY, HEADER + ",v0=abc", SECRET, now=T)

    def test_tolerance_boundary(self) -> None:
        verify_callback(BODY, HEADER, SECRET, now=T + 300)
        verify_callback(BODY, HEADER, SECRET, now=T - 300)
        verify_callback(BODY, HEADER, SECRET, now=T + 1000, tolerance=1000)


class RefusalTests(unittest.TestCase):
    def assert_refused(self, reason: str, body: bytes = BODY, header: object = HEADER, secret: object = SECRET, now: float = T) -> None:
        with self.assertRaises(SignatureVerificationError) as ctx:
            verify_callback(body, header, secret, now=now)  # type: ignore[arg-type]
        self.assertEqual(ctx.exception.reason, reason)

    def test_changed_body(self) -> None:
        self.assert_refused("no_matching_signature", body=BODY.replace(b"approved", b"rejected"))
        self.assert_refused("no_matching_signature", body=BODY + b" ")

    def test_wrong_secret(self) -> None:
        self.assert_refused("no_matching_signature", secret="whsec_wrong")
        self.assert_refused("no_matching_signature", header=HEADER, secret=PREVIOUS)

    def test_out_of_tolerance(self) -> None:
        self.assert_refused("timestamp_out_of_tolerance", now=T + 301)
        self.assert_refused("timestamp_out_of_tolerance", now=T - 301)

    def test_missing_header(self) -> None:
        for header in (None, "", "   ", {}, {"Content-Type": "application/json"}):
            with self.subTest(header):
                self.assert_refused("missing_header", header=header)

    def test_malformed_headers(self) -> None:
        good = sign(SECRET, T, BODY)
        cases = [
            f"t={T}",  # no v1
            f"v1={good}",  # no t
            f"t={T},t={T},v1={good}",  # two t
            f"t=abc,v1={good}",
            f"t=-{T},v1={good}",
            f"t={T},v1={good.upper()}",  # upper-case hex
            f"t={T},v1={good[:63]}",  # short
            f"t={T},v1={good}0",  # long
            f"t={T},v1=",
            f"t={T},v1={good},v1=zz",
            "garbage",
        ]
        for header in cases:
            with self.subTest(header):
                self.assert_refused("malformed_header", header=header)


class MisuseTests(unittest.TestCase):
    def test_str_body_is_a_type_error(self) -> None:
        with self.assertRaises(TypeError):
            verify_callback(V["body"], HEADER, SECRET, now=T)

    def test_parsed_body_is_a_type_error(self) -> None:
        with self.assertRaises(TypeError):
            verify_callback(json.loads(V["body"]), HEADER, SECRET, now=T)

    def test_missing_or_empty_secret_is_a_type_error(self) -> None:
        for secret in (None, "", [], (), [""], [SECRET, ""], b"bytes", [None], 42):
            with self.subTest(secret), self.assertRaises(TypeError):
                verify_callback(BODY, HEADER, secret, now=T)  # type: ignore[arg-type]

    def test_tolerance_and_now_must_be_finite(self) -> None:
        for tolerance in (float("nan"), float("inf"), -1, True, "300"):
            with self.subTest(tolerance=tolerance), self.assertRaises(TypeError):
                verify_callback(BODY, HEADER, SECRET, now=T + 10_000, tolerance=tolerance)  # type: ignore[arg-type]
        for now in (float("nan"), float("inf")):
            with self.subTest(now=now), self.assertRaises(TypeError):
                verify_callback(BODY, HEADER, SECRET, now=now)

    def test_secret_is_checked_before_the_header(self) -> None:
        with self.assertRaises(TypeError):
            verify_callback(BODY, None, "", now=T)

    def test_error_message_never_holds_the_secret(self) -> None:
        with self.assertRaises(SignatureVerificationError) as ctx:
            verify_callback(BODY, HEADER, "whsec_wrong_value", now=T)
        self.assertNotIn("whsec", str(ctx.exception) + repr(ctx.exception))


class CallbackShapeTests(unittest.TestCase):
    def test_callback_task_keys_equal_the_vector_body(self) -> None:
        body_keys = set(json.loads(V["body"]).keys())
        required = set(CallbackTask.__required_keys__)
        optional = set(CallbackTask.__optional_keys__)
        # quorum only after a consensus step; urgency, tags and routing are always sent but optional so older bodies fit.
        self.assertEqual(optional, {"quorum", "urgency", "tags", "routing"})
        self.assertEqual(required | (optional - {"quorum"}), body_keys)
        self.assertEqual(set(typing.get_type_hints(CallbackTask)), required | optional)

    def test_routing_keys_equal_the_vector_body(self) -> None:
        routing = json.loads(V["body"])["routing"]
        self.assertEqual(set(CallbackRouting.__required_keys__), set(routing))
        self.assertEqual(set(RoutingRuleRef.__required_keys__), set(routing["rule"]))


if __name__ == "__main__":
    unittest.main()
