"""GitHub Releases named YYYYMMDD-xx (README, "Releases on GitHub"): one per commit of main that passed sdk-ci.

  python3 -I github_release.py repo [asset file ...]
      GITHUB_TOKEN (contents: write), GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_RUN_ID, GITHUB_SERVER_URL, GITHUB_API_URL
      RELEASE_INTRO   one line of text that opens the notes
      RELEASE_FACTS   optional JSON list of [label, value] pairs for the table under it

What this file does:
  - the name: the UTC date and a two-digit counter that starts at 00 every day (next_name); the
    tag has the same name and is created by GitHub together with the release, on the released commit;
  - one release per thing released (a key in a comment of the notes): asking twice creates nothing twice; a draft
    that an interrupted attempt left for another key is deleted after a day;
  - draft first, files next, published last: a release is never visible half-filled, and the order is the one
    GitHub asks for where immutable releases are turned on;
  - the notes' shared parts: the table of facts, the attached files with their SHA-256, the commits since the
    previous release (subject lines only: no authors, no e-mail addresses).

Standard library only. No checkout and no git: everything comes from the GitHub API with the job's GITHUB_TOKEN.
"""

import datetime
import hashlib
import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from http.client import HTTPException

NAME = re.compile(r"(\d{8})-(\d{2,})")
KEY_MARK = "<!-- release-key: %s -->"
KEY_FIND = re.compile(r"<!-- release-key: ([A-Za-z0-9:._-]+) -->")
# How many times publishing takes the next number when GitHub says the tag exists (someone else got there first).
NAME_TRIES = 5
MAX_COMMITS = 50
# How many pages of 100 releases are read when looking for an existing one, and how many of the newest published
# releases are asked "is this commit after you?" when looking for the previous one.
MAX_RELEASE_PAGES = 5
MAX_ANCESTRY = 10
MAX_REDIRECTS = 3
MAX_FILE_BYTES = 200 * 1024 * 1024
NET_ERRORS = (OSError, HTTPException, ValueError, KeyError)


class Failure(Exception):
    """A problem that stops the job (exit code 1, the message as an error annotation). `status`: the HTTP status
    when GitHub refused a request, else None."""
    status = None


def refused(message, status):
    failure = Failure(message)
    failure.status = status
    return failure


# ---------------------------------------------------------------- the name

def utc_day(now):
    """YYYYMMDD of an aware datetime, in UTC."""
    return now.astimezone(datetime.timezone.utc).strftime("%Y%m%d")


def next_name(day, taken):
    """The next free name of that day: <day>-00 when the day has none, else one more than the highest number in
    use (a free number below the highest is not given out; names of other days and other tags do not count)."""
    numbers = [int(m.group(2)) for m in (NAME.fullmatch(name or "") for name in taken) if m and m.group(1) == day]
    return "%s-%02d" % (day, max(numbers) + 1 if numbers else 0)


# ---------------------------------------------------------------- text that is safe in the notes

SECRET_LIKE = re.compile(
    r"gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----"
    r"|\b(?:\d{1,3}\.){3}\d{1,3}\b")


def escape_html(text):
    """& and < as entities, so that Task<Guid> shows as typed and an unclosed tag cannot hide what follows. Not
    inside a `code span`: there GitHub shows the characters as typed (and would show the entity's letters)."""
    parts = re.split(r"(`[^`]*`)", text)
    return "".join(part if n % 2 else part.replace("&", "&amp;").replace("<", "&lt;") for n, part in enumerate(parts))


def safe_text(text, limit=300):
    """One line of free text (a commit subject, a note) for the notes: no line breaks or control characters, nothing
    that looks like a token, a private key or an IPv4 address, no @mention (it would notify the person), no HTML
    (escape_html), no way to open an HTML comment (the release key lives in one), cut at `limit` characters."""
    text = re.sub(r" *[\x00-\x1f\x7f]+ *", " ", str(text or "")).strip()
    text = SECRET_LIKE.sub("[removed]", text)
    if len(text) > limit:
        text = text[:limit - 1] + chr(0x2026)
    return escape_html(text.replace("@", "@" + ZERO_WIDTH).replace("<!--", "<" + ZERO_WIDTH + "!--"))


