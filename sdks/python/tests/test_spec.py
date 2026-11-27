"""Drift test: the SDK's types and call signatures against the vendored OpenAPI file.

When the API adds or changes a field and openapi/public-v1.json is refreshed,
this fails until src/tasktohuman/_types.py matches.
"""

from __future__ import annotations

import inspect
import types
import typing
import unittest
from typing import Any

from _support import load_json

import tasktohuman as tth

SPEC = load_json("openapi/public-v1.json")
SCHEMAS: dict[str, Any] = SPEC["components"]["schemas"]

PAIRS: dict[str, Any] = {
    "PublicTaskView": tth.Task,
    "PublicDecisionView": tth.Decision,
    "PublicAttachmentView": tth.Attachment,
    "PublicHumanRef": tth.HumanRef,
    "PublicQuorumView": tth.Quorum,
    "PublicQuorumAnswerView": tth.QuorumAnswer,
    "PublicTaskList": tth.TaskList,
    "PublicTaskTypeList": tth.TaskTypeList,
    "PublicTaskTypeView": tth.TaskType,
    "PublicTaskTypeField": tth.TaskTypeField,
    "PublicStepView": tth.TaskTypeStep,
    "PublicGroupRef": tth.GroupRef,
    "PublicHumanList": tth.HumanList,
    "PublicProblem": tth.Problem,
    "PublicFieldMessage": tth.FieldMessage,
    "ApiKeyMeResponse": tth.Me,
    "NamedRef": tth.NamedRef,
    "ApiKeyRef": tth.ApiKeyRef,
    "PublicEntitlementsResponse": tth.Entitlements,
}


def is_nullable(prop: dict[str, Any]) -> bool:
    kind = prop.get("type")
    if kind == "null" or (isinstance(kind, list) and "null" in kind):
        return True
    return any(option.get("type") == "null" for option in prop.get("oneOf", []))


def allows_none(hint: Any) -> bool:
    return type(None) in typing.get_args(hint) and (
        typing.get_origin(hint) in (typing.Union, types.UnionType)
    )


def operation(operation_id: str) -> dict[str, Any]:
    for methods in SPEC["paths"].values():
        for op in methods.values():
            if isinstance(op, dict) and op.get("operationId") == operation_id:
                return op
    raise AssertionError(f"no operation {operation_id}")


def keyword_params(func: Any, *, skip: tuple[str, ...] = ()) -> set[str]:
    return {name for name in inspect.signature(func).parameters if name not in ("self", *skip)}


class SchemaDriftTests(unittest.TestCase):
    def test_types_match_the_schemas(self) -> None:
        for schema_name, typed_dict in PAIRS.items():
            with self.subTest(schema_name):
                schema = SCHEMAS[schema_name]
                hints = typing.get_type_hints(typed_dict)
                self.assertEqual(set(hints), set(schema["properties"]), "property names")
                self.assertEqual(set(typed_dict.__required_keys__), set(schema.get("required", [])), "required keys")

    def test_nullable_fields_are_typed_with_none(self) -> None:
        for schema_name, typed_dict in PAIRS.items():
            hints = typing.get_type_hints(typed_dict)
            for prop_name, prop in schema_props(schema_name).items():
                with self.subTest(f"{schema_name}.{prop_name}"):
                    self.assertEqual(allows_none(hints[prop_name]), is_nullable(prop))

    def test_documented_codes_are_known(self) -> None:
        state = SCHEMAS["PublicTaskView"]["properties"]["state"]["enum"]
        self.assertEqual(set(state), set(typing.get_args(tth.TaskState)))
        action = SCHEMAS["PublicDecisionView"]["properties"]["action"]["enum"]
        self.assertEqual(set(action), set(typing.get_args(tth.DecisionAction)))
        self.assertEqual(set(SCHEMAS["ApiKeyMode"]["enum"]), set(typing.get_args(tth.ApiKeyMode)))
        assignment = SCHEMAS["PublicStepView"]["properties"]["assignment"]["enum"]
        self.assertEqual(set(assignment), set(typing.get_args(tth.StepAssignment)))
        kind = SCHEMAS["PublicTaskTypeView"]["properties"]["kind"]["enum"]
        self.assertEqual(set(kind), set(typing.get_args(tth.TaskTypeKind)))

    def test_approver_matches_an_approvers_entry(self) -> None:
        entry = SCHEMAS["CreateTaskBody"]["properties"]["approvers"]["items"]
        # The API takes human or email, never both: the SDK has one class for each.
        classes = typing.get_args(tth.Approver)
        self.assertEqual(set(classes), {tth.ApproverByHuman, tth.ApproverByEmail})
        hints = [set(typing.get_type_hints(cls)) for cls in classes]
        self.assertEqual(set().union(*hints), set(entry["properties"]))
        for cls, keys in zip(classes, hints):
            with self.subTest(cls.__name__):
                self.assertTrue(set(entry["required"]) < keys)
                self.assertEqual(len(keys - set(entry["required"])), 1)
                self.assertEqual(set(cls.__required_keys__), keys)

    def test_chain_step_matches_a_chain_entry(self) -> None:
        step = resolve(SCHEMAS["CreateTaskBody"]["properties"]["chain"]["items"])
        self.assertEqual(set(typing.get_type_hints(tth.ChainStep)), set(step["properties"]))
        approver = resolve(step["properties"]["approvers"]["items"])
        self.assertEqual(set(typing.get_type_hints(tth.ChainApprover)), set(approver["properties"]))

    def test_every_schema_is_covered(self) -> None:
        covered = set(PAIRS) | {"CreateTaskBody", "ApiKeyMode", "Payload"}
        self.assertEqual(set(SCHEMAS), covered)


