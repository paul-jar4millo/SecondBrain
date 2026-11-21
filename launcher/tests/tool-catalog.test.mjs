import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  buildMcpConfigForProfile,
  CATALOG_STATES,
  createToolCatalogStore,
  INHERITED_DESKTOP_CONNECTORS,
  narrowChildProfile,
  PRODUCT_SKILLS_SPEC,
  TOOL_PROFILES_BASE,
} from "../tool-catalog.mjs";
import { createLauncherServer } from "../index.mjs";
import { createApplication } from "../../service/index.mjs";

test("A/E: catálogo separa 6 estados sin inferencias falsas, respeta freshness TTL y bloquea DeepSeek sin concesión de gasto", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-cat-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const emptyTokenFile = path.join(dir, "empty-token");
  await writeFile(emptyTokenFile, "   \n", "utf8");
  let nowMs = Date.parse("2026-11-17T12:00:00.000Z");

  const unprobedStore = await createToolCatalogStore({
    dataDir: path.join(dir, "unprobed"),
    env: {
      AGENTES_BRAIN_TOKEN_FILE: emptyTokenFile,
      AGENTES_BRAIN_URL: "http://127.0.0.1:8080/api/v1",
      CODEX_HOME: path.join(dir, "codex-home"),
    },
    freshnessTtlMs: 10_000,
    clock: () => new Date(nowMs).toISOString(),
  });

  // Never assumes conectada/probada from tokenFile path, CODEX_HOME, or unverified runtimeProbes.billingAuthorized
  const evalUnprobed = unprobedStore.evaluateCatalog({
    motor: "codex",
    profileId: "ejecucion",
    memberId: "menta-1",
    sessionId: "sess-1",
    billingAuthorized: true,
    runtimeProbes: { billingAuthorized: true },
  });

  for (const item of evalUnprobed.items) {
    for (const key of CATALOG_STATES) {
      assert.equal(typeof item.states[key], "boolean");
    }
    assert.ok(item.version && item.origin && item.license);
    assert.ok(Array.isArray(item.transports) && Array.isArray(item.operations));
    assert.ok(item.costPolicy && item.healthCheck && item.lastCheckedAt);
    assert.ok(item.evidence && typeof item.evidence === "object");
    assert.equal(item.evidence.identity.memberId, "menta-1");
    assert.equal(item.evidence.identity.sessionId, "sess-1");
  }

  const claude = evalUnprobed.engines.find((e) => e.id === "claude");
  assert.equal(claude.states.conectada, false);
  assert.equal(claude.usable, false);
  assert.match(
    claude.causaNoDisponible,
    /Claude sin sesión autenticada verificada/,
  );

  const deepseekSpoof = evalUnprobed.engines.find((e) => e.id === "deepseek");
  assert.equal(deepseekSpoof.costPolicy, "api_facturada_bloqueada_r14");
  assert.equal(deepseekSpoof.states.permitida, false);
  assert.equal(deepseekSpoof.usable, false);
  assert.match(deepseekSpoof.causaNoDisponible, /gasto/);

  const sbUnconfigured = evalUnprobed.connectors.find(
    (c) => c.id === "secondbrain",
  );
  assert.equal(sbUnconfigured.states.configurada, false);
  assert.equal(sbUnconfigured.states.conectada, false);
  assert.equal(sbUnconfigured.states.probada, false);
  assert.equal(sbUnconfigured.usable, false);

  const codexUnprobed = evalUnprobed.engines.find((e) => e.id === "codex");
  assert.equal(codexUnprobed.states.conectada, false);
  assert.equal(codexUnprobed.states.probada, false);
  assert.equal(codexUnprobed.usable, false);

  // Opt-in health checks are disabled unless optIn: true
  const skippedCheck = await unprobedStore.runHealthChecks({ optIn: false });
  assert.equal(skippedCheck.executed, false);

  // Real local HTTP health check + valid token promotes secondbrain with verified evidence until TTL expires
  const tokenFile = path.join(dir, "valid-brain-token");
  await writeFile(tokenFile, "sbcap_test_probe_token", "utf8");
  const server = http.createServer((req, res) => {
    if (req.url === "/api/v1/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (
      req.url === "/api/v1/vault/files" &&
      req.headers.authorization === "Bearer sbcap_test_probe_token"
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ items: [] }));
    }
    res.writeHead(403).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const probedStore = await createToolCatalogStore({
    dataDir: path.join(dir, "probed"),
    env: {
      SB_BRAIN_TOKEN_FILE: tokenFile,
      SB_BRAIN_URL: `http://127.0.0.1:${server.address().port}/api/v1`,
    },
    probes: {
      codex: {
        instalada: true,
        configurada: true,
        conectada: true,
        probada: true,
        verifiedAt: new Date(nowMs).toISOString(),
        evidenceSource: "runtime_verified_probe",
      },
    },
    freshnessTtlMs: 10_000,
    clock: () => new Date(nowMs).toISOString(),
  });

  // Before running opt-in check, secondbrain is configurada=true but NOT conectada/probada
  const beforeProbe = probedStore.evaluateCatalog({ motor: "codex" });
  const sbBefore = beforeProbe.connectors.find((c) => c.id === "secondbrain");
  assert.equal(sbBefore.states.configurada, true);
  assert.equal(sbBefore.states.conectada, false);
  assert.equal(sbBefore.states.probada, false);
  assert.equal(sbBefore.usable, false);

  const probeRes = await probedStore.runHealthChecks({
    optIn: true,
    targets: ["secondbrain"],
  });
  assert.equal(probeRes.executed, true);
  assert.equal(probeRes.results.secondbrain.probada, true);

  const afterProbe = probedStore.evaluateCatalog({ motor: "codex" });
  const sbAfter = afterProbe.connectors.find((c) => c.id === "secondbrain");
  assert.equal(sbAfter.states.conectada, true);
  assert.equal(sbAfter.states.probada, true);
  assert.equal(sbAfter.evidence.fresh, true);
  assert.equal(sbAfter.evidence.source, "opt_in_healthcheck");
  assert.equal(sbAfter.usable, true);

  // Advance clock past freshnessTtlMs -> evidence becomes stale -> usable=false
  nowMs += 20_000;
  const expiredEval = probedStore.evaluateCatalog({ motor: "codex" });
  const sbExpired = expiredEval.connectors.find((c) => c.id === "secondbrain");
  assert.equal(sbExpired.evidence.fresh, false);
  assert.equal(sbExpired.usable, false);
  assert.match(sbExpired.causaNoDisponible, /vencid|expirad|fresh/i);

  // Operator verified grant unlocks DeepSeek evaluation
  const deepseekGranted = probedStore
    .evaluateCatalog({
      motor: "deepseek",
      verifiedOperatorBillingGrant: true,
    })
    .engines.find((e) => e.id === "deepseek");
  assert.equal(deepseekGranted.states.permitida, true);
});