ZERO_WIDTH = chr(0x200B)


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------- GitHub

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def http(method, url, headers, data=None, redirects=MAX_REDIRECTS):
    """(status, body). A GET redirect is followed (at most MAX_REDIRECTS in a row, to https addresses only) WITHOUT
    the request's headers, so the token never reaches the storage a download redirects to. Any other redirect is an
    error."""
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with OPENER.open(request, timeout=120) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as e:
        location = e.headers.get("Location") if e.headers else None
        if method != "GET" or e.code not in (301, 302, 303, 307, 308) or not location:
            raise
        target = urllib.parse.urljoin(url, location)
    # The target never goes into a message: download addresses are signed.
    if redirects <= 0:
        raise OSError("too many redirects")
    if not target.lower().startswith("https://"):
        raise OSError("redirect to an address that is not https")
    return http("GET", target, {}, None, redirects - 1)


# Why GitHub refuses a write with 403 or 404. The third cause is GitHub's rule for tokens without the `workflows`
# permission (GITHUB_TOKEN never has it): creating a release whose tag is new on a commit that changes
# .github/workflows needs that permission (REST docs, "Create a release", target_commitish).
PERMISSION_HINT = (" (one of: the job lacks `permissions: contents: write`; a tag rule stops GITHUB_TOKEN from "
                   "creating tags; or the released commit's files under .github/workflows are not ones GitHub "
                   "accepts from this token, which running again later does not change)")


