"""Tests of publish_plan.py (which packages a run publishes), standard library only, no network.

  python3 .github/scripts/publish_plan_test.py

Each test builds a small repository in a temporary folder and answers the registry URLs from a dict.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import publish_plan as pp  # noqa: E402

NPM_SDK = "https://registry.npmjs.org/@tasktohuman%2Fsdk"
NPM_N8N = "https://registry.npmjs.org/n8n-nodes-tasktohuman"
PYPI = "https://pypi.org/pypi/tasktohuman/json"


def pypi_version(v):
    return "https://pypi.org/pypi/tasktohuman/%s/json" % v


def write(root, path, text):
    full = os.path.join(root, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as fh:
        fh.write(text)


def repo(root, ts="0.1.1", py="0.1.1", n8n="0.1.1", ts_const=None, changelogs=None):
    write(root, "sdks/typescript/package.json", json.dumps({"name": "@tasktohuman/sdk", "version": ts}))
    write(root, "sdks/typescript/src/version.ts", 'export const VERSION = "%s";\n' % (ts_const or ts))
    write(root, "sdks/python/src/tasktohuman/_version.py", '"""Doc."""\n\n__version__ = "%s"\n' % py)
    write(root, "n8n/package.json", json.dumps({"name": "n8n-nodes-tasktohuman", "version": n8n}))
    changelogs = changelogs or {}
    for folder, v in (("sdks/typescript", ts), ("sdks/python", py), ("n8n", n8n)):
        heading = changelogs.get(folder, "## %s (2026-11-27)" % v)
        write(root, folder + "/CHANGELOG.md", "# Changelog\n\n%s\n\n- A change.\n\n## 0.1.0 (2026-11-20)\n" % heading)


def npm_doc(versions, latest):
    return {"name": "x", "dist-tags": {"latest": latest}, "versions": {v: {"version": v} for v in versions}}


class Registry:
    """Answers URLs from `answers` ({url: (status, body) or a list of them, one per call}); records the calls."""

    def __init__(self, answers):
        self.answers, self.calls = answers, []

    def __call__(self, url, accept):
        self.calls.append(url)
        answer = self.answers.get(url, (404, b""))
        if isinstance(answer, list):
            answer = answer.pop(0)
        if isinstance(answer, Exception):
            raise answer
        status, body = answer
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        return status, body


def released(ts=("0.1.0",), py=("0.1.0",), n8n=("0.1.0",)):
    """Registry answers for packages whose versions `ts`, `py` and `n8n` are published (the last is the latest)."""
    answers = {NPM_SDK: (200, npm_doc(ts, ts[-1])), NPM_N8N: (200, npm_doc(n8n, n8n[-1])),
               PYPI: (200, {"info": {"version": py[-1]}})}
    for v in py:
        answers[pypi_version(v)] = (200, {"info": {"version": v}})
    return answers


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.sleeps = []

    def tearDown(self):
        self.tmp.cleanup()

    def run_main(self, mode, registry):
        out = os.path.join(self.root, "out.txt")
        summ = os.path.join(self.root, "summary.md")
        env = {"PUBLISH_MODE": mode, "GITHUB_OUTPUT": out, "GITHUB_STEP_SUMMARY": summ}
        code = pp.main(["x", self.root], env, registry, self.sleeps.append)
        outputs = {}
        if os.path.exists(out):
            for line in open(out, encoding="utf-8").read().splitlines():
                key, value = line.split("=", 1)
                outputs[key] = value
        summary = open(summ, encoding="utf-8").read() if os.path.exists(summ) else ""
        return code, outputs, summary


class AutoMode(Base):
    def test_versions_already_on_the_registries_publish_nothing(self):
        repo(self.root, "0.1.0", "0.1.0", "0.1.0")
        code, outputs, summary = self.run_main("auto", Registry(released()))
        self.assertEqual(code, 0)
        self.assertEqual(outputs, {"npm": "false", "pypi": "false", "n8n": "false"})
        self.assertIn("| @tasktohuman/sdk | 0.1.0 | already on npm |", summary)
        self.assertIn("| tasktohuman | 0.1.0 | already on PyPI |", summary)

    def test_new_versions_are_published(self):
        repo(self.root)
        code, outputs, summary = self.run_main("auto", Registry(released()))
        self.assertEqual(code, 0)
        self.assertEqual(outputs, {"npm": "true", "pypi": "true", "n8n": "true"})
        self.assertIn("| @tasktohuman/sdk | 0.1.1 | not on npm: publish |", summary)
        self.assertIn("| tasktohuman | 0.1.1 | not on PyPI: publish |", summary)

    def test_only_the_changed_package_is_published(self):
        repo(self.root, "0.1.0", "0.1.0", "0.2.0")
        code, outputs, _ = self.run_main("auto", Registry(released()))
        self.assertEqual((code, outputs), (0, {"npm": "false", "pypi": "false", "n8n": "true"}))

    def test_a_package_never_published_is_published(self):
        repo(self.root, "0.1.0", "0.1.0", "0.1.0")
        answers = released()
        answers[NPM_N8N] = (404, b"")
        code, outputs, _ = self.run_main("auto", Registry(answers))
        self.assertEqual((code, outputs["n8n"]), (0, "true"))

    def test_scoped_name_is_url_encoded(self):
        repo(self.root, "0.1.0", "0.1.0", "0.1.0")
        registry = Registry(released())
        self.run_main("auto", registry)
        self.assertIn("https://registry.npmjs.org/@tasktohuman%2Fsdk", registry.calls)
        self.assertNotIn("https://registry.npmjs.org/@tasktohuman/sdk", registry.calls)

    def test_lower_than_latest_is_refused(self):
        repo(self.root, "0.1.0", "0.1.0", "0.1.0")
        answers = released(py=("0.1.0", "0.3.0"))
        # The repository says 0.1.0 is not on PyPI here, as if it were a new lower version.
        del answers[pypi_version("0.1.0")]
        code, outputs, summary = self.run_main("auto", Registry(answers))
        self.assertEqual((code, outputs), (1, {}))
        self.assertIn("lower than PyPI's latest 0.3.0", summary)

    def test_lower_than_npm_latest_is_refused(self):
        repo(self.root, "0.0.9", "0.1.0", "0.1.0")
        code, outputs, _ = self.run_main("auto", Registry(released()))
        self.assertEqual((code, outputs), (1, {}))

    def test_pre_releases_are_never_published_automatically(self):
        repo(self.root, "0.2.0-rc.1", "0.2.0rc1", "0.1.0")
        registry = Registry(released())
        code, outputs, summary = self.run_main("auto", registry)
        self.assertEqual((code, outputs), (0, {"npm": "false", "pypi": "false", "n8n": "false"}))
        self.assertIn("| @tasktohuman/sdk | 0.2.0-rc.1 | pre-release: publish by hand |", summary)
        self.assertIn("| tasktohuman | 0.2.0rc1 | pre-release: publish by hand |", summary)
        self.assertEqual(registry.calls, [NPM_N8N])  # pre-releases need no registry answer

    def test_unknown_version_shape_fails(self):
        repo(self.root, "latest", "0.1.0", "0.1.0")
        code, outputs, _ = self.run_main("auto", Registry(released()))
        self.assertEqual((code, outputs), (1, {}))


class FailClosed(Base):
    def test_server_errors_are_retried_then_fail_with_nothing_published(self):
        repo(self.root)
        answers = released()
        answers[PYPI] = (503, b"")
        code, outputs, summary = self.run_main("auto", Registry(answers))
        self.assertEqual((code, outputs), (1, {}))
        self.assertIn("no clean answer (HTTP 503)", summary)
        self.assertEqual(self.sleeps, [2, 4, 8])

    def test_a_transient_error_then_a_clean_answer_is_fine(self):
        repo(self.root)
        answers = released()
        answers[NPM_SDK] = [OSError("timed out"), (429, b""), answers[NPM_SDK]]
        code, outputs, _ = self.run_main("auto", Registry(answers))
        self.assertEqual((code, outputs["npm"]), (0, "true"))
        self.assertEqual(self.sleeps, [2, 4])

    def test_network_errors_fail(self):
        repo(self.root)
        answers = released()
        answers[NPM_N8N] = [OSError("timed out")] * pp.TRIES
        code, outputs, _ = self.run_main("auto", Registry(answers))
        self.assertEqual((code, outputs), (1, {}))

    def test_other_client_errors_fail_at_once(self):
        repo(self.root)
        answers = released()
        answers[NPM_SDK] = (403, b"")
        code, outputs, _ = self.run_main("auto", Registry(answers))
        self.assertEqual((code, outputs, self.sleeps), (1, {}, []))

    def test_malformed_answers_fail(self):
        for body in (b"<html>", b"[]", {"versions": {}}, {"versions": [], "dist-tags": {}}):
            with self.subTest(body=body):
                repo(self.root)
                answers = released()
                answers[NPM_SDK] = (200, body)
                code, outputs, _ = self.run_main("auto", Registry(answers))
                self.assertEqual((code, outputs), (1, {}))

    def test_pypi_project_without_info_version_fails(self):
        repo(self.root)
        answers = released()
        answers[PYPI] = (200, {"info": {}})
        code, outputs, _ = self.run_main("auto", Registry(answers))
        self.assertEqual((code, outputs), (1, {}))


class ReleaseFiles(Base):
    def test_unreleased_changelog_heading_fails(self):
        repo(self.root, changelogs={"sdks/python": "## 0.1.1 (unreleased)"})
        code, outputs, summary = self.run_main("auto", Registry(released()))
        self.assertEqual((code, outputs), (1, {}))
        self.assertIn("CHANGELOG.md is '## 0.1.1 (unreleased)'", summary)

    def test_changelog_of_another_version_fails(self):
        repo(self.root, changelogs={"n8n": "## 0.1.0 (2026-11-20)"})
        code, outputs, _ = self.run_main("auto", Registry(released()))
        self.assertEqual((code, outputs), (1, {}))

    def test_changelog_with_an_impossible_date_fails(self):
        repo(self.root, changelogs={"n8n": "## 0.1.1 (2026-13-40)"})
        code, outputs, _ = self.run_main("auto", Registry(released()))
        self.assertEqual((code, outputs), (1, {}))

    def test_version_ts_must_match_package_json(self):
        repo(self.root, ts_const="0.1.0")
        code, outputs, summary = self.run_main("auto", Registry(released()))
        self.assertEqual((code, outputs), (1, {}))
        self.assertIn("src/version.ts has '0.1.0'", summary)

    def test_a_package_not_published_needs_no_changelog_entry(self):
        repo(self.root, "0.1.0", "0.1.1", "0.1.0", changelogs={"n8n": "## 0.2.0 (unreleased)"})
        code, outputs, _ = self.run_main("auto", Registry(released()))
        self.assertEqual((code, outputs), (0, {"npm": "false", "pypi": "true", "n8n": "false"}))

    def test_forced_publishes_are_checked_too(self):
        repo(self.root, changelogs={"sdks/typescript": "## 0.1.1 (unreleased)"})
        code, outputs, _ = self.run_main("npm", Registry({}))
        self.assertEqual((code, outputs), (1, {}))


class ManualModes(Base):
    def test_forced_inputs_publish_exactly_those_packages_without_asking(self):
        expected = {"no": ("false", "false", "false"), "npm": ("true", "false", "false"),
                    "pypi": ("false", "true", "false"), "both": ("true", "true", "false"),
                    "n8n": ("false", "false", "true")}
        for mode, (npm, pypi, n8n) in expected.items():
            with self.subTest(mode=mode):
                repo(self.root, "0.1.0", "0.1.0", "0.1.0")
                if os.path.exists(os.path.join(self.root, "out.txt")):
                    os.remove(os.path.join(self.root, "out.txt"))
                registry = Registry({})
                code, outputs, _ = self.run_main(mode, registry)
                self.assertEqual((code, outputs), (0, {"npm": npm, "pypi": pypi, "n8n": n8n}))
                self.assertEqual(registry.calls, [])

    def test_unknown_mode_fails(self):
        repo(self.root)
        for mode in ("", "yes", "auto;true"):
            with self.subTest(mode=mode):
                code, outputs, _ = self.run_main(mode, Registry({}))
                self.assertEqual((code, outputs), (1, {}))


class Versions(unittest.TestCase):
    def test_kinds(self):
        for v, k in (("1.2.3", "stable"), ("1.2.3-rc.1", "pre"), ("1.2.3rc1", "pre"), ("1.2.3a1", "pre"),
                     ("1.2.3b2", "pre"), ("1.2.3.dev4", "pre"), ("1.2", None), ("v1.2.3", None), ("", None)):
            self.assertEqual(pp.kind(v), k, v)

    def test_lower_than(self):
        self.assertTrue(pp.lower_than("0.1.9", "0.2.0"))
        self.assertTrue(pp.lower_than("0.9.0", "1.0.0-rc.1"))
        self.assertFalse(pp.lower_than("0.10.0", "0.9.0"))
        self.assertFalse(pp.lower_than("1.0.0", "1.0.0-rc.1"))


if __name__ == "__main__":
    unittest.main()
