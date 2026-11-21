import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
const image = process.env.SB_SMOKE_IMAGE || "second-brain:0.5.2";
const temporary = mkdtempSync(path.join(tmpdir(), "sb-container-"));
const root = path.join(temporary, "vault");
const data = path.join(temporary, "data");
mkdirSync(root);
mkdirSync(data);
mkdirSync(path.join(root, "00-Inbox"));
writeFileSync(path.join(root, "Home.md"), "# Home\n");
writeFileSync(
  path.join(root, "00-Inbox/Original.md"),
  "# Desde Obsidian\nTexto original.\n",
);
function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
const gateway = docker([
  "network",
  "inspect",
  "bridge",
  "--format",
  "{{(index .IPAM.Config 0).Gateway}}",
]);
const name = "sb-vault-smoke-" + randomUUID().slice(0, 8);
const jar = new Map();
let base;
async function request(route, method = "GET", body, expected = 200) {
  let token;
  if (method !== "GET") token = (await request("/api/v1/auth/csrf")).token;
  const response = await fetch(base + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-Proto": "https",
      Cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
      ...(token ? { "X-CSRF-TOKEN": token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const raw of response.headers.getSetCookie()) {
    assert.match(raw, /HttpOnly/);
    assert.match(raw, /Secure/);
    const first = raw.split(";")[0];
    const pos = first.indexOf("=");
    jar.set(first.slice(0, pos), first.slice(pos + 1));
  }
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}
try {
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "second-brain.test=true",
    // Run as the owner of the bind mounts, as the Quadlet unit does in production.
    ...(process.getuid
      ? ["--user", process.getuid() + ":" + process.getgid()]
      : []),
    "-e",
    "TRUSTED_PROXY=" + gateway,
    "-p",
    "127.0.0.1::8080",
    "--mount",
    `type=bind,src=${root},dst=/vault`,
    "--mount",
    `type=bind,src=${data},dst=/data`,
    image,
  ]);
  base = "http://127.0.0.1:" + docker(["port", name, "8080"]).split(":").pop();
  let ready = false;
  for (let i = 0; i < 300; i++) {
    try {
      const response = await fetch(base + "/api/v1/health");
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) {
    const logs = spawnSync("docker", ["logs", name], { encoding: "utf8" });
    console.error(logs.stdout + logs.stderr);
  }
  assert.ok(ready, "container readiness");
  assert.equal(
    (await fetch(base + "/api/v1/auth/csrf")).status,
    400,
    "plain HTTP cannot start a production session",
  );
  assert.match(await request("/"), /Second Brain/);
  const password = "container-test-password";
  await request("/api/v1/auth/setup", "POST", { username: "owner", password });
  const before = await request("/api/v1/items");
  assert.ok(before.some((i) => i.title === "Desde Obsidian"));
  const id = randomUUID();
  await request("/api/v1/mutations", "POST", {
    mutationId: randomUUID(),
    baseVersion: 0,
    entity: {
      id,
      kind: "task",
      title: "Escrita desde Node",
      version: 0,
      status: "pending",
    },
  });
  const tasks = readFileSync(
    path.join(root, "00-Inbox/Tareas/_Tareas.md"),
    "utf8",
  );
  assert.match(tasks, /- \[ \] Escrita desde Node/);
  writeFileSync(
    path.join(root, "00-Inbox/Original.md"),
    "# Editada en Obsidian\nActualizado fuera de la app.\n",
  );
  // The item list omits note bodies; the new title proves the index re-read it.
  assert.ok(
    (await request("/api/v1/items")).some(
      (i) => i.title === "Editada en Obsidian",
    ),
  );
  assert.match(
    (await request("/api/v1/vault/note?path=00-Inbox/Original.md")).content,
    /Actualizado fuera/,
  );
  const response = await fetch(base + "/api/v1/export", {
    headers: {
      Cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
      "X-Forwarded-Proto": "https",
    },
  });
  assert.equal(response.status, 200);
  const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
  assert.equal(
    strFromU8(archive["00-Inbox/Original.md"]),
    readFileSync(path.join(root, "00-Inbox/Original.md"), "utf8"),
  );
  assert.ok(archive["second-brain-vault.json"]);
  console.log(
    "PASS container: production startup, HTTPS proxy trust, auth/CSRF, shared vault writes, external edits, original-file export and static PWA.",
  );
  console.log(
    "Image bytes: " +
      docker(["image", "inspect", image, "--format", "{{.Size}}"]),
  );
} finally {
  try {
    docker(["rm", "-f", name]);
  } catch {}
  rmSync(temporary, { recursive: true, force: true });
}
