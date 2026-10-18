import assert from "node:assert/strict";
import { test } from "node:test";
import { isFetchableUrl, isPublicAddress } from "#lib/public-fetch.js";

test("accepts ordinary public addresses", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e"]) {
    assert.ok(isPublicAddress(address), address);
  }
});

test("refuses private, loopback, link-local and metadata IPv4", () => {
  for (const address of [
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "100.64.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
  ]) {
    assert.ok(!isPublicAddress(address), address);
  }
  assert.ok(isPublicAddress("172.32.0.1"));
});

test("refuses private IPv6 and IPv6 forms that embed a private IPv4", () => {
  for (const address of [
    "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::a00:1", "2002:7f00:1::",
    "0:0:0:0:0:0:0:1", "fe80::1%eth0",
  ]) {
    assert.ok(!isPublicAddress(address), address);
  }
  assert.ok(isPublicAddress("::ffff:8.8.8.8"));
});

test("refuses anything that is not an IP address", () => {
  for (const address of ["localhost", "", "1.2.3", "1.2.3.4.5", "gggg::1"]) {
    assert.ok(!isPublicAddress(address), address);
  }
});

test("only fetches https urls and not private literal hosts", () => {
  assert.ok(isFetchableUrl(new URL("https://example.com/a.png")));
  assert.ok(isFetchableUrl(new URL("https://[2606:4700:4700::1111]/a.png")));
  assert.ok(!isFetchableUrl(new URL("http://example.com/a.png")));
  assert.ok(!isFetchableUrl(new URL("https://127.0.0.1/a.png")));
  assert.ok(!isFetchableUrl(new URL("https://[::1]/a.png")));
  assert.ok(!isFetchableUrl(new URL("https://[::ffff:10.0.0.1]/a.png")));
  assert.ok(!isFetchableUrl(new URL("https://0x7f.1/a.png")));
  assert.ok(!isFetchableUrl(new URL("https://2130706433/a.png")));
});