def resolve(schema: dict[str, Any]) -> dict[str, Any]:
    """A nested schema, written in place or as a $ref to a component, maybe as a oneOf with null."""
    schema = next((o for o in schema.get("oneOf", []) if o.get("type") != "null"), schema)
    ref = schema.get("$ref")
    return typing.cast("dict[str, Any]", SCHEMAS[ref.rsplit("/", 1)[-1]]) if ref else schema


def schema_props(name: str) -> dict[str, Any]:
    return typing.cast("dict[str, Any]", SCHEMAS[name]["properties"])


class OperationDriftTests(unittest.TestCase):
    def test_every_api_key_operation_has_a_method(self) -> None:
        operations = {
            op["operationId"]
            for methods in SPEC["paths"].values()
            for op in methods.values()
            if isinstance(op, dict) and "operationId" in op
        }
        # createTaskFromWebhook is authenticated by the URL's token, not by an
        # API key: it is meant for no-code tools and is not part of this SDK.
        mapped = {
            "createTask": "create_task",
            "getTask": "get_task",
            "listTasks": "list_tasks",
            "cancelTask": "cancel_task",
            "getMe": "get_me",
            "getEntitlements": "get_entitlements",
            "listTaskTypes": "list_task_types",
            "getTaskType": "get_task_type",
            "listHumans": "list_humans",
            "downloadTaskAttachment": "download_task_attachment",
        }
        self.assertEqual(operations - {"createTaskFromWebhook"}, set(mapped))
        for method in mapped.values():
            self.assertTrue(callable(getattr(tth.TaskToHuman, method)))
            self.assertTrue(inspect.iscoroutinefunction(getattr(tth.AsyncTaskToHuman, method)))

    def test_create_task_takes_every_body_property(self) -> None:
        body = SCHEMAS["CreateTaskBody"]
        for cls in (tth.TaskToHuman, tth.AsyncTaskToHuman):
            with self.subTest(cls.__name__):
                self.assertEqual(keyword_params(cls.create_task, skip=("idempotency_key",)), set(body["properties"]))
                first = list(inspect.signature(cls.create_task).parameters)[1]
                self.assertEqual([first], body["required"])

    def test_create_task_sends_the_idempotency_header(self) -> None:
        names = {p["name"] for p in operation("createTask").get("parameters", [])}
        self.assertEqual(names, {"Idempotency-Key"})

    def test_download_takes_the_path_parameters(self) -> None:
        names = [p["name"] for p in operation("downloadTaskAttachment")["parameters"] if p["in"] == "path"]
        self.assertEqual(names, ["id", "attachmentId"])
        for cls in (tth.TaskToHuman, tth.AsyncTaskToHuman):
            with self.subTest(cls.__name__):
                self.assertEqual(list(inspect.signature(cls.download_task_attachment).parameters), ["self", "task_id", "attachment_id"])

    def test_get_task_type_takes_the_path_parameter(self) -> None:
        names = [p["name"] for p in operation("getTaskType")["parameters"] if p["in"] == "path"]
        self.assertEqual(names, ["key"])
        for cls in (tth.TaskToHuman, tth.AsyncTaskToHuman):
            with self.subTest(cls.__name__):
                self.assertEqual(list(inspect.signature(cls.get_task_type).parameters), ["self", "key"])

    def test_list_calls_take_every_query_parameter(self) -> None:
        for operation_id, method in (
            ("listTasks", "list_tasks"),
            ("listTaskTypes", "list_task_types"),
            ("listHumans", "list_humans"),
        ):
            params = {p["name"] for p in operation(operation_id)["parameters"] if p["in"] == "query"}
            for cls in (tth.TaskToHuman, tth.AsyncTaskToHuman):
                with self.subTest(f"{cls.__name__}.{method}"):
                    self.assertEqual(keyword_params(getattr(cls, method)), params)

    def test_iter_tasks_takes_what_list_tasks_takes(self) -> None:
        for cls in (tth.TaskToHuman, tth.AsyncTaskToHuman):
            with self.subTest(cls.__name__):
                self.assertEqual(keyword_params(cls.iter_tasks), keyword_params(cls.list_tasks))


if __name__ == "__main__":
    unittest.main()
