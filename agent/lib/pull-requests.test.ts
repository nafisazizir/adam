import assert from "node:assert/strict";
import { test } from "node:test";
import { pullRequestName, samePullRequest } from "#lib/pull-requests.js";

test("names a pull request by repo and number", () => {
  assert.equal(pullRequestName("https://github.com/Owner/Repo/pull/12/files"), "owner/repo#12");
});

test("matches the same pull request across url spellings", () => {
  assert.ok(samePullRequest("github.com/owner/repo/pull/3", "https://www.github.com/OWNER/repo/pull/3"));
  assert.ok(!samePullRequest("github.com/owner/repo/pull/3", "github.com/owner/repo/pull/4"));
});
