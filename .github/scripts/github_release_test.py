"""Tests of github_release.py (names, drafts and publishing, the notes' shared parts), standard library only, no
network.

  python3 .github/scripts/github_release_test.py

FakeGitHub keeps releases, tags, artifacts and files in memory and answers the API paths the scripts use.
"""

import datetime
import io
import os
import re
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import github_release as core  # noqa: E402

SHA = "a" * 40
NOON = datetime.datetime(2026, 11, 20, 12, 0, 0, tzinfo=datetime.timezone.utc)
ZW = chr(0x200B)


def zipped(files):
    blob = io.BytesIO()
    with zipfile.ZipFile(blob, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return blob.getvalue()


class FakeGitHub(core.GitHub):
    def __init__(self):
        super().__init__("token-never-sent", "owner/repo")
        self.releases, self.tags, self.artifacts = [], [], []
        self.compare, self.files, self.commits, self.runs, self.jobs = {}, {}, {}, {}, {}
        self.conflicts = []  # names another release takes between the listing and the publishing (answered 422 once)
        self.fail_upload = None  # a file name whose upload fails once
        self.writes = []  # (method, path) of every request that changes something, uploads included
        self.created_at = "2026-11-20T12:00:00Z"  # of the next draft
        self.ids = 0

    def _id(self):
        self.ids += 1
        return self.ids

    def artifact(self, name, files, head_sha=SHA, expired=False, run_id=1):
        self.artifacts.append({"id": self._id(), "name": name, "expired": expired, "files": files,
                               "created_at": "2026-11-20T10:00:%02dZ" % len(self.artifacts),
                               "workflow_run": {"id": run_id, "head_sha": head_sha}})

    def published(self, name, key, body="", assets=None, published_at=None):
        """A release that exists already (published_at: by default in the order of the calls, within the name's
        day)."""
        release = {"id": self._id(), "tag_name": name, "name": name, "draft": False, "target_commitish": SHA,
                   "body": core.KEY_MARK % key + "\n" + body, "html_url": "https://github.test/r/" + name,
                   "published_at": published_at or "2026-11-%02dT00:%02d:00Z" % (int(name[6:8]), self._id() % 60),
                   "created_at": "2026-11-%02dT00:00:00Z" % int(name[6:8]),
                   "upload_url": "https://uploads.test/%s{?name,label}" % name,
                   "assets": [{"id": self._id(), "name": n, "data": d} for n, d in (assets or {}).items()]}
        self.releases.insert(0, release)
        return release

    def _refuse(self, code, error, tolerate):
        if code in tolerate:
            return code, error
        raise core.refused("HTTP %d" % code, code)

    def call(self, method, path, body=None, tolerate=()):
        route, _, query = path.partition("?")
        query = {k: v[0] for k, v in urllib.parse.parse_qs(query).items()}
        if method != "GET":
            self.writes.append((method, route))
        if (method, route) == ("GET", "/releases"):
            return 200, [dict(r) for r in self.releases] if query.get("page", "1") == "1" else []
        if (method, route) == ("POST", "/releases"):
            release = dict(body, id=self._id(), assets=[], html_url="", published_at=None, created_at=self.created_at,
                           upload_url="https://uploads.test/x{?name,label}")
            self.releases.insert(0, release)
            return 201, dict(release)
        match = re.fullmatch(r"/releases/(\d+)", route)
        if match and method == "DELETE":
            self.releases = [r for r in self.releases if r["id"] != int(match.group(1))]
            return 204, None
        if match and method == "PATCH":
            release = next(r for r in self.releases if r["id"] == int(match.group(1)))
            if release.get("draft") and body.get("draft") is False:
                name = body["tag_name"]
                taken = name in self.conflicts or any(
                    r is not release and not r.get("draft") and r["tag_name"] == name for r in self.releases)
                if taken:
                    if name in self.conflicts:  # the other release and its tag exist from now on
                        self.conflicts.remove(name)
                        self.tags.append(name)
                    return self._refuse(422, {"errors": [{"code": "already_exists", "field": "tag_name"}]}, tolerate)
                # Like GitHub: a tag that exists without a release is used as it is (target_commitish is ignored).
                release.update(published_at="2026-11-20T12:%02d:00Z" % (self._id() % 60),
                               html_url="https://github.test/r/" + name, on_existing_tag=name in self.tags)
            release.update(body)
            return 200, dict(release)
        match = re.fullmatch(r"/releases/assets/(\d+)", route)
        if match and method == "DELETE":
            for release in self.releases:
                release["assets"] = [a for a in release["assets"] if a["id"] != int(match.group(1))]
            return 204, None
        if route.startswith("/git/matching-refs/tags/"):
            prefix = route.rsplit("/", 1)[1]
            return 200, [{"ref": "refs/tags/" + t} for t in self.tags if t.startswith(prefix)]
        if route.startswith("/compare/"):
            found = self.compare.get(route[len("/compare/"):])
            if not found:
                return self._refuse(404, None, tolerate)
            size, page = int(query.get("per_page", 30)), int(query.get("page", 1))
            return 200, dict(found, commits=found["commits"][(page - 1) * size:page * size])
        if route == "/actions/artifacts":
            return 200, {"artifacts": [a for a in self.artifacts if a["name"] == query["name"]]}
        match = re.fullmatch(r"/actions/runs/(\d+)/artifacts", route)
        if match:
            return 200, {"artifacts": [a for a in self.artifacts if a["workflow_run"]["id"] == int(match.group(1))]}
        match = re.fullmatch(r"/actions/runs/(\d+)/jobs", route)
        if match:
            return 200, {"jobs": self.jobs.get(match.group(1), [])}
        match = re.fullmatch(r"/actions/runs/(\d+)", route)
        if match:
            return 200, self.runs.get(match.group(1), {})
        if route.startswith("/commits/"):
            return 200, self.commits.get(route.rsplit("/", 1)[1], {})
        raise AssertionError("unexpected request %s %s" % (method, path))

    def download(self, path, accept="application/vnd.github+json"):
        route, _, query = path.partition("?")
        match = re.fullmatch(r"/actions/artifacts/(\d+)/zip", route)
        if match:
            return zipped(next(a for a in self.artifacts if a["id"] == int(match.group(1)))["files"])
        match = re.fullmatch(r"/releases/assets/(\d+)", route)
        if match:
            return next(a["data"] for r in self.releases for a in r["assets"] if a["id"] == int(match.group(1)))
        if route.startswith("/contents/"):
            key = (urllib.parse.unquote(route[len("/contents/"):]), urllib.parse.parse_qs(query)["ref"][0])
            if key not in self.files:
                raise core.refused("download %s: HTTP 404" % route, 404)
            return self.files[key].encode()
        raise AssertionError("unexpected download %s" % path)

    def upload(self, release, name, data, content_type):
        self.writes.append(("UPLOAD", name))
        if name == self.fail_upload:
            self.fail_upload = None
            raise core.refused("upload of %s: HTTP 502" % name, 502)
        stored = next(r for r in self.releases if r["id"] == release["id"])
        assert stored.get("draft"), "files are attached before publishing"
        assert all(a["name"] != name for a in stored["assets"]), "GitHub refuses a second file of the same name"
        stored["assets"].append({"id": self._id(), "name": name, "data": data})

    def commits_between(self, base, head, subjects, status="ahead"):
        """compare base...head: subjects oldest first, as GitHub lists them (in pages); every commit has an author
        e-mail."""
        self.compare["%s...%s" % (base, head)] = {
            "status": status, "total_commits": len(subjects), "files": [],
            "commits": [{"sha": "%040x" % (n + 1), "commit": {
                "message": subject + "\n\nbody text", "author": {"name": "A Person", "email": "person@example.test"}}}
                for n, subject in enumerate(subjects)]}


class NameTest(unittest.TestCase):
    def test_first_of_the_day_is_00(self):
        self.assertEqual(core.next_name("20261120", []), "20261120-00")
        self.assertEqual(core.next_name("20261120", ["20261119-00", "20261119-07", "v1.0", None, ""]), "20261120-00")

    def test_counts_up_and_never_fills_a_gap(self):
        self.assertEqual(core.next_name("20261120", ["20261120-00"]), "20261120-01")
        self.assertEqual(core.next_name("20261120", ["20261120-00", "20261120-02"]), "20261120-03")
        self.assertEqual(core.next_name("20261120", ["20261120-09"]), "20261120-10")
        self.assertEqual(core.next_name("20261120", ["20261120-99"]), "20261120-100")

    def test_only_exact_names_count(self):
        taken = ["20261120-00-rc", "x20261120-05", "20261120-5", "202611200-01"]
        self.assertEqual(core.next_name("20261120", taken), "20261120-00")

    def test_the_day_is_utc(self):
        utc = datetime.timezone.utc
        self.assertEqual(core.utc_day(datetime.datetime(2026, 11, 20, 23, 59, 59, tzinfo=utc)), "20261120")
        self.assertEqual(core.utc_day(datetime.datetime(2026, 11, 21, 0, 0, 0, tzinfo=utc)), "20261121")
        one_ahead = datetime.timezone(datetime.timedelta(hours=1))
        self.assertEqual(core.utc_day(datetime.datetime(2026, 11, 21, 0, 30, tzinfo=one_ahead)), "20261120")


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.gh = FakeGitHub()

    def publish(self, key="commit:" + SHA, assets=(("a.json", b"{}", "application/json"),), now=NOON, **more):
        return core.publish(self.gh, key, SHA, core.KEY_MARK % key + "\nnotes\n", list(assets), now, **more)

    def test_draft_then_files_then_published(self):
        release, created = self.publish()
        self.assertTrue(created)
        self.assertEqual(self.gh.writes, [("POST", "/releases"), ("UPLOAD", "a.json"),
                                          ("PATCH", "/releases/%d" % release["id"])])
        self.assertEqual((release["name"], release["tag_name"]), ("20261120-00", "20261120-00"))
        self.assertEqual(release["target_commitish"], SHA)
        self.assertEqual((release["draft"], release["prerelease"], release["make_latest"]), (False, False, "true"))
        self.assertEqual([a["name"] for a in self.gh.releases[0]["assets"]], ["a.json"])

    def test_second_of_the_day_and_a_new_day(self):
        self.publish(key="commit:1")
        self.assertEqual(self.publish(key="commit:2")[0]["name"], "20261120-01")
        tomorrow = NOON + datetime.timedelta(hours=12)
        self.assertEqual(self.publish(key="commit:3", now=tomorrow)[0]["name"], "20261121-00")

    def test_a_tag_without_a_release_takes_its_number(self):
        # GitHub would put the release on such a tag (whatever commit it is on): the listing of tags prevents it.
        self.gh.tags = ["20261120-00", "20261120-01", "20261119-05"]
        release, _ = self.publish()
        self.assertEqual((release["name"], release["on_existing_tag"]), ("20261120-02", False))

    def test_asked_twice_creates_one(self):
        first, _ = self.publish()
        self.gh.writes.clear()
        again, created = self.publish()
        self.assertFalse(created)
        self.assertEqual(again["id"], first["id"])
        self.assertEqual(self.gh.writes, [])
        self.assertEqual(len(self.gh.releases), 1)

    def test_taken_meanwhile_takes_the_next_number(self):
        # Someone else publishes 00 and 01 between the listing and the publishing: the listing still shows them free.
        self.gh.conflicts = ["20261120-00", "20261120-01"]
        release, created = self.publish()
        self.assertEqual((release["name"], created), ("20261120-02", True))
        self.assertEqual(len(self.gh.releases), 1)

    def test_gives_up_after_a_few_tries_and_the_next_run_finishes_the_draft(self):
        self.gh.conflicts = ["20261120-%02d" % n for n in range(core.NAME_TRIES)]
        with self.assertRaises(core.Failure):
            self.publish()
        self.assertEqual([r["draft"] for r in self.gh.releases], [True])
        release, created = self.publish(assets=(("b.json", b"{}", "application/json"),))
        self.assertTrue(created)
        self.assertEqual(release["name"], "20261120-%02d" % core.NAME_TRIES)
        self.assertEqual(len(self.gh.releases), 1)
        self.assertEqual([a["name"] for a in self.gh.releases[0]["assets"]], ["b.json"])

    def test_an_upload_that_fails_midway_is_resumed_as_one_release(self):
        files = (("a.json", b"1", "application/json"), ("b.json", b"2", "application/json"),
                 ("c.json", b"3", "application/json"))
        self.gh.fail_upload = "b.json"
        with self.assertRaises(core.Failure):
            self.publish(assets=files)
        self.assertEqual([(r["draft"], [a["name"] for a in r["assets"]]) for r in self.gh.releases], [(True, ["a.json"])])
        release, created = self.publish(assets=files)
        self.assertEqual((created, release["name"], len(self.gh.releases)), (True, "20261120-00", 1))
        self.assertEqual([(a["name"], a["data"]) for a in self.gh.releases[0]["assets"]],
                         [("a.json", b"1"), ("b.json", b"2"), ("c.json", b"3")])

    def test_another_refusal_is_not_retried(self):
        real = self.gh.call

        def call(method, path, body=None, tolerate=()):
            if method == "PATCH" and body.get("draft") is False:
                return 422, {"errors": [{"code": "invalid", "field": "target_commitish"}]}
            return real(method, path, body, tolerate)
        self.gh.call = call
        with self.assertRaises(core.Failure) as raised:
            self.publish()
        self.assertIn("refused", str(raised.exception))

    def test_not_latest_when_asked(self):
        self.assertEqual(self.publish(latest=False)[0]["make_latest"], "false")

    def test_old_drafts_of_other_keys_are_deleted(self):
        def draft(key, created_at):
            self.gh.created_at = created_at
            self.gh.call("POST", "/releases", {"tag_name": "x", "name": "x", "draft": True,
                                               "body": core.KEY_MARK % key if key else "someone's own draft"})
        draft("commit:old", "2026-11-19T11:59:59Z")  # an interrupted attempt of another commit, over a day ago
        draft("commit:recent", "2026-11-19T12:00:01Z")  # less than a day: maybe still at work
        draft(None, "2026-11-01T00:00:00Z")  # not made by this code
        self.gh.published("20261101-00", "commit:published")
        self.publish()
        self.assertEqual(sorted(core.release_key(r) or "none" for r in self.gh.releases),
                         ["commit:" + SHA, "commit:published", "commit:recent", "none"])

    def test_all_pages_of_releases_are_read(self):
        pages = {"1": [{"id": n, "body": ""} for n in range(100)], "2": [{"id": 100, "body": core.KEY_MARK % "commit:x"}]}
        asked = []

        def call(method, path, body=None, tolerate=()):
            asked.append(path)
            return 200, pages.get(path.rsplit("=", 1)[1], [])
        self.gh.call = call
        releases = core.list_releases(self.gh)
        self.assertEqual((len(releases), core.find_release(releases, "commit:x")["id"]), (101, 100))
        self.assertEqual(asked, ["/releases?per_page=100&page=1", "/releases?per_page=100&page=2"])


class PreviousTest(unittest.TestCase):
    def setUp(self):
        self.gh = FakeGitHub()

    def previous(self):
        previous, latest = core.previous_by_ancestry(self.gh, self.gh.releases, "commit:" + SHA, SHA)
        return previous and previous["tag_name"], latest

    def test_the_newest_ancestor_not_the_newest_publication(self):
        # 20261119-00 is of an older commit than 20261118-00's? No: 18-00 was published first, 19-00 later, both
        # ancestors; then a release of a commit AFTER this one was published last.
        self.gh.published("20261118-00", "commit:1")
        self.gh.published("20261119-00", "commit:2")
        self.gh.published("20261120-00", "commit:3")
        self.gh.commits_between("20261118-00", SHA, ["x", "y"])
        self.gh.commits_between("20261119-00", SHA, ["y"])
        self.gh.commits_between("20261120-00", SHA, [], status="behind")
        self.assertEqual(self.previous(), ("20261119-00", False))

    def test_newest_is_an_ancestor(self):
        self.gh.published("20261118-00", "commit:1")
        self.gh.published("20261119-00", "commit:2")
        self.gh.commits_between("20261119-00", SHA, ["y"])
        self.assertEqual(self.previous(), ("20261119-00", True))

    def test_no_ancestor_or_no_release(self):
        self.assertEqual(self.previous(), (None, True))
        self.gh.published("20261119-00", "commit:2")
        self.gh.commits_between("20261119-00", SHA, ["y"], status="diverged")
        self.assertEqual(self.previous(), (None, False))
        self.gh.compare.clear()  # GitHub cannot compare (the tag is gone): unknown, so not demoted
        self.assertEqual(self.previous(), (None, True))

    def test_drafts_and_the_own_release_do_not_count(self):
        self.gh.published("20261119-00", "commit:" + SHA)
        self.gh.releases.insert(0, {"id": 99, "draft": True, "tag_name": "20261120-00", "body": ""})
        self.assertEqual(self.previous(), (None, True))


class NotesTest(unittest.TestCase):
    def setUp(self):
        self.gh = FakeGitHub()
        self.old_env = dict(os.environ)
        os.environ["GITHUB_RUN_ID"] = "77"
        os.environ.pop("GITHUB_STEP_SUMMARY", None)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old_env)

    def test_first_release_of_a_repository(self):
        release, created = core.repo_release(self.gh, SHA, "SDK packages.", [("TypeScript SDK", "0.1.0")],
                                             [("sdk.tgz", b"tar", "application/gzip")], NOON)
        body = release["body"]
        self.assertTrue(created)
        self.assertEqual(core.release_key(release), "commit:" + SHA)
        self.assertIn("| TypeScript SDK | 0.1.0 |", body)
        self.assertIn("https://github.com/owner/repo/actions/runs/77", body)
        self.assertIn("This is the first release of this repository.", body)
        self.assertIn("| `sdk.tgz` |  | `%s` |" % core.sha256_hex(b"tar"), body)

    def test_commits_since_the_previous_release(self):
        self.gh.published("20261119-00", "commit:" + "b" * 40)
        self.gh.commits_between("20261119-00", SHA, ["first change", "ping @someone <!-- x -->", "last change"])
        release = core.repo_release(self.gh, SHA, "Checked.", [], [], NOON)[0]
        body = release["body"]
        listed = [line for line in body.splitlines() if line.startswith("- ")]
        self.assertEqual([line.split(" ", 2)[2] for line in listed],
                         ["last change", "ping @%ssomeone &lt;%s!-- x -->" % (ZW, ZW), "first change"])
        self.assertIn("### Changes since [20261119-00](https://github.test/r/20261119-00)", body)
        for private in ("person@example.test", "A Person", "body text", "token-never-sent"):
            self.assertNotIn(private, body)
        self.assertEqual(len(core.KEY_FIND.findall(body)), 1)
        self.assertEqual(release["make_latest"], "true")

    def test_a_release_made_late_for_an_older_commit(self):
        # 20261120-00 is of a commit after this one; 20261118-00 of one before it.
        self.gh.published("20261118-00", "commit:1")
        self.gh.published("20261120-00", "commit:3")
        self.gh.commits_between("20261118-00", SHA, ["the change"])
        self.gh.commits_between("20261120-00", SHA, [], status="behind")
        release = core.repo_release(self.gh, SHA, "Checked.", [], [], NOON)[0]
        self.assertEqual((release["name"], release["make_latest"]), ("20261120-01", "false"))
        self.assertIn("| Previous release | [20261118-00]", release["body"])
        self.assertIn(" the change", release["body"])

    def test_releases_exist_but_none_is_an_ancestor(self):
        self.gh.published("20261119-00", "commit:2")
        body = core.repo_release(self.gh, SHA, "Checked.", [], [], NOON)[0]["body"]
        self.assertIn("| Previous release | none |", body)
        self.assertIn("None of the earlier releases is of an ancestor of this commit", body)

    def test_html_in_free_text_is_shown_as_typed(self):
        self.assertEqual(core.safe_text("Return Task<Guid> & co"), "Return Task&lt;Guid> &amp; co")
        self.assertEqual(core.safe_text("<details><summary>x"), "&lt;details>&lt;summary>x")
        self.assertEqual(core.safe_text("use `Task<Guid>` & `a && b`, not <b>"), "use `Task<Guid>` &amp; `a && b`, not &lt;b>")
        self.assertEqual(core.safe_text("an unclosed ` then <img src=x>"), "an unclosed ` then &lt;img src=x>")
        self.gh.published("20261119-00", "commit:2")
        self.gh.commits_between("20261119-00", SHA, ["Return Task<Guid>", "<details> hides the rest"])
        body = core.repo_release(self.gh, SHA, "Checked <b>.", [], [], NOON)[0]["body"]
        self.assertIn(" Return Task&lt;Guid>", body)
        self.assertIn(" &lt;details> hides the rest", body)
        self.assertIn("Checked &lt;b>.", body)
        self.assertEqual(body.count("<"), 1)  # only the release key's comment

    def test_more_than_a_page_of_commits_lists_the_newest(self):
        previous = self.gh.published("20261119-00", "commit:1")
        self.gh.commits_between("20261119-00", SHA, ["c%d" % n for n in range(230)])
        lines, note = core.commits_since(self.gh, previous, SHA)
        self.assertEqual([line.rsplit(" ", 1)[1] for line in lines], ["c%d" % n for n in range(229, 179, -1)])
        self.assertEqual(note, "The newest 50 of 230 commits are listed.")
        # A last page shorter than the list: the page before it supplies the rest.
        self.gh.commits_between("20261119-00", SHA, ["c%d" % n for n in range(120)])
        lines, note = core.commits_since(self.gh, previous, SHA)
        self.assertEqual([line.rsplit(" ", 1)[1] for line in lines], ["c%d" % n for n in range(119, 69, -1)])
        self.gh.commits_between("20261119-00", SHA, ["c%d" % n for n in range(310)])
        lines, _ = core.commits_since(self.gh, previous, SHA)
        self.assertEqual([line.rsplit(" ", 1)[1] for line in lines], ["c%d" % n for n in range(309, 259, -1)])
        self.gh.commits_between("20261119-00", SHA, ["c%d" % n for n in range(50)])
        self.assertEqual(core.commits_since(self.gh, previous, SHA)[1], "")

    def test_compare_not_possible_or_not_ahead(self):
        previous = self.gh.published("20261119-00", "commit:1")
        self.assertEqual(core.commits_since(self.gh, previous, SHA), ([], "The commits since 20261119-00 could not be listed."))
        self.gh.commits_between("20261119-00", SHA, ["x"], status="diverged")
        self.assertIn("not a descendant", core.commits_since(self.gh, previous, SHA)[1])

    def test_one_release_per_commit(self):
        core.repo_release(self.gh, SHA, "Checked.", [], [], NOON)
        self.gh.writes.clear()
        release, created = core.repo_release(self.gh, SHA, "Checked.", [], [], NOON)
        self.assertEqual((created, self.gh.writes, release["name"]), (False, [], "20261120-00"))
        with self.assertRaises(core.Failure):
            core.repo_release(self.gh, "main", "Checked.", [], [], NOON)

    def test_safe_text(self):
        token = "ghp_" + "A1b2" * 9
        text = core.safe_text("fix\nlogin %s on 203.0.113.7 github_pat_%s\x07 @team" % (token, "x" * 30))
        self.assertEqual(text, "fix login [removed] on [removed] [removed] @%steam" % ZW)
        self.assertEqual(len(core.safe_text("x" * 500, 100)), 100)
        self.assertEqual(core.safe_text(None), "")

    def test_files_from_an_artifact_by_exact_name_only(self):
        self.gh.artifact("reports", {"wanted.json": b"1", "../wanted.json": b"2", "other.json": b"3"}, run_id=7)
        self.gh.artifact("reports", {"wanted.json": b"old"}, expired=True, run_id=7)
        self.gh.artifact("reports", {"wanted.json": b"other run"}, run_id=8)
        found = core.artifacts_named(self.gh, "reports", run_id="7")
        self.assertEqual(len(found), 1)
        self.assertEqual(core.artifact_files(self.gh, found[0]["id"], ("wanted.json",)), {"wanted.json": b"1"})
        self.assertEqual(len(core.artifacts_named(self.gh, "reports")), 2)
        self.assertEqual(len(core.run_artifacts(self.gh, 8, "reports")), 1)

    def test_file_at_a_commit(self):
        self.gh.files[("deploy-files.version", SHA)] = "version=8\n"
        self.assertEqual(core.file_at(self.gh, "deploy-files.version", SHA), "version=8\n")
        self.assertIsNone(core.file_at(self.gh, "deploy-files.version", "20261119-00"))
        self.gh.download = lambda path, accept=None: (_ for _ in ()).throw(core.refused("download: HTTP 500", 500))
        with self.assertRaises(core.Failure):
            core.file_at(self.gh, "deploy-files.version", SHA)


