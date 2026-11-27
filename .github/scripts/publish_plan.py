"""Which packages a run of sdk-ci publishes (README, "CI and publishing").

  python3 -I -B .github/scripts/publish_plan.py [repository root]
      PUBLISH_MODE   auto | no | npm | pypi | both | n8n   (a push to main runs as auto)
      GITHUB_OUTPUT, GITHUB_STEP_SUMMARY   set by GitHub Actions; the outputs npm, pypi and n8n (true or false)

Modes:
  - auto: each package whose version in the repository is not yet on its registry (npm or PyPI). A version that
    is already there is skipped; a pre-release (0.2.0-rc.1, 0.2.0rc1 ...) is never published automatically; a
    version lower than the registry's latest is refused (the run fails).
  - npm, pypi, both, n8n: exactly those packages, without asking the registries (they refuse a version they have).
  - no: nothing.

Fail closed: when a registry gives anything but a clean answer (200 with the expected JSON, or 404) after a few
tries, the script stops with an error and writes no outputs, so nothing is published on a doubtful answer.

Before any package is planned for publishing, its CHANGELOG.md must start with `## <version> (<YYYY-MM-DD>)`, and,
for the TypeScript SDK, src/version.ts must hold the version of package.json.

Standard library only. The network is behind one function (fetch) that the tests replace.
"""

import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.client import HTTPException

MODES = ("auto", "no", "npm", "pypi", "both", "n8n")
FORCED = {"no": (), "npm": ("npm",), "pypi": ("pypi",), "both": ("npm", "pypi"), "n8n": ("n8n",)}
TRIES = 4
BACKOFF_SECONDS = 2  # doubled after each failed try: 2, 4, 8
TIMEOUT_SECONDS = 20
MAX_BYTES = 20 * 1024 * 1024
USER_AGENT = "tasktohuman-integrations-ci"

STABLE = re.compile(r"(\d+)\.(\d+)\.(\d+)")
# npm style (1.2.3-rc.1) and Python style (1.2.3rc1, 1.2.3a1, 1.2.3b1, 1.2.3.dev1).
PRE = re.compile(r"(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+|(?:a|b|rc)\d+|\.dev\d+)")


class Failure(Exception):
    """A problem that stops the plan (exit code 1, the message as an error annotation)."""


class Package:
    def __init__(self, key, name, registry, version, changelog, version_ts=None):
        self.key, self.name, self.registry = key, name, registry
        self.version, self.changelog, self.version_ts = version, changelog, version_ts


# ---------------------------------------------------------------- the repository

def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def packages(root):
    """The three published packages with the version each one has in the repository."""
    def npm_version(folder):
        data = json.loads(read(os.path.join(root, folder, "package.json")))
        return data["name"], data["version"]

    ts_name, ts_version = npm_version("sdks/typescript")
    n8n_name, n8n_version = npm_version("n8n")
    m = re.search(r'^__version__ = "([^"]+)"$', read(os.path.join(root, "sdks/python/src/tasktohuman/_version.py")),
                  re.M)
    if not m:
        raise Failure("sdks/python/src/tasktohuman/_version.py: no __version__ line")
    return [
        Package("npm", ts_name, "npm", ts_version, os.path.join(root, "sdks/typescript/CHANGELOG.md"),
                os.path.join(root, "sdks/typescript/src/version.ts")),
        Package("pypi", "tasktohuman", "pypi", m.group(1), os.path.join(root, "sdks/python/CHANGELOG.md")),
        Package("n8n", n8n_name, "npm", n8n_version, os.path.join(root, "n8n/CHANGELOG.md")),
    ]


def check_release_files(package):
    """The checks a package passes before it is published: the changelog's top entry is this version with a date,
    and the TypeScript SDK's src/version.ts agrees with package.json."""
    heading = next((line.rstrip() for line in read(package.changelog).splitlines() if line.startswith("## ")), None)
    m = re.fullmatch(r"## (\S+) \((\d{4}-\d{2}-\d{2})\)", heading or "")
    if not m or m.group(1) != package.version:
        raise Failure("%s %s: the top entry of %s is %r, not '## %s (YYYY-MM-DD)'"
                      % (package.name, package.version, os.path.normpath(package.changelog), heading, package.version))
    try:
        datetime.date.fromisoformat(m.group(2))
    except ValueError:
        raise Failure("%s %s: the changelog date %r is not a date" % (package.name, package.version, m.group(2)))
    if package.version_ts:
        found = re.search(r'export const VERSION = "([^"]+)";', read(package.version_ts))
        if not found or found.group(1) != package.version:
            raise Failure("%s: src/version.ts has %r, package.json %r; raise them together"
                          % (package.name, found and found.group(1), package.version))


# ---------------------------------------------------------------- versions

def kind(version):
    """'stable', 'pre' or None (not a version this script understands)."""
    if STABLE.fullmatch(version):
        return "stable"
    if PRE.fullmatch(version):
        return "pre"
    return None


def core(version):
    """(major, minor, patch) of a stable or pre-release version."""
    m = PRE.fullmatch(version) or STABLE.fullmatch(version)
    return tuple(int(n) for n in m.groups()[:3])


def lower_than(version, latest):
    """True when the stable `version` is below `latest` (a pre-release of the same x.y.z is not above it)."""
    return core(version) < core(latest)


# ---------------------------------------------------------------- the registries

def fetch(url, accept="application/json"):
    """(status, body) of one GET. 4xx and 5xx are answers, not exceptions; network problems raise OSError."""
    request = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return response.status, response.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as error:
        return error.code, b""


