import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  cp,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const bash =
  process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-bootstrap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const release = path.join(dir, "release");
  const root = path.join(dir, "root");
  await mkdir(root);
  // The release keeps the repository's ops/launcher as ops/lanzador.
  for (const [sub, out] of [
    ["launcher", "lanzador"],
    ["backup", "backup"],
    ["aviso", "aviso"],
    ["deploy", "deploy"],
    ["lxc/plantillas", "lxc/plantillas"],
  ])
    await cp("ops/" + sub, path.join(release, "ops", out), { recursive: true });
  for (const [source, destination] of [
    ["dashboard/ops/deploy-release.sh", "deploy-release.sh"],
    ["ops/secondbrain-vault-push.service", "secondbrain-vault-push.service"],
    ["ops/secondbrain-vault-push.timer", "secondbrain-vault-push.timer"],
  ])
    await cp(source, path.join(release, "ops/deploy", destination));
  await mkdir(path.join(release, "ops/homelab"), { recursive: true });
  for (const file of ["prender-pc", "estado-pc"])
    await writeFile(path.join(release, "ops/homelab", file), "synthetic\n");
  const config = path.join(dir, "parameters.json");
  await writeFile(
    config,
    JSON.stringify({
      proxy: "192.0.2.13",
      gateway: "192.0.2.1",
      agentUid: 1001,
      pc: "192.0.2.44",
      mac: "00:00:5e:00:53:01",
      broadcast: "192.0.2.255",
      remoteWorkdir: "/srv/sb-agente/proyectos/SecondBrain",
    }),
  );
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [
        "ops/deploy/configure.mjs",
        "--release",
        release,
        "--root",
        root,
        "--parameters",
        config,
        ...args,
      ],
      { encoding: "utf8" },
    );
  return { dir, release, root, config, run };
}

test("a clean install includes the deployment helper and an executable morning command", async (t) => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const helper = path.join(f.root, "usr/local/sbin/secondbrain-deploy");
  assert.ok((await stat(helper)).isFile());
  const unit = await readFile(
    path.join(f.root, "etc/systemd/system/resumen-matutino.service"),
    "utf8",
  );
  const command = unit.match(/^ExecStart=(.*)$/m)[1];
  const script = path.join(f.dir, "morning.sh");
  await writeFile(script, "printf MORNING_OK\n", { mode: 0o644 });
  // Consume the actual unit command with a harmless 0644 fixture as its script.
  const parsed = command.split(/\s+/);
  const explicitInterpreter = parsed[0] === "/bin/bash";
  const observed = explicitInterpreter
    ? spawnSync(bash, [script.replaceAll("\\", "/")], { encoding: "utf8" })
    : spawnSync(script, [], { encoding: "utf8" });
  assert.equal(observed.status, 0, observed.error?.message || observed.stderr);
  assert.equal(observed.stdout, "MORNING_OK");
  assert.equal(f.run("--check").status, 0);
});

test("configuration checks ignore reordered systemd keys but reject a functional change", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  const file = path.join(f.root, "etc/systemd/system/secondbrain.service");
  let text = await readFile(file, "utf8");
  const line = text.match(/^OnFailure=.*$/m)[0];
  text = text
    .replace(line + "\n", "")
    .replace("[Unit]\n", "[Unit]\n" + line + "\n");
  await writeFile(file, text);
  assert.equal(f.run("--check").status, 0);
  await writeFile(file, text.replace("PORT=8080", "PORT=9999"));
  assert.equal(f.run("--check").status, 1);
  assert.equal(
    await readFile(file, "utf8"),
    text.replace("PORT=8080", "PORT=9999"),
  );
});

test("invalid administrative parameters fail before creating system configuration", async (t) => {
  const f = await fixture(t);
  const config = JSON.parse(await readFile(f.config, "utf8"));
  config.agentUid = "997;echo bad";
  await writeFile(f.config, JSON.stringify(config));
  assert.equal(f.run().status, 2);
  await assert.rejects(stat(path.join(f.root, "etc")), { code: "ENOENT" });
});

test("the English layout renames units but installs the deploy helper verbatim", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "etc/secondbrain"), { recursive: true });
  await writeFile(path.join(f.root, "etc/secondbrain/english-layout"), "1\n");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(
      path.join(f.root, "usr/local/sbin/secondbrain-deploy"),
      "utf8",
    ),
    await readFile("dashboard/ops/deploy-release.sh", "utf8"),
  );
  assert.ok(
    (
      await stat(
        path.join(f.root, "etc/systemd/system/secondbrain-launcher.service"),
      )
    ).isFile(),
  );
  const check = f.run("--check");
  assert.equal(check.status, 0, check.stderr);
});
