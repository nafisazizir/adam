import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";

import { normalizeInboundFile } from "#lib/inbound-media.js";

// A 48x32 photo encoded by macOS as iPhone-style HEIC.
const heic = Buffer.from(
  "AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABw21ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAA4aWluZgAAAAAAAgAAABVpbmZlAgAAAAABAABodmMxAAAAABVpbmZlAgAAAQACAABFeGlmAAAAABppcmVmAAAAAAAAAA5jZHNjAAIAAQABAAAA5mlwcnAAAADFaXBjbwAAABNjb2xybmNseAACAAIABoAAAAAMY2xsaQDLAEAAAAAUaXNwZQAAAAAAAAAwAAAAIAAAAAlpcm90AAAAABBwaXhpAAAAAAMICAgAAABxaHZjQwEDcAAAALAAAAAAAB7wAPz9+PgAAAsDoAABABdAAQwB//8DcAAAAwCwAAADAAADAB5wJKEAAQAjQgEBA3AAAAMAsAAAAwAAAwAeoBQgQcHMI4h7kWVTcCAgYAiiAAEACUQBwGKLIRFNkAAAABlpcG1hAAAAAAAAAAEAAQaBAgMFhoQAAAAsaWxvYwAAAABEAAACAAEAAAABAAACRQAAAJoAAgAAAAEAAAH3AAAATgAAAAFtZGF0AAAAAAAAAPgAAAAGRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAMKADAAQAAAABAAAAIAAAAAAAAACWKAGvo/6A97prIdpLuC22wHm0wFZrl2L22N8TL3gxM+wI46XnFjoQG9nab+l8Pc+v95bBUtPOQwkGAzrLcrfp5TgjQoDFR0BJ69hDCb8A1OJj4A4g7XKuRT/QWu7uoV3KsLdR5t3ZbNgb8geItBXzE7YOghPOGNX4a3/6qSvbtWVxChUA6KvlOwwOk/Xi9ymTto5QV4f8",
  "base64",
);

async function solid(width: number, height: number, format: "png" | "jpeg") {
  const image = sharp({ create: { width, height, channels: 3, background: "#3366cc" } });
  return format === "png" ? image.png().toBuffer() : image.jpeg().toBuffer();
}

test("turns a HEIC photo into a JPEG the model can see", async () => {
  const file = await normalizeInboundFile({ bytes: heic, mediaType: "image/heic", filename: "IMG_1.HEIC" });
  assert.equal(file.mediaType, "image/jpeg");
  assert.equal(file.filename, "IMG_1.jpg");
  assert.deepEqual(await sharp(file.bytes).metadata().then(({ width, height }) => [width, height]), [48, 32]);
});

test("converts a HEIC photo that arrives without an image type", async () => {
  const file = await normalizeInboundFile({ bytes: heic, mediaType: "application/octet-stream", filename: "IMG_2.HEIC" });
  assert.equal(file.mediaType, "image/jpeg");
  assert.equal(file.filename, "IMG_2.jpg");
});

test("leaves an image the model already reads untouched", async () => {
  const bytes = await solid(800, 600, "png");
  const file = await normalizeInboundFile({ bytes, mediaType: "image/png", filename: "shot.png" });
  assert.equal(file.mediaType, "image/png");
  assert.equal(file.filename, "shot.png");
  assert.ok(file.bytes.equals(bytes));
});

test("shrinks an image too wide to be shown to the model", async () => {
  const bytes = await solid(9000, 1200, "jpeg");
  const file = await normalizeInboundFile({ bytes, mediaType: "image/jpeg", filename: "pano.jpg" });
  const { width, height } = await sharp(file.bytes).metadata();
  assert.equal(width, 2048);
  assert.equal(height, 273);
});

test("rotates a photo whose camera orientation would show it sideways", async () => {
  const bytes = await sharp(await solid(400, 200, "jpeg")).withMetadata({ orientation: 6 }).toBuffer();
  const file = await normalizeInboundFile({ bytes, mediaType: "image/jpeg", filename: "side.jpg" });
  const { width, height, orientation } = await sharp(file.bytes).metadata();
  assert.deepEqual([width, height, orientation ?? 1], [200, 400, 1]);
});

test("passes files that are not images through", async () => {
  const bytes = Buffer.from("%PDF-1.4 hello");
  const file = await normalizeInboundFile({ bytes, mediaType: "application/pdf", filename: "a.pdf" });
  assert.equal(file.bytes, bytes);
});

test("tells the model an image could not be opened", async () => {
  await assert.rejects(
    normalizeInboundFile({ bytes: Buffer.from("not an image"), mediaType: "image/heic", filename: "x.HEIC" }),
    /could not be decoded/u,
  );
});