def get(url, fetch_fn, sleep, accept="application/json"):
    """The parsed JSON of a 200, or None for a 404. Network errors, 429 and 5xx are tried again; anything else,
    or no clean answer after TRIES, is a Failure."""
    problem = None
    for attempt in range(TRIES):
        if attempt:
            sleep(BACKOFF_SECONDS * 2 ** (attempt - 1))
        try:
            status, body = fetch_fn(url, accept)
        except (OSError, HTTPException, ValueError) as error:
            problem = "%s: %s" % (type(error).__name__, error)
            continue
        if status == 404:
            return None
        if status == 200:
            if len(body) > MAX_BYTES:
                raise Failure("%s: answer larger than %d bytes" % (url, MAX_BYTES))
            try:
                data = json.loads(body)
            except ValueError:
                raise Failure("%s: answered 200 with a body that is not JSON" % url)
            if not isinstance(data, dict):
                raise Failure("%s: answered 200 with JSON that is not an object" % url)
            return data
        problem = "HTTP %s" % status
        if status != 429 and status < 500:
            break
    raise Failure("%s: no clean answer (%s); nothing is published on a doubtful answer" % (url, problem))


def npm_state(name, version, fetch_fn, sleep):
    """(version is on npm, npm's latest or None)."""
    url = "https://registry.npmjs.org/" + urllib.parse.quote(name, safe="@")
    doc = get(url, fetch_fn, sleep, accept="application/vnd.npm.install-v1+json")
    if doc is None:
        return False, None  # the package was never published
    versions, tags = doc.get("versions"), doc.get("dist-tags")
    if not isinstance(versions, dict) or not isinstance(tags, dict):
        raise Failure("%s: the package document has no versions or dist-tags" % url)
    latest = tags.get("latest")
    if latest is not None and not isinstance(latest, str):
        raise Failure("%s: dist-tags.latest is not a string" % url)
    return version in versions, latest


def pypi_state(name, version, fetch_fn, sleep):
    """(version is on PyPI, PyPI's latest or None)."""
    project = "https://pypi.org/pypi/%s/json" % urllib.parse.quote(name)
    doc = get(project, fetch_fn, sleep)
    if doc is None:
        return False, None  # the project does not exist yet
    info = doc.get("info")
    latest = info.get("version") if isinstance(info, dict) else None
    if not isinstance(latest, str):
        raise Failure("%s: the project document has no info.version" % project)
    exists = get("https://pypi.org/pypi/%s/%s/json" % (urllib.parse.quote(name), urllib.parse.quote(version)),
                 fetch_fn, sleep) is not None
    return exists, latest


# ---------------------------------------------------------------- the plan

REGISTRY_NAME = {"npm": "npm", "pypi": "PyPI"}


def plan(mode, pkgs, fetch_fn=fetch, sleep=time.sleep):
    """({key: True or False}, [summary rows]). Raises Failure when the plan cannot be trusted."""
    if mode not in MODES:
        raise Failure("unknown publish mode %r (expected one of %s)" % (mode, ", ".join(MODES)))
    decided, rows = {}, []
    for p in pkgs:
        where = REGISTRY_NAME[p.registry]
        if mode != "auto":
            decided[p.key] = p.key in FORCED[mode]
            rows.append((p, "publish (asked for by hand)" if decided[p.key] else "not asked for"))
            continue
        k = kind(p.version)
        if k is None:
            raise Failure("%s: %r is not a version this plan understands (x.y.z or a pre-release)"
                          % (p.name, p.version))
        if k == "pre":
            decided[p.key] = False
            rows.append((p, "pre-release: publish by hand"))
            continue
        state = npm_state if p.registry == "npm" else pypi_state
        exists, latest = state(p.name, p.version, fetch_fn, sleep)
        if exists:
            decided[p.key] = False
            rows.append((p, "already on %s" % where))
            continue
        if latest is not None:
            if kind(latest) is None:
                raise Failure("%s: %s's latest version %r is not one this plan understands" % (p.name, where, latest))
            if lower_than(p.version, latest):
                raise Failure("%s %s is lower than %s's latest %s; refusing to publish it automatically"
                              % (p.name, p.version, where, latest))
        decided[p.key] = True
        rows.append((p, "not on %s: publish" % where))
    for p in pkgs:
        if decided[p.key]:
            check_release_files(p)
    return decided, rows


def summary(mode, rows):
    lines = ["### Publish plan (%s)" % mode, "", "| Package | Version | Plan |", "| --- | --- | --- |"]
    lines += ["| %s | %s | %s |" % (p.name, p.version, text) for p, text in rows]
    return "\n".join(lines) + "\n"


def append(path, text):
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(text)


def main(argv, env=os.environ, fetch_fn=fetch, sleep=time.sleep):
    root = argv[1] if len(argv) > 1 else "."
    mode = env.get("PUBLISH_MODE", "")
    try:
        decided, rows = plan(mode, packages(root), fetch_fn, sleep)
    except Failure as failure:
        print("::error::publish plan: %s" % failure)
        append(env.get("GITHUB_STEP_SUMMARY"), "### Publish plan (%s)\n\nFailed, nothing is published: %s\n"
               % (mode, failure))
        return 1
    text = summary(mode, rows)
    print(text)
    append(env.get("GITHUB_STEP_SUMMARY"), text)
    append(env.get("GITHUB_OUTPUT"), "".join("%s=%s\n" % (k, "true" if v else "false") for k, v in decided.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