class Response(io.BytesIO):
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class FakeOpener:
    """Stands in for urllib's opener: answers[url] is bytes (200) or (status, Location or None, body)."""

    def __init__(self, answers):
        self.answers, self.seen = answers, []

    def open(self, request, timeout=None):
        self.seen.append((request.get_method(), request.full_url, dict(request.header_items())))
        answer = self.answers[request.full_url]
        if isinstance(answer, bytes):
            return Response(answer)
        status, location, body = answer
        raise urllib.error.HTTPError(request.full_url, status, "x", {"Location": location} if location else {},
                                     io.BytesIO(body))


class CommandAndTransportTest(unittest.TestCase):
    def setUp(self):
        self.old_env, self.old_from_env, self.old_opener = dict(os.environ), core.from_env, core.OPENER

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old_env)
        core.from_env, core.OPENER = self.old_from_env, self.old_opener

    def test_the_repo_command(self):
        gh = FakeGitHub()
        core.from_env = lambda: (gh, SHA)
        with tempfile.TemporaryDirectory() as folder:
            for name in ("tasktohuman-0.1.0.tar.gz", "tasktohuman-sdk-0.1.0.tgz"):
                with open(os.path.join(folder, name), "wb") as f:
                    f.write(name.encode())
            os.environ.update(RELEASE_INTRO="The SDK packages.", GITHUB_RUN_ID="5",
                              RELEASE_FACTS='[["Python SDK (tasktohuman)", "0.1.0"]]',
                              GITHUB_STEP_SUMMARY=os.path.join(folder, "summary"))
            paths = [os.path.join(folder, n) for n in sorted(os.listdir(folder)) if n != "summary"]
            self.assertEqual(core.main(["x", "repo"] + paths), 0)
            self.assertEqual(core.main(["x", "repo"] + paths), 0)
            with open(os.path.join(folder, "summary")) as f:
                summary = f.read()
        self.assertEqual(len(gh.releases), 1)
        self.assertEqual([a["name"] for a in gh.releases[0]["assets"]],
                         ["tasktohuman-0.1.0.tar.gz", "tasktohuman-sdk-0.1.0.tgz"])
        self.assertIn("| Python SDK (tasktohuman) | 0.1.0 |", gh.releases[0]["body"])
        self.assertIn("Created GitHub release [20", summary)
        self.assertIn("Nothing to do: this was already released as GitHub release [20", summary)
        os.environ["RELEASE_FACTS"] = "{not json"
        self.assertEqual(core.main(["x", "repo"]), 1)
        self.assertEqual(core.main(["x"]), 2)
        # A bug (here: a GitHub stand-in that breaks) still ends with exit code 1, not a traceback.
        os.environ["RELEASE_FACTS"] = "[]"
        core.from_env = lambda: (None, SHA)
        self.assertEqual(core.main(["x", "repo"]), 1)

    def test_the_token_never_follows_a_redirect(self):
        api = "https://api.test/repos/owner/repo/actions/artifacts/1/zip"
        opener = core.OPENER = FakeOpener({
            api: (302, "https://storage.test/one?sig=secret", b""),
            "https://storage.test/one?sig=secret": (307, "https://storage.test/two", b""),
            "https://storage.test/two": b"the zip"})
        gh = core.GitHub("t0ken", "owner/repo", "https://api.test")
        self.assertEqual(gh.download("/actions/artifacts/1/zip"), b"the zip")
        self.assertEqual([url for _, url, _ in opener.seen], [api, "https://storage.test/one?sig=secret",
                                                              "https://storage.test/two"])
        self.assertEqual(opener.seen[0][2]["Authorization"], "Bearer t0ken")
        for _, _, headers in opener.seen[1:]:
            self.assertEqual(headers, {})

    def test_redirects_that_are_refused(self):
        gh = core.GitHub("t0ken", "owner/repo", "https://api.test")
        api = "https://api.test/repos/owner/repo/x"
        core.OPENER = FakeOpener({api: (302, "http://storage.test/plain?sig=secret", b"")})
        with self.assertRaises(core.Failure) as plain:
            gh.download("/x")
        self.assertIn("not https", str(plain.exception))
        self.assertNotIn("secret", str(plain.exception))
        self.assertEqual(len(core.OPENER.seen), 1)
        core.OPENER = FakeOpener(dict({api: (302, "https://s.test/0", b"")},
                                      **{"https://s.test/%d" % n: (302, "https://s.test/%d" % (n + 1), b"") for n in range(9)}))
        with self.assertRaises(core.Failure) as loop:
            gh.download("/x")
        self.assertIn("too many redirects", str(loop.exception))
        self.assertEqual(len(core.OPENER.seen), 1 + core.MAX_REDIRECTS)
        # A request that writes is never redirected: the refusal comes back as it is.
        core.OPENER = FakeOpener({"https://api.test/repos/owner/repo/releases": (307, "https://elsewhere.test/", b"{}")})
        with self.assertRaises(core.Failure) as write:
            gh.call("POST", "/releases", {"draft": True})
        self.assertEqual((write.exception.status, len(core.OPENER.seen)), (307, 1))

    def test_refusals_come_back_with_their_status_and_the_hint(self):
        base = "https://api.test/repos/owner/repo"
        core.OPENER = FakeOpener({
            base + "/releases?per_page=100&page=1": b'[{"id": 1}]',
            base + "/releases/1": (422, None, b'{"errors": [{"code": "already_exists", "field": "tag_name"}]}'),
            base + "/releases": (403, None, b'{"message": "Resource not accessible by integration"}'),
            base + "/releases/2": (404, None, b"{}"),
            base + "/compare/a...b": (404, None, b"{}"),
            "https://uploads.test/repos/owner/repo/releases/1/assets?name=a+b.json": b"{}"})
        gh = core.GitHub("t0ken", "owner/repo", "https://api.test/")
        self.assertEqual(core.list_releases(gh), [{"id": 1}])
        status, error = gh.call("PATCH", "/releases/1", {"draft": False}, tolerate=(422,))
        self.assertEqual((status, core.already_exists(error)), (422, True))
        with self.assertRaises(core.Failure) as conflict:
            gh.call("PATCH", "/releases/1", {"draft": False})
        self.assertEqual(conflict.exception.status, 422)
        for method, path in (("POST", "/releases"), ("PATCH", "/releases/2")):
            with self.assertRaises(core.Failure) as forbidden:
                gh.call(method, path, {"draft": True})
            message = str(forbidden.exception)
            self.assertIn(forbidden.exception.status, (403, 404))
            self.assertIn("contents: write", message)
            self.assertIn(".github/workflows", message)
            self.assertIn("running again later does not change", message)
            self.assertNotIn("t0ken", message)
        with self.assertRaises(core.Failure) as reading:
            gh.get("/compare/a...b")
        self.assertNotIn("workflows", str(reading.exception))  # the hint is about writing
        gh.upload({"upload_url": "https://uploads.test/repos/owner/repo/releases/1/assets{?name,label}"},
                  "a b.json", b"{}", "application/json")
        self.assertEqual(core.OPENER.seen[-1][:2],
                         ("POST", "https://uploads.test/repos/owner/repo/releases/1/assets?name=a+b.json"))
        self.assertFalse(core.already_exists({"errors": [{"code": "invalid"}]}))
        self.assertFalse(core.already_exists(None))


if __name__ == "__main__":
    # buffer=True: what the scripts print while a test runs (GitHub annotations of refusals the tests provoke on
    # purpose) is shown only when that test fails, so a green run puts no error line in the job summary.
    unittest.main(buffer=True)
