import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

async function runWait(t, responses) {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-deploy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const token = path.join(dir, "token");
  await writeFile(token, "synthetic-control");
  let calls = 0;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer synthetic-control");
    assert.equal(
      req.url,
      "/threads?status=setting-up,running,waiting-user,closing",
    );
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(responses[Math.min(calls++, responses.length - 1)]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const child = spawn(process.execPath, ["ops/deploy/wait-launcher.mjs"], {
    env: {
      ...process.env,
      SB_LAUNCHER_TOKEN_FILE: token,
      SB_LAUNCHER_URL: `http://127.0.0.1:${server.address().port}`,
      SB_DEPLOY_WAIT_MS: "1000",
      SB_DEPLOY_POLL_MS: "10",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.ok(!output.includes("synthetic-control"));
  return { code, calls };
}

test("waits for busy threads before allowing the restart", async (t) => {
  const result = await runWait(t, [
    { threads: [{ id: "thr_a", status: "running" }], globalSeq: 1 },
    { threads: [], globalSeq: 2 },
  ]);
  assert.equal(result.code, 0);
  assert.ok(result.calls >= 2);
});

test("never allows the restart once the wait runs out", async (t) => {
  assert.equal(
    (await runWait(t, [{ threads: [{ id: "thr_a" }], globalSeq: 1 }])).code,
    1,
  );
});

// A9 changed /estado to {ok:true}; the old check read it as "sessions busy"
// forever and every deploy pinned the previous launcher.
test("the launcher health answer is not a list of threads", async (t) => {
  assert.equal((await runWait(t, [{ ok: true }])).code, 1);
});

test("una respuesta inválida nunca equivale a cero sesiones", async (t) => {
  assert.equal((await runWait(t, [{ error: "fallo" }])).code, 1);
});

test("informa deriva de un archivo instalado sin modificarlo", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-drift-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const release = path.join(dir, "release");
  const host = path.join(dir, "host");
  const files = [
    [
      "dashboard/ops/deploy-release.sh",
      "ops/deploy/deploy-release.sh",
      "usr/local/sbin/secondbrain-deploy",
    ],
    ...[
      "secondbrain-launcher.service",
      "claude-sb-agente.service",
      "morning-summary.service",
      "morning-summary.timer",
    ].map((unit) => [
      `ops/launcher/${unit}`,
      `ops/launcher/${unit}`,
      `etc/systemd/system/${unit}`,
    ]),
    ...["secondbrain-vault-push.service", "secondbrain-vault-push.timer"].map(
      (unit) => [
        `ops/${unit}`,
        `ops/deploy/${unit}`,
        `etc/systemd/system/${unit}`,
      ],
    ),
    ...["secondbrain-backup.service", "secondbrain-backup.timer"].map(
      (unit) => [
        `ops/backup/${unit}`,
        `ops/backup/${unit}`,
        `etc/systemd/system/${unit}`,
      ],
    ),
    [
      "ops/notify/secondbrain-notify@.service",
      "ops/notify/secondbrain-notify@.service",
      "etc/systemd/system/secondbrain-notify@.service",
    ],
  ];
  for (const [source, packaged, installed] of files) {
    for (const destination of [
      path.join(release, packaged),
      path.join(host, installed),
    ]) {
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
  }
  await mkdir(path.join(release, "ops/lxc/templates"), { recursive: true });
  await mkdir(path.join(host, "etc/secondbrain"), { recursive: true });
  await writeFile(
    path.join(host, "etc/secondbrain/ops.env"),
    "PROXY_IP=192.0.2.13\nGATEWAY=192.0.2.1\nAGENTE_UID=1001\n",
  );
  for (const [template, installed] of [
    ["secondbrain.service", "etc/systemd/system/secondbrain.service"],
    ["nftables.conf", "etc/nftables.conf"],
  ]) {
    const text = await readFile(`ops/lxc/templates/${template}`, "utf8");
    await writeFile(path.join(release, "ops/lxc/templates", template), text);
    await writeFile(
      path.join(host, installed),
      text
        .replaceAll("@PROXY_IP@", "192.0.2.13")
        .replaceAll("@GATEWAY@", "192.0.2.1")
        .replaceAll("@UID@", "1001"),
    );
  }
  const run = async () => {
    const child = spawn(
      process.platform === "win32"
        ? "C:/Program Files/Git/bin/bash.exe"
        : "bash",
      ["ops/deploy/check-drift.sh", release, host],
    );
    let output = "";
    child.stderr.on("data", (data) => {
      output += data;
    });
    const code = await new Promise((resolve) => child.on("close", resolve));
    return { code, output };
  };
  assert.equal((await run()).code, 0);
  const unit = path.join(host, "etc/systemd/system/morning-summary.timer");
  const installed = await readFile(unit, "utf8");
  await writeFile(unit, "old installation\n");
  const drift = await run();
  assert.equal(drift.code, 1);
  assert.match(drift.output, /morning-summary\.timer/);
  assert.equal(await readFile(unit, "utf8"), "old installation\n");
  await writeFile(unit, installed);
  assert.equal((await run()).code, 0);
});