test("B/D: perfiles, aislamiento MCP, SHA-256 reales de 7 SKILL.md, bloqueo sin prueba, fase F3/F5/F7 y materialización selectiva", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-prof-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const validToken = path.join(dir, "token");
  await writeFile(validToken, "sbcap_valid_token", "utf8");
  const server = http.createServer((req, res) => {
    if (req.url === "/api/v1/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"ok":true}');
    }
    if (req.url === "/api/v1/vault/files") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"items":[]}');
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const store = await createToolCatalogStore({
    dataDir: path.join(dir, "catalog-data"),
    env: {
      SB_BRAIN_TOKEN_FILE: validToken,
      SB_BRAIN_URL: `http://127.0.0.1:${server.address().port}/api/v1`,
    },
  });

  assert.equal(store.getProfiles().length, 4);

  // Child profile MUST stay narrowed inside parent's bounds
  const narrowed = narrowChildProfile(
    TOOL_PROFILES_BASE.investigacion,
    TOOL_PROFILES_BASE.coordinacion,
  );
  assert.equal(narrowed.allowedEffectCategories.length, 0);
  assert.ok(!narrowed.allowedOperations.includes("vault.write"));
  assert.equal(narrowed.allowExternalWriteSecrets, false);

  // MCP generation isolates profile servers and disables desktop inherited connectors
  const mcpCfg = buildMcpConfigForProfile({
    profile: TOOL_PROFILES_BASE.investigacion,
    env: {
      SB_BRAIN_TOKEN_FILE: validToken,
      SB_BRAIN_URL: `http://127.0.0.1:${server.address().port}/api/v1`,
    },
    memberId: "lira",
    sessionId: "s-mcp-1",
    extraServers: {
      blender: { command: "blender-mcp", args: [] }, // must NOT be included
      web_search: { command: "search-mcp", args: [] }, // allowed by investigacion
    },
  });
  assert.ok(mcpCfg.mcpServers.secondbrain);
  assert.ok(mcpCfg.mcpServers.web_search);
  assert.equal(mcpCfg.mcpServers.blender, undefined);
  assert.equal(mcpCfg.envOverrides.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  for (const name of INHERITED_DESKTOP_CONNECTORS) {
    assert.ok(!Object.hasOwn(mcpCfg.mcpServers, name));
  }

  // Without running opt-in healthcheck, even configured secondbrain keeps personal-context "no_utilizable"
  const skillBeforeProbe = await store.resolveSkillsForTask({
    motor: "agy",
    profileId: "investigacion",
    skillIds: [
      "opportunity-research",
      "personal-context",
      "team-coordinator",
      "provider-handoff",
      "routine-operator",
    ],
  });
  const oppBefore = skillBeforeProbe.skills.find(
    (s) => s.id === "opportunity-research",
  );
  const ctxBefore = skillBeforeProbe.skills.find(
    (s) => s.id === "personal-context",
  );
  assert.equal(oppBefore.estado, "no_utilizable");
  assert.match(oppBefore.causaNoDisponible, /web_search/);
  assert.equal(ctxBefore.estado, "no_utilizable");
  assert.equal(ctxBefore.usable, false);

  // F3 / F5 / F7 future skills MUST stay "pendiente_fase"
  for (const gatedId of [
    "team-coordinator",
    "provider-handoff",
    "routine-operator",
  ]) {
    const gated = skillBeforeProbe.skills.find((s) => s.id === gatedId);
    assert.equal(gated.estado, "pendiente_fase");
    assert.equal(gated.usable, false);
  }

  // Verify real SHA-256 of ALL 7 implemented product SKILL.md files + preserved legacy .md files
  const repoSkillsDir = fileURLToPath(new URL("../skills", import.meta.url));
  for (const spec of PRODUCT_SKILLS_SPEC.filter(
    (s) => s.implemented !== false,
  )) {
    const abs = path.join(repoSkillsDir, spec.file);
    const bytes = await readFile(abs);
    const expectedSha = createHash("sha256").update(bytes).digest("hex");
    const found = (
      await store.resolveSkillsForTask({
        motor: "agy",
        profileId: "ejecucion",
        skillIds: [spec.id],
      })
    ).skills[0];
    assert.equal(found.fileExists, true, `${spec.id} should exist`);
    assert.equal(found.sha256, expectedSha, `${spec.id} sha256 mismatch`);
  }
  await access(path.join(repoSkillsDir, "resumen-matutino.md"));

  // Opt-in healthcheck makes personal-context usable and selectively materializes ONLY requested skill
  await store.runHealthChecks({ optIn: true, targets: ["secondbrain"] });
  const geminiDir = path.join(dir, "agy-gemini");
  const mat = await store.materializeSkillsForSession({
    motor: "agy",
    profileId: "investigacion",
    skillIds: ["personal-context"],
    geminiDir,
  });
  assert.equal(mat.materialized.length, 1);
  assert.equal(mat.materialized[0].id, "personal-context");
  const matBytes = await readFile(
    path.join(geminiDir, "skills", "personal-context", "SKILL.md"),
  );
  assert.equal(
    createHash("sha256").update(matBytes).digest("hex"),
    mat.materialized[0].sha256,
  );
  // Other skills must NOT be copied into the isolated session dir
  await assert.rejects(
    access(path.join(geminiDir, "skills", "document-production", "SKILL.md")),
  );
  await mat.cleanup();
  await assert.rejects(
    access(path.join(geminiDir, "skills", "personal-context", "SKILL.md")),
  );

  // Materializing a skill without required profile permission (file.write not in investigacion) fails closed
  await assert.rejects(
    () =>
      store.materializeSkillsForSession({
        motor: "agy",
        profileId: "investigacion",
        skillIds: ["document-production"],
        geminiDir,
      }),
    /no utilizable/,
  );

  // Missing or broken frontmatter/annex SKILL.md fails verification
  const brokenSkillsDir = path.join(dir, "broken-skills");
  await mkdir(path.join(brokenSkillsDir, "personal-context"), {
    recursive: true,
  });
  await writeFile(
    path.join(brokenSkillsDir, "personal-context", "SKILL.md"),
    "# sin frontmatter\n",
    "utf8",
  );
  const brokenStore = await createToolCatalogStore({
    dataDir: path.join(dir, "broken-data"),
    skillsDir: brokenSkillsDir,
    env: { SB_BRAIN_TOKEN_FILE: validToken },
  });
  const brokenRes = await brokenStore.resolveSkillsForTask({
    skillIds: ["personal-context"],
  });
  assert.equal(brokenRes.skills[0].usable, false);
  assert.match(brokenRes.skills[0].causaNoDisponible, /Frontmatter/i);

  // Provenance tracking rejects unverified stages/hashes/evidence and unsupported "cargada"
  assert.throws(() =>
    store.recordSkillProvenance([], {
      skillId: "personal-context",
      stage: "cargada",
      sha256: mat.materialized[0].sha256,
    }),
  );
  assert.throws(() =>
    store.recordSkillProvenance([], {
      skillId: "personal-context",
      stage: "cargada_observada",
      sha256: "not-a-sha",
      evidence: { source: "acp", verifiedAt: "2026-11-17T00:00:00.000Z" },
    }),
  );
  assert.throws(() =>
    store.recordSkillProvenance([], {
      skillId: "personal-context",
      stage: "verificada",
      sha256: mat.materialized[0].sha256,
    }),
  );

  const prov = store.recordSkillProvenance([], {
    skillId: "personal-context",
    version: "1.0.0",
    sha256: mat.materialized[0].sha256,
    stage: "cargada_observada",
    evidence: {
      source: "acp_available_commands",
      verifiedAt: new Date(nowIsoSafe()).toISOString(),
    },
  });
  assert.equal(prov[0].stage, "cargada_observada");

  // Edit profile and verify persistence across restart
  await store.updateProfile("investigacion", {
    description: "Investigación personalizada sin red",
    allowedMcps: ["secondbrain"],
  });
  const reopened = await createToolCatalogStore({
    dataDir: path.join(dir, "catalog-data"),
    env: {},
  });
  assert.equal(
    reopened.getProfile("investigacion").description,
    "Investigación personalizada sin red",
  );
});

function nowIsoSafe() {
  return Date.now();
}

test("rutas HTTP /agentes/herramientas/* respetan permisos de sala y bloquean billingAuthorized no verificado", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-cat-http-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vault = path.join(dir, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Catálogo HTTP\n");

  const toolCatalog = await createToolCatalogStore({
    dataDir: path.join(dir, "lanzador-data"),
    env: { AGENTES_BRAIN_TOKEN_FILE: path.join(dir, "token") },
  });
  const h = (v) => createHash("sha256").update(v).digest("hex");
  const launcher = createLauncherServer({
    toolCatalog,
    controlHash: h("ctrl"),
  });
  launcher.listen(0, "127.0.0.1");
  await once(launcher, "listening");
  t.after(() => {
    launcher.closeAllConnections();
    launcher.close();
  });

  const app = await createApplication({
    vaultRoot: vault,
    dataDirectory: path.join(dir, "service-data"),
    auth: false,
    agentes: { brainToken: "room-secret" },
    lanzador: {
      url: `http://127.0.0.1:${launcher.address().port}`,
      token: "ctrl",
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;

  // Room agent can inspect catalog & resolve skills, NEVER modify ToolProfiles (403)
  const catRes = await fetch(
    `${base}/agents/tools/catalog?profileId=investigacion&billingAuthorized=true`,
    { headers: { authorization: "Bearer room-secret" } },
  );
  assert.equal(catRes.status, 200);
  const catJson = await catRes.json();
  assert.equal(catJson.profile.id, "investigacion");
  const ds = catJson.engines.find((e) => e.id === "deepseek");
  assert.equal(ds.states.permitida, false);

  const editDenied = await fetch(`${base}/agents/tools/profiles`, {
    method: "POST",
    headers: {
      authorization: "Bearer room-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      profileId: "investigacion",
      allowedEffectCategories: ["external_message"],
    }),
  });
  assert.equal(editDenied.status, 403);
});
