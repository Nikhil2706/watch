import { test } from "node:test";
import assert from "node:assert/strict";

import { HELLO_PATH, homeLocation, isHomeHost, relaxCookie } from "./home-door-rules.mjs";

test("cookies lose Secure and keep everything else", () => {
  assert.equal(
    relaxCookie("jfg_session=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=100; Secure"),
    "jfg_session=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=100",
  );
  assert.equal(relaxCookie("a=b; secure; Path=/"), "a=b; Path=/");
  // A cookie value that merely contains the word is left alone.
  assert.equal(relaxCookie("note=secure-ish; Path=/"), "note=secure-ish; Path=/");
});

test("redirects to the public site come home; others are left alone", () => {
  const pub = "https://watch.example.com";
  const door = "http://192.168.1.17:3080";
  assert.equal(homeLocation("https://watch.example.com/login?next=%2F", pub, door), "http://192.168.1.17:3080/login?next=%2F");
  assert.equal(homeLocation("https://watch.example.com", pub, door), "http://192.168.1.17:3080/");
  assert.equal(homeLocation("/profiles", pub, door), "/profiles");
  assert.equal(homeLocation("https://watch.example.com.evil.test/x", pub, door), "https://watch.example.com.evil.test/x");
  assert.equal(homeLocation("https://github.com/x", pub, door), "https://github.com/x");
});

test("only home-network hosts are let in", () => {
  for (const h of ["192.168.1.17:3080", "10.0.0.5", "172.16.3.4:3080", "172.31.0.1", "127.0.0.1:3080", "localhost:3080", "nikhils-mac-mini.local:3080"]) {
    assert.equal(isHomeHost(h), true, h);
  }
  for (const h of ["watch.example.com", "8.8.8.8", "172.32.0.1", "192.169.1.1", "999.168.1.1", "", undefined, "192.168.1.17.evil.test"]) {
    assert.equal(isHomeHost(h), false, String(h));
  }
});

test("the hello path is fixed", () => {
  assert.equal(HELLO_PATH, "/__watch-home");
});
