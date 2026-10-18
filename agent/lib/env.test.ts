import assert from "node:assert/strict";
import { test } from "node:test";

import { googleConnectorSchema } from "#lib/env.js";

test("the Google connector is optional, and blank means unset", () => {
  assert.equal(googleConnectorSchema.parse(undefined), undefined);
  assert.equal(googleConnectorSchema.parse(""), undefined);
});

test("the Google connector is one connector id or UID", () => {
  assert.equal(googleConnectorSchema.parse("scl_abc123"), "scl_abc123");
  assert.equal(googleConnectorSchema.parse("adam-google"), "adam-google");
});

test("the old one-connector-per-account list is refused with what to set instead", () => {
  const parsed = googleConnectorSchema.safeParse("personal=scl_a,work=scl_b");
  assert.equal(parsed.success, false);
  assert.match(parsed.error?.issues[0]?.message ?? "", /one Vercel Connect connector id or UID/u);
});