class GitHub:
    """The REST API with the job's GITHUB_TOKEN. The tests replace call, download and upload."""

    def __init__(self, token, repo, api_url="https://api.github.com", server_url="https://github.com"):
        self.token, self.repo = token, repo
        self.api_url, self.server_url = api_url.rstrip("/"), server_url.rstrip("/")

    def _headers(self, accept="application/vnd.github+json"):
        return {"Authorization": "Bearer " + self.token, "Accept": accept, "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "tth-github-release"}

    def call(self, method, path, body=None, tolerate=()):
        """(status, JSON). `path` starts after /repos/<owner>/<repo>. An HTTP error is a Failure, except the status
        codes in `tolerate`, which come back as (code, the error's JSON or None)."""
        headers = self._headers()
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        where = "%s %s" % (method, path.split("?")[0])
        try:
            status, raw = http(method, "%s/repos/%s%s" % (self.api_url, self.repo, path), headers, data)
        except urllib.error.HTTPError as e:
            if e.code in tolerate:
                try:
                    return e.code, json.loads(e.read() or b"null")
                except (ValueError, OSError):
                    return e.code, None
            hint = PERMISSION_HINT if e.code in (403, 404) and method != "GET" else ""
            raise refused("GitHub API %s: HTTP %d%s" % (where, e.code, hint), e.code)
        except NET_ERRORS as e:
            raise Failure("GitHub API %s: %s" % (where, e))
        try:
            return status, (json.loads(raw) if raw else None)
        except ValueError:
            raise Failure("GitHub API %s: not JSON" % where)

    def get(self, path, tolerate=()):
        return self.call("GET", path, tolerate=tolerate)[1]

    def download(self, path, accept="application/vnd.github+json"):
        """The bytes behind an API path that answers with the file or a redirect to it (an artifact's zip, a release
        asset with accept application/octet-stream, a file's raw content)."""
        try:
            return http("GET", "%s/repos/%s%s" % (self.api_url, self.repo, path), self._headers(accept))[1]
        except urllib.error.HTTPError as e:
            raise refused("download %s: HTTP %d" % (path.split("?")[0], e.code), e.code)
        except NET_ERRORS as e:
            raise Failure("download %s: %s" % (path.split("?")[0], e))

    def upload(self, release, name, data, content_type):
        """Attaches a file to a release (the upload host named by the release itself)."""
        url = "%s?%s" % (release["upload_url"].split("{")[0], urllib.parse.urlencode({"name": name}))
        headers = self._headers()
        headers["Content-Type"] = content_type
        try:
            http("POST", url, headers, data)
        except urllib.error.HTTPError as e:
            raise refused("upload of %s: HTTP %d" % (name, e.code), e.code)
        except NET_ERRORS as e:
            raise Failure("upload of %s: %s" % (name, e))

    def url(self, path):
        return "%s/%s%s" % (self.server_url, self.repo, path)


def file_at(gh, path, ref):
    """The text of a file of this repository at a commit or tag, or None when it does not exist there."""
    try:
        return gh.download("/contents/%s?ref=%s" % (urllib.parse.quote(path), urllib.parse.quote(ref, safe="")),
                           accept="application/vnd.github.raw+json").decode("utf-8", "replace")
    except Failure as e:
        if e.status == 404:
            return None
        raise


def artifact_files(gh, artifact_id, wanted):
    """{name: bytes} of the files named in `wanted` inside an artifact (a zip); only those names are read, by their
    exact name, each up to MAX_FILE_BYTES."""
    blob = gh.download("/actions/artifacts/%d/zip" % int(artifact_id))
    found = {}
    try:
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            for info in archive.infolist():
                if info.filename in wanted and info.file_size <= MAX_FILE_BYTES:
                    found[info.filename] = archive.read(info)
    except zipfile.BadZipFile:
        raise Failure("artifact %s is not a valid zip file" % artifact_id)
    return found


def newest_first(artifacts, name):
    found = [a for a in artifacts if a.get("name") == name and not a.get("expired")]
    return sorted(found, key=lambda a: a.get("created_at") or "", reverse=True)


def artifacts_named(gh, name, run_id=None):
    """The artifacts of this repository with exactly this name that can still be downloaded, newest first; with
    run_id, only the ones that run uploaded."""
    listing = gh.get("/actions/artifacts?per_page=100&name=%s" % urllib.parse.quote(name, safe="")) or {}
    found = newest_first(listing.get("artifacts", []), name)
    if run_id is not None:
        found = [a for a in found if str((a.get("workflow_run") or {}).get("id")) == str(run_id)]
    return found


def run_artifacts(gh, run_id, name):
    """The artifacts with this name that one run uploaded, newest first (several when the run had attempts)."""
    listing = gh.get("/actions/runs/%d/artifacts?per_page=100" % int(run_id), tolerate=(404,)) or {}
    return newest_first(listing.get("artifacts", []), name)


# ---------------------------------------------------------------- releases

def list_releases(gh):
    """The newest releases (up to MAX_RELEASE_PAGES pages of 100), drafts included (the token can write, so GitHub
    lists them)."""
    releases = []
    for page in range(1, MAX_RELEASE_PAGES + 1):
        found = gh.get("/releases?per_page=100&page=%d" % page) or []
        releases += found
        if len(found) < 100:
            break
    return releases


def release_key(release):
    match = KEY_FIND.search(release.get("body") or "")
    return match.group(1) if match else None


def find_release(releases, key):
    """The release made for this key (published first, else a draft a failed attempt left), or None."""
    same = [r for r in releases if release_key(r) == key]
    return next((r for r in same if not r.get("draft")), same[0] if same else None)


def published_releases(releases, key=None):
    """The published releases (not the one of `key`), newest publication first."""
    published = [r for r in releases if not r.get("draft") and r.get("tag_name") and release_key(r) != key]
    return sorted(published, key=lambda r: r.get("published_at") or r.get("created_at") or "", reverse=True)


def previous_by_ancestry(gh, releases, key, sha):
    """(previous, latest) for a release of commit `sha`: previous is the newest published release whose commit is an
    ancestor of sha (asked of the MAX_ANCESTRY newest), or None; latest is False when the newest published release
    is of a commit that sha is behind of or has diverged from (a release made late for an older commit must not
    become "Latest")."""
    latest = True
    for n, release in enumerate(published_releases(releases, key)[:MAX_ANCESTRY]):
        compare = gh.get("/compare/%s...%s?per_page=1" % (urllib.parse.quote(release["tag_name"], safe=""), sha),
                         tolerate=(404,))
        status = compare.get("status") if isinstance(compare, dict) else None
        if status in ("ahead", "identical"):
            return release, latest
        if n == 0 and status in ("behind", "diverged"):
            latest = False
    return None, latest


def parse_time(value):
    try:
        return datetime.datetime.strptime(value or "", "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    except (ValueError, TypeError):
        return None


def drop_stale_drafts(gh, releases, key, now):
    """Deletes the drafts this code made for ANOTHER key more than a day ago: what an attempt left that was
    cancelled between the draft and the publishing and never run again (a draft has no tag and is seen only by
    people who can write). A draft without a key is someone's own and stays."""
    for release in releases:
        other, created = release_key(release), parse_time(release.get("created_at"))
        if release.get("draft") and other and other != key and created \
                and now - created > datetime.timedelta(days=1):
            gh.call("DELETE", "/releases/%d" % release["id"], tolerate=(404,))


def taken_names(gh, releases, day):
    """Every name of that day in use: by a release (drafts too) or by a tag without a release (GitHub would attach
    a release to such a tag, whatever commit it points to)."""
    names = {r.get("tag_name") for r in releases} | {r.get("name") for r in releases}
    for ref in gh.get("/git/matching-refs/tags/%s-" % day) or []:
        names.add((ref.get("ref") or "").replace("refs/tags/", "", 1))
    return {n for n in names if n}


def already_exists(error):
    """True when a 422 says the tag is taken (errors[].code already_exists)."""
    errors = (error or {}).get("errors") if isinstance(error, dict) else None
    return any(isinstance(e, dict) and e.get("code") == "already_exists" for e in errors or [])


def publish(gh, key, sha, body, assets, now, latest=True):
    """(release, created): the published release of `key` on commit `sha`, with `assets` ([(name, bytes, content
    type)]) attached. An existing published release of the key is returned untouched (created False). Otherwise:
    a draft (a new one, or the one an earlier failed attempt left, emptied first), the files, then the publishing
    under the day's next free name; when GitHub answers that the tag exists, the next number, a few times."""
    releases = list_releases(gh)
    release = find_release(releases, key)
    if release and not release.get("draft"):
        return release, False
    drop_stale_drafts(gh, releases, key, now)
    day = utc_day(now)

    def free_name(listed, more=()):
        # The own draft's provisional name does not count: finishing it later must not skip a number.
        others = [r for r in listed if not (release and r.get("id") == release.get("id"))]
        return next_name(day, taken_names(gh, others, day) | set(more))

    name = free_name(releases)
    fields = {"tag_name": name, "name": name, "target_commitish": sha, "body": body, "draft": True,
              "prerelease": False}
    if release:
        for asset in release.get("assets") or []:
            gh.call("DELETE", "/releases/assets/%d" % asset["id"])
        release = gh.call("PATCH", "/releases/%d" % release["id"], fields)[1]
    else:
        release = gh.call("POST", "/releases", fields)[1]
    for asset_name, data, content_type in assets:
        gh.upload(release, asset_name, data, content_type)
    tried = set()
    for _ in range(NAME_TRIES):
        status, answer = gh.call("PATCH", "/releases/%d" % release["id"],
                                 {"tag_name": name, "name": name, "target_commitish": sha, "draft": False,
                                  "prerelease": False, "make_latest": "true" if latest else "false"}, tolerate=(422,))
        if status != 422:
            return answer, True
        if not already_exists(answer):
            raise Failure("GitHub refused to publish the release %s: %s" % (name, json.dumps(answer)[:300]))
        tried.add(name)
        name = free_name(list_releases(gh), tried)
    raise Failure("no free release name for %s after %d tries (the draft is kept: run the job again)" % (day, NAME_TRIES))


# ---------------------------------------------------------------- the notes' shared parts

def compare_commits(gh, base, sha):
    """(status, total, the newest commits of base...sha, newest first, at most MAX_COMMITS), or None when GitHub
    cannot compare. GitHub lists the commits oldest first, 100 a page: the newest are on the last page (and, when
    that one is short, on the one before it too)."""
    path = "/compare/%s...%s?per_page=100&page=%%d" % (urllib.parse.quote(base, safe=""), sha)
    first = gh.get(path % 1, tolerate=(404,))
    if not isinstance(first, dict) or "commits" not in first:
        return None
    total = first.get("total_commits") or len(first["commits"])
    pages = max(1, -(-total // 100))
    commits = first["commits"] if pages == 1 else (gh.get(path % pages, tolerate=(404,)) or {}).get("commits") or []
    if pages > 1 and len(commits) < MAX_COMMITS:
        before = first if pages == 2 else gh.get(path % (pages - 1), tolerate=(404,)) or {}
        commits = (before.get("commits") or []) + commits
    return first.get("status"), total, list(reversed(commits))[:MAX_COMMITS]


def commits_since(gh, previous, sha, first=True):
    """(lines, note): the commits from the previous release's tag to sha as Markdown list lines, newest first, at most
    MAX_COMMITS, subject lines only; note says what is missing or why there is no list. `first`: no release exists
    yet (else, without a previous one, none of them is of an ancestor of this commit)."""
    if not previous:
        return [], ("This is the first release of this repository." if first else
                    "None of the earlier releases is of an ancestor of this commit: no list of changes.")
    tag = previous["tag_name"]
    compared = compare_commits(gh, tag, sha)
    if compared is None:
        return [], "The commits since %s could not be listed." % tag
    status, total, commits = compared
    if status == "identical":
        return [], "No new commits since %s: the same commit, released again." % tag
    lines = []
    for commit in commits:
        subject = ((commit.get("commit") or {}).get("message") or "").split("\n", 1)[0]
        lines.append("- %s %s" % ((commit.get("sha") or "")[:12], safe_text(subject, 200)))
    note = ""
    if status != "ahead":
        note = "This commit is not a descendant of %s (%s): the list shows what this commit has and %s has not." % (
            tag, status, tag)
    if total > len(lines):
        note = ("%s The newest %d of %d commits are listed." % (note, len(lines), total)).strip()
    return lines, note


def changes_section(gh, previous, sha, first=True):
    lines, note = commits_since(gh, previous, sha, first)
    title = "### Changes since [%s](%s)" % (previous["tag_name"], previous.get("html_url") or "") if previous \
        else "### Changes"
    return [title, ""] + lines + ([""] if lines and note else []) + ([note] if note else [])


def facts_table(facts):
    """A two-column table of (label, value); values are Markdown written by this code."""
    return ["| | |", "| --- | --- |"] + ["| %s | %s |" % (label, str(value).replace("\n", " ").replace("|", "\\|"))
                                         for label, value in facts]


def assets_section(assets, about=None):
    """The attached files: name, what it is (about[name]), SHA-256."""
    if not assets:
        return []
    about = about or {}
    lines = ["### Attached files", "", "| File | What | SHA-256 |", "| --- | --- | --- |"]
    lines += ["| `%s` | %s | `%s` |" % (name, about.get(name, ""), sha256_hex(data)) for name, data, _ in assets]
    return lines


def write_summary(text):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(text + "\n")
    print(text)


def report(release, created):
    write_summary("%s GitHub release [%s](%s)." % (
        "Created" if created else "Nothing to do: this was already released as", release.get("name") or
        release.get("tag_name"), release.get("html_url") or ""))


def annotate(level, text):
    print("::%s::%s" % (level, text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")))


def from_env():
    """(GitHub, commit) from the job's environment."""
    env = os.environ
    for name in ("GITHUB_TOKEN", "GITHUB_REPOSITORY"):
        if not env.get(name):
            raise Failure("%s is not set" % name)
    gh = GitHub(env["GITHUB_TOKEN"], env["GITHUB_REPOSITORY"], env.get("GITHUB_API_URL") or "https://api.github.com",
                env.get("GITHUB_SERVER_URL") or "https://github.com")
    return gh, env.get("GITHUB_SHA", "")


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc)


# ---------------------------------------------------------------- a repository whose release is a checked commit

CONTENT_TYPES = {".json": "application/json", ".tgz": "application/gzip", ".gz": "application/gzip",
                 ".whl": "application/zip", ".yaml": "text/yaml", ".txt": "text/plain"}


def content_type(name):
    return CONTENT_TYPES.get(os.path.splitext(name)[1], "application/octet-stream")


def repo_release(gh, sha, intro, facts, assets, now, about=None):
    """One release per commit: the commit `sha` of main after its checks passed. `facts` is a list of (label, value)
    or a function of the previous release that returns one. The previous release is the newest one of an ancestor
    of this commit, whatever was published when."""
    if not re.fullmatch(r"[0-9a-f]{40}", sha or ""):
        raise Failure("GITHUB_SHA is not a commit: %r" % sha)
    key = "commit:" + sha
    releases = list_releases(gh)
    existing = find_release(releases, key)
    if existing and not existing.get("draft"):
        return existing, False
    previous, latest = previous_by_ancestry(gh, releases, key, sha)
    if callable(facts):
        facts = facts(previous)
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    rows = [("Commit", "%s" % sha)]
    if run_id.isdigit():
        rows.append(("Checked by", "[run %s](%s)" % (run_id, gh.url("/actions/runs/" + run_id))))
    rows.append(("Previous release", "[%s](%s)" % (previous["tag_name"], previous.get("html_url") or "")
                 if previous else "none"))
    lines = [KEY_MARK % key, safe_text(intro, 500), ""] + facts_table(rows + list(facts)) + [""]
    lines += changes_section(gh, previous, sha, first=not published_releases(releases, key))
    if assets:
        lines += [""] + assets_section(assets, about)
    return publish(gh, key, sha, "\n".join(lines) + "\n", assets, now, latest=latest)


def read_files(paths):
    assets = []
    for path in paths:
        with open(path, "rb") as f:
            assets.append((os.path.basename(path), f.read(), content_type(path)))
    return assets


def main(argv):
    if len(argv) < 2 or argv[1] != "repo":
        print("usage: github_release.py repo [asset file ...]", file=sys.stderr)
        return 2
    try:
        gh, sha = from_env()
        try:
            facts = json.loads(os.environ.get("RELEASE_FACTS") or "[]")
            facts = [(safe_text(label, 80), safe_text(value, 300)) for label, value in facts]
        except (ValueError, TypeError):
            raise Failure("RELEASE_FACTS must be a JSON list of [label, value] pairs")
        release, created = repo_release(gh, sha, os.environ.get("RELEASE_INTRO") or "Released commit.", facts,
                                        read_files(sorted(argv[2:])), now_utc())
        report(release, created)
    except Failure as e:
        annotate("error", "no GitHub release was created: %s" % e)
        return 1
    except Exception as e:  # a bug here must still end with a readable message
        annotate("error", "no GitHub release was created: unexpected %s: %s" % (type(e).__name__, e))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
