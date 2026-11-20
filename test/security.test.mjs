import test from "node:test";
import assert from "node:assert/strict";
import { createApiGuard, safeEqual } from "../security.js";
import { isAbsoluteUrl, resolveDownloadUrl, validatePublishBody } from "../updates.js";

const silent = { warn() {} };

// Minimal Express-like req/res doubles
function run(guard, { path, method = "GET", key }) {
  const req = { path, method, get: (h) => (h.toLowerCase() === "x-api-key" ? key : undefined) };
  const out = { nextCalled: false, status: null, body: null };
  const res = {
    status(code) { out.status = code; return this; },
    json(b) { out.body = b; return this; },
  };
  guard.http(req, res, () => { out.nextCalled = true; });
  return out;
}
function runSocket(guard, auth) {
  let err = null, called = false;
  guard.socket({ handshake: { auth } }, (e) => { called = true; err = e ?? null; });
  return { called, err };
}

test("safeEqual: equal, different, different length, undefined", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual(undefined, "abc"), false);
  assert.equal(safeEqual(undefined, undefined), true); // both empty; callers never pass an empty apiKey (mode "off")
});

test("mode is derived from the environment", () => {
  assert.equal(createApiGuard({ apiKey: "", logger: silent }).mode, "off");
  assert.equal(createApiGuard({ apiKey: undefined, enforce: true, logger: silent }).mode, "off");
  assert.equal(createApiGuard({ apiKey: "k", logger: silent }).mode, "report");
  assert.equal(createApiGuard({ apiKey: "k", enforce: true, logger: silent }).mode, "enforce");
});

test("off: everything is open (behaves like the server did before)", () => {
  const g = createApiGuard({ apiKey: "", logger: silent });
  assert.equal(run(g, { path: "/api/messages" }).nextCalled, true);
  assert.equal(runSocket(g, undefined).err, null);
});

test("report: keyless requests pass but are logged once per route per 10 minutes", () => {
  const logged = [];
  let t = 1_000_000;
  const g = createApiGuard({ apiKey: "k", logger: { warn: (m) => logged.push(m) }, now: () => t });
  assert.equal(run(g, { path: "/api/messages" }).nextCalled, true);
  assert.equal(run(g, { path: "/api/messages" }).nextCalled, true);
  assert.equal(logged.length, 1, "second hit inside 10 min is not logged again");
  assert.match(logged[0], /GET \/api\/messages/);
  assert.doesNotMatch(logged[0], /\bk\b.*key=/, "never logs the key");
  t += 11 * 60 * 1000;
  run(g, { path: "/api/messages" });
  assert.equal(logged.length, 2);
  run(g, { path: "/api/messages", key: "k" });          // valid key: not reported
  assert.equal(logged.length, 2);
});

test("enforce: missing or wrong key -> 401, correct key -> allowed", () => {
  const g = createApiGuard({ apiKey: "secret-key", enforce: true, logger: silent });
  const none = run(g, { path: "/api/messages" });
  assert.equal(none.status, 401); assert.equal(none.nextCalled, false);
  const wrong = run(g, { path: "/api/messages", key: "nope" });
  assert.equal(wrong.status, 401);
  const ok = run(g, { path: "/api/messages", key: "secret-key" });
  assert.equal(ok.nextCalled, true); assert.equal(ok.status, null);
});

test("enforce: health, landing page and admin routes are not gated by the app key", () => {
  const g = createApiGuard({ apiKey: "secret-key", enforce: true, logger: silent });
  for (const path of ["/", "/health", "/api/admin/publish-update"]) {
    assert.equal(run(g, { path }).nextCalled, true, path);
  }
});

test("enforce: update check and every data route need the key", () => {
  const g = createApiGuard({ apiKey: "secret-key", enforce: true, logger: silent });
  for (const path of ["/update/version.json", "/api/media", "/api/messages/search", "/getSignedUrl",
                      "/api/thumbnail", "/api/batch-signed-urls", "/getUploadAuth", "/saveFCMToken"]) {
    assert.equal(run(g, { path }).status, 401, path);
    assert.equal(run(g, { path, key: "secret-key" }).nextCalled, true, path);
  }
});

test("a path that merely starts like an open one is still gated", () => {
  const g = createApiGuard({ apiKey: "k", enforce: true, logger: silent });
  assert.equal(run(g, { path: "/health/../api/messages" }).status, 401);
  assert.equal(run(g, { path: "/api/administrator" }).status, 401);
});

test("socket handshake: enforce rejects keyless, accepts correct key; report allows", () => {
  const enforce = createApiGuard({ apiKey: "k", enforce: true, logger: silent });
  assert.ok(runSocket(enforce, undefined).err instanceof Error);
  assert.ok(runSocket(enforce, { key: "wrong" }).err instanceof Error);
  assert.equal(runSocket(enforce, { key: "k" }).err, null);
  const report = createApiGuard({ apiKey: "k", logger: silent });
  assert.equal(runSocket(report, {}).err, null);
});

test("isAbsoluteUrl", () => {
  assert.equal(isAbsoluteUrl("https://x.y/z.apk"), true);
  assert.equal(isAbsoluteUrl("HTTP://x"), true);
  assert.equal(isAbsoluteUrl("updates/app-v23.apk"), false);
  assert.equal(isAbsoluteUrl(""), false);
  assert.equal(isAbsoluteUrl(undefined), false);
});

test("resolveDownloadUrl: URL kept, B2 name signed fresh each time, empty stays empty", async () => {
  let n = 0;
  const sign = async (name) => `https://signed/${name}?token=${++n}`;
  assert.equal(await resolveDownloadUrl("https://host/app.apk", sign), "https://host/app.apk");
  assert.equal(await resolveDownloadUrl("updates/a.apk", sign), "https://signed/updates/a.apk?token=1");
  assert.equal(await resolveDownloadUrl("updates/a.apk", sign), "https://signed/updates/a.apk?token=2");
  assert.equal(await resolveDownloadUrl("", sign), "");
});

test("validatePublishBody", () => {
  const good = validatePublishBody({ versionCode: "23", downloadUrl: "updates/v23.apk", sha256: "A".repeat(64) });
  assert.equal(good.value.versionCode, 23);
  assert.equal(good.value.sha256, "a".repeat(64), "lower-cased");
  assert.ok(validatePublishBody({ versionCode: 23, downloadUrl: "https://x/y.apk" }).value);
  assert.ok(validatePublishBody({ versionCode: 0, downloadUrl: "updates/a.apk" }).error);
  assert.ok(validatePublishBody({ versionCode: 1.5, downloadUrl: "updates/a.apk" }).error);
  assert.ok(validatePublishBody({ versionCode: "abc", downloadUrl: "updates/a.apk" }).error);
  assert.ok(validatePublishBody({ versionCode: 5, downloadUrl: "" }).error);
  assert.ok(validatePublishBody({ versionCode: 5, downloadUrl: "../etc/passwd" }).error);
  assert.ok(validatePublishBody({ versionCode: 5, downloadUrl: "/abs/path.apk" }).error);
  assert.ok(validatePublishBody({ versionCode: 5, downloadUrl: "updates/a.apk", sha256: "xyz" }).error);
});
