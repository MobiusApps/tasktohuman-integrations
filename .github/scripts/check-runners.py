"""Every job of every workflow runs on the project's self-hosted runner, never on a GitHub-hosted one, except the
jobs listed in HOSTED below.

  python3 -I -B .github/scripts/check-runners.py [.github/workflows]

A job passes when it has exactly `runs-on: [self-hosted, linux, x64, tasktohuman]`, or when it calls a reusable
workflow (`uses:` at job level; the called workflow's own jobs are checked where it lives). Anything else fails:
a GitHub-hosted label (ubuntu-24.04, ubuntu-latest …), another label set, an expression, a group, or no runs-on at
all. The workflow files are read line by line (the runner has python3 but no YAML library): `jobs:` at column 0,
job ids two spaces in, their keys four spaces in, as every workflow here is written.
"""

import os
import re
import sys

WANTED = "[self-hosted, linux, x64, tasktohuman]"
# The only jobs allowed on a GitHub-hosted runner, each with the exact label it must use: the two jobs that upload
# to npm with provenance, which npm accepts only from a GitHub-hosted runner. They build and test nothing.
HOSTED = {
    ("sdk-ci.yml", "publish-npm"): "ubuntu-24.04",
    ("sdk-ci.yml", "publish-n8n"): "ubuntu-24.04",
}
KEY = re.compile(r"^(\s*)([A-Za-z0-9_-]+):(.*)$")


def strip_comment(text):
    """The value without a trailing ` # comment` (the values checked here hold no quotes with #)."""
    return re.sub(r"\s+#.*$", "", text).strip()


def jobs_of(text):
    """{job id: {"runs-on": value or None, "uses": value or None}} of one workflow file."""
    jobs, current, in_jobs = {}, None, False
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = KEY.match(line)
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            in_jobs = bool(m and m.group(2) == "jobs")
            current = None
            continue
        if not in_jobs or not m:
            continue
        if indent == 2:
            current = m.group(2)
            jobs[current] = {"runs-on": None, "uses": None}
        elif indent == 4 and current and m.group(2) in ("runs-on", "uses"):
            jobs[current][m.group(2)] = strip_comment(m.group(3))
    return jobs


def problems(name, text):
    found = []
    jobs = jobs_of(text)
    if not jobs:
        found.append("%s: no jobs found (is `jobs:` at column 0 with jobs two spaces in?)" % name)
    for job, keys in jobs.items():
        runs_on, uses = keys["runs-on"], keys["uses"]
        if uses and runs_on is None:
            continue  # a reusable workflow call
        if runs_on is None:
            found.append("%s: job %s has no runs-on" % (name, job))
        elif (name, job) in HOSTED:
            if runs_on != HOSTED[(name, job)]:
                found.append("%s: job %s runs on %r, not %s" % (name, job, runs_on, HOSTED[(name, job)]))
        elif re.sub(r"\s+", " ", runs_on) != WANTED:
            found.append("%s: job %s runs on %r, not %s" % (name, job, runs_on, WANTED))
    return found


def main(argv):
    folder = argv[1] if len(argv) > 1 else ".github/workflows"
    files = sorted(f for f in os.listdir(folder) if f.endswith((".yml", ".yaml")))
    if not files:
        print("::error::no workflow files in %s" % folder)
        return 1
    found = []
    for f in files:
        with open(os.path.join(folder, f), encoding="utf-8") as fh:
            found += problems(f, fh.read())
    for p in found:
        print("::error::%s" % p)
    if not found:
        print("Every job of %d workflow file(s) runs on %s (%d listed exception(s))." % (len(files), WANTED, len(HOSTED)))
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
