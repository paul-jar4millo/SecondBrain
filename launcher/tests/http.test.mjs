import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createLauncherServer } from "../index.mjs";

test("control y hooks usan credenciales distintas y las rutas modifican solo la sesión solicitada", async (t) => {
  let state = [
    { id: "a1111111-1111-4111-8111-111111111111", estado: "trabajando" },
  ];
  const registry = {
    leer: () => state,
    actualizar: async (id, changes) => {
      state = state.map((s) => (s.id === id ? { ...s, ...changes } : s));
    },
    subscribe: () => () => {},
  };
  const executor = {
    encargar: async (x) => ({ id: "s2", ...x }),
    cancelar: async (id) => {
      assert.equal(id, "a1111111-1111-4111-8111-111111111111");
    },
    eliminar: async (id) => {
      state = state.map((s) => (s.id === id ? { ...s, eliminada: true } : s));
      return { id };
    },
  };
  const server = createLauncherServer({
    registro: registry,
    ejecutor: executor,
    controlHash: fingerprint("control"),
    hookHash: fingerprint("hook"),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const req = (path, token, body) =>
    fetch(url + path, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.equal((await req("/estado", "hook")).status, 401);
  assert.equal(
    (
      await req("/eventos", "control", {
        id: "a1111111-1111-4111-8111-111111111111",
        herramienta: "Read",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await req("/eventos", "hook", {
        id: "a1111111-1111-4111-8111-111111111111",
        herramienta: "Read",
        argumento: "secreto",
      })
    ).status,
    204,
  );
  assert.equal(state[0].fase, "investigar");
  assert.equal(JSON.stringify(state).includes("secreto"), false);
  assert.equal(
    (await req("/eventos", "hook", { id: "otra", herramienta: "Read" })).status,
    404,
  );
  assert.equal(
    (
      await req(
        "/sesiones/a1111111-1111-4111-8111-111111111111/cancelar",
        "control",
        {},
      )
    ).status,
    202,
  );
  assert.equal(
    (await req("/sesiones", "control", { motor: "claude", brief: "x" })).status,
    202,
  );
  assert.deepEqual(await (await req("/estado", "control")).json(), state);
  assert.equal(
    (
      await req(
        "/sesiones/a1111111-1111-4111-8111-111111111111/eliminar",
        "hook",
        {},
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await req(
        "/sesiones/a1111111-1111-4111-8111-111111111111/eliminar",
        "control",
        {},
      )
    ).status,
    200,
  );
  assert.deepEqual(await (await req("/estado", "control")).json(), []);
});

import { createHash } from "node:crypto";
function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("las rutas de equipo exigen control y enlazan mensajes al miembro activo", async (t) => {
  const registry = {
    leer: () => [{ id: "s1", motor: "codex", estado: "trabajando" }],
    subscribe: () => () => {},
  };
  const teams = {
    estado: (id) => ({ lider: id }),
    bandeja: (id) => [{ para: id }],
    mensaje: async (de, para, text) => ({ de, para, texto: text }),
    entregar: async (de, title, content) => ({
      de,
      titulo: title,
      contenido: content,
    }),
  };
  const executor = {
    encargarHija: async (id, data) => {
      if (data.motor === "deepseek")
        throw new Error("Saldo DeepSeek insuficiente");
      return { id: "hija", padreId: id, ...data };
    },
    esperarHija: async () => ({ estado: "terminada" }),
  };
  const server = createLauncherServer({
    registro: registry,
    ejecutor: executor,
    equipos: teams,
    controlHash: fingerprint("control"),
    hookHash: fingerprint("hook"),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (route, token, body) =>
    fetch(url + route, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await post("/equipo/mensaje", "hook", {
        sesion: "s1",
        para: "s2",
        texto: "hola",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await post("/equipo/mensaje", "control", {
        sesion: "ajena",
        actor: "menta",
        para: "s2",
        texto: "hola",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await post("/equipo/mensaje", "control", {
        sesion: "s1",
        actor: "lira",
        para: "s2",
        texto: "hola",
      })
    ).status,
    403,
  );
  const response = await post("/equipo/mensaje", "control", {
    sesion: "s1",
    actor: "menta",
    para: "s2",
    texto: "hola",
  });
  assert.deepEqual(await response.json(), {
    de: "s1",
    para: "s2",
    texto: "hola",
  });
  assert.equal(
    (
      await post("/equipo/encargar", "control", {
        sesion: "s1",
        actor: "menta",
        motor: "agy",
        brief: "consulta",
      })
    ).status,
    200,
  );
  const balance = await post("/equipo/encargar", "control", {
    sesion: "s1",
    actor: "menta",
    motor: "deepseek",
    brief: "consulta",
  });
  assert.equal((await balance.json()).error, "Saldo DeepSeek insuficiente");
});
