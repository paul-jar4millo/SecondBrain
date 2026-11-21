import test from "node:test";
import assert from "node:assert/strict";
import { renderContainer } from "../deploy/render-container.mjs";

const repository = "ghcr.io/example/secondbrain";
const image = repository + "@sha256:" + "c".repeat(64);
const settings = { image, repository, proxy: "192.0.2.1", uid: 999, gid: 991 };

test("pins the container digest and keeps the service identity and launcher loopback", () => {
  const unit = renderContainer(settings);
  assert.ok(unit.includes("Image=" + image + "\n"));
  assert.match(unit, /Network=host\nUser=999:991\nReadOnly=true/);
  assert.match(unit, /LAUNCHER_URL=http:\/\/127\.0\.0\.1:8092/);
  assert.match(unit, /\/var\/lib\/secondbrain:\/var\/lib\/secondbrain:rw/);
});

test("rejects mutable tags, cross-repository digests and invalid host parameters", () => {
  assert.throws(
    () => renderContainer({ ...settings, image: repository + ":latest" }),
    /digest/,
  );
  assert.throws(
    () =>
      renderContainer({ ...settings, repository: "ghcr.io/other/secondbrain" }),
    /digest/,
  );
  assert.throws(
    () => renderContainer({ ...settings, proxy: "10.1.1.1\nVolume=/" }),
    /proxy/,
  );
  assert.throws(() => renderContainer({ ...settings, uid: 0 }), /identity/);
});
