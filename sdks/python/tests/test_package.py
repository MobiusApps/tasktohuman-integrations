"""pyproject.toml has what a public PyPI release needs (the built wheel itself is checked in CI)."""

from __future__ import annotations

import sys
import unittest
from typing import Any

from _support import REPO_ROOT

REPO = "https://github.com/MobiusApps/tasktohuman-integrations"


@unittest.skipIf(sys.version_info < (3, 11), "tomllib is in the standard library from Python 3.11")
class PyprojectTests(unittest.TestCase):
    project: dict[str, Any]

    @classmethod
    def setUpClass(cls) -> None:
        import tomllib

        with open(REPO_ROOT / "sdks/python/pyproject.toml", "rb") as f:
            cls.project = tomllib.load(f)["project"]

    def test_name_licence_and_python_versions(self) -> None:
        p = self.project
        self.assertEqual(p["name"], "tasktohuman")
        self.assertEqual(p["license"], "Apache-2.0")
        self.assertEqual(p["license-files"], ["LICENSE", "NOTICE"])
        self.assertEqual(p["requires-python"], ">=3.10")
        self.assertEqual(p["dependencies"], [])
        self.assertEqual(p["dynamic"], ["version"])
        self.assertIn("Typing :: Typed", p["classifiers"])
        self.assertIn("Programming Language :: Python :: 3.10", p["classifiers"])
        # With License-Expression, PyPI rejects the old licence classifiers.
        self.assertFalse([c for c in p["classifiers"] if c.startswith("License ::")])

    def test_urls_point_to_the_public_repository(self) -> None:
        urls = self.project["urls"]
        self.assertEqual(urls["Source"], REPO)
        self.assertEqual(urls["Issues"], f"{REPO}/issues")
        self.assertTrue(urls["Homepage"].startswith(REPO), urls["Homepage"])
        self.assertTrue(urls["Changelog"].startswith(REPO), urls["Changelog"])


if __name__ == "__main__":
    unittest.main()
