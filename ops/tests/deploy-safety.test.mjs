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
    assert.equal(req.url, "/estado");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(responses[Math.min(calls++, responses.length - 1)]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const child = spawn(process.execPath, ["ops/deploy/wait-launcher.mjs"], {
    env: {
      ...process.env,
      LANZADOR_TOKEN_FILE: token,
      LANZADOR_URL: `http://127.0.0.1:${server.address().port}`,
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

test("espera las sesiones activas antes de autorizar el reinicio", async (t) => {
  const result = await runWait(t, [
    [{ estado: "trabajando" }],
    [{ estado: "terminada" }],
  ]);
  assert.equal(result.code, 0);
  assert.ok(result.calls >= 2);
});

test("no autoriza reiniciar un terminal interactivo ni al agotarse el plazo", async (t) => {
  assert.equal(
    (await runWait(t, [[{ estado: "terminada", interactiva: true }]])).code,
    1,
  );
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
      "ops/deploy/launcher-compatible.mjs",
      "ops/deploy/launcher-compatible.mjs",
      "usr/local/lib/secondbrain/launcher-compatible.mjs",
    ],
    [
      "dashboard/ops/deploy-release.sh",
      "ops/deploy/deploy-release.sh",
      "usr/local/sbin/secondbrain-deploy",
    ],
    ["ops/lanzador/sb-hilo", "ops/lanzador/sb-hilo", "usr/local/bin/sb-hilo"],
    ...[
      "secondbrain-lanzador.service",
      "claude-sb-agente.service",
      "resumen-matutino.service",
      "resumen-matutino.timer",
    ].map((unit) => [
      `ops/lanzador/${unit}`,
      `ops/lanzador/${unit}`,
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
      "ops/aviso/secondbrain-aviso@.service",
      "ops/aviso/secondbrain-aviso@.service",
      "etc/systemd/system/secondbrain-aviso@.service",
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
  await mkdir(path.join(release, "ops/lxc/plantillas"), { recursive: true });
  await mkdir(path.join(host, "etc/secondbrain"), { recursive: true });
  await writeFile(
    path.join(host, "etc/secondbrain/ops.env"),
    "PROXY_IP=192.0.2.13\nGATEWAY=192.0.2.1\nAGENTE_UID=1001\n",
  );
  for (const [template, installed] of [
    ["secondbrain.service", "etc/systemd/system/secondbrain.service"],
    ["nftables.conf", "etc/nftables.conf"],
  ]) {
    const text = await readFile(`ops/lxc/plantillas/${template}`, "utf8");
    await writeFile(path.join(release, "ops/lxc/plantillas", template), text);
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
  await writeFile(
    path.join(host, "usr/local/bin/sb-hilo"),
    "old installation\n",
  );
  const drift = await run();
  assert.equal(drift.code, 1);
  assert.match(drift.output, /\/usr\/local\/bin\/sb-hilo/);
  assert.equal(
    await readFile(path.join(host, "usr/local/bin/sb-hilo"), "utf8"),
    "old installation\n",
  );
  await copyFile(
    "ops/lanzador/sb-hilo",
    path.join(host, "usr/local/bin/sb-hilo"),
  );
  await writeFile(
    path.join(host, "usr/local/lib/secondbrain/launcher-compatible.mjs"),
    "obsolete checker\n",
  );
  const checkerDrift = await run();
  assert.equal(checkerDrift.code, 1);
  assert.match(checkerDrift.output, /launcher-compatible\.mjs/);
});
