import assert from "node:assert/strict";
import { test } from "node:test";

import { composeEmail } from "#lib/mime.js";

const blank = { to: [], cc: [], bcc: [], subject: "", body: "" };

function parts(raw: string) {
  const [head = "", body = ""] = raw.split("\r\n\r\n");
  return { headers: head.split(/\r\n(?! )/u), body: Buffer.from(body.replace(/\r\n/gu, ""), "base64").toString() };
}

test("a plain email carries its recipients, subject and a base64 utf-8 body", () => {
  const raw = composeEmail({ ...blank, to: ["Ada <ada@example.com>", "bob@example.com"], subject: "Hi", body: "line one\nline two" });
  const { headers, body } = parts(raw);
  assert.deepEqual(headers, [
    'To: "Ada" <ada@example.com>, bob@example.com',
    "Subject: Hi",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ]);
  assert.equal(body, "line one\r\nline two");
});

test("non-ASCII subjects and names become encoded words without splitting a character", () => {
  const subject = "Café ☕ ".repeat(12).trim();
  const raw = composeEmail({ ...blank, to: ["José Núñez <jose@example.com>"], subject });
  const { headers } = parts(raw);
  const encoded = headers.find((header) => header.startsWith("Subject: ")) ?? "";
  const words = [...encoded.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/gu)].map((match) => match[1] ?? "");
  assert.ok(words.length > 1);
  assert.ok(words.every((word) => `=?UTF-8?B?${word}?=`.length <= 75));
  assert.equal(words.map((word) => Buffer.from(word, "base64").toString()).join(""), subject);
  assert.match(headers[0] ?? "", /^To: =\?UTF-8\?B\?[^?]+\?= <jose@example\.com>$/u);
});

test("a line break in a header value can never start another header", () => {
  const raw = composeEmail({ ...blank, to: ["a@example.com\r\nBcc: spy@example.com"], subject: "x\nBcc: spy@example.com" });
  const { headers } = parts(raw);
  assert.ok(!headers.some((header) => header.startsWith("Bcc:")));
});

test("a reply carries In-Reply-To and References, and empty headers are left out", () => {
  const raw = composeEmail({ ...blank, to: ["a@example.com"], subject: "Re: x", inReplyTo: "<m2@x>", references: "<m1@x> <m2@x>" });
  const { headers } = parts(raw);
  assert.ok(headers.includes("In-Reply-To: <m2@x>"));
  assert.ok(headers.includes("References: <m1@x> <m2@x>"));
  assert.ok(!headers.some((header) => header.startsWith("Cc:") || header.startsWith("Bcc:")));
});
