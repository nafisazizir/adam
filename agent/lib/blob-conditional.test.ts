import assert from "node:assert/strict";
import { test } from "node:test";
import { BlobError, BlobPreconditionFailedError } from "@vercel/blob";

import { BlobWriteConflict, isBlobWriteConflict } from "#lib/blob-conditional.js";

test("a stale or wrong etag is a conflict", () => {
  assert.equal(isBlobWriteConflict(new BlobPreconditionFailedError()), true);
});

test("losing a create race is a conflict", () => {
  const message = "Vercel Blob: This blob already exists, use `allowOverwrite: true` if you want to overwrite it.";
  assert.equal(isBlobWriteConflict(new BlobError(message)), true);
});

test("an ifMatch write to a deleted blob is a conflict", () => {
  assert.equal(isBlobWriteConflict(new BlobError("Vercel Blob: The specified key does not exist.")), true);
});

test("an already-classified conflict stays one", () => {
  assert.equal(isBlobWriteConflict(new BlobWriteConflict("x")), true);
});

test("other failures are not conflicts", () => {
  assert.equal(isBlobWriteConflict(new BlobError("Vercel Blob: Access denied")), false);
  assert.equal(isBlobWriteConflict(new Error("already exists")), false);
  assert.equal(isBlobWriteConflict(null), false);
});
