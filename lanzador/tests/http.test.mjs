import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createLauncherServer } from "../index.mjs";

test("control y hooks usan credenciales distintas y las rutas modifican solo la sesión solicitada", async (t) => {
  let estado = [
    { id: "a1111111-1111-4111-8111-111111111111", estado: "trabajando" },
  ];
  const registro = {
    leer: () => estado,
    actualizar: async (id, cambios) => {
      estado = estado.map((s) => (s.id === id ? { ...s, ...cambios } : s));
    },
    subscribe: () => () => {},
  };
  const ejecutor = {
    encargar: async (x) => ({ id: "s2", ...x }),
    cancelar: async (id) => {
      assert.equal(id, "a1111111-1111-4111-8111-111111111111");
    },
    eliminar: async (id) => {
      estado = estado.map((s) => (s.id === id ? { ...s, eliminada: true } : s));
      return { id };
    },
  };
  const server = createLauncherServer({
    registro,
    ejecutor,
    controlHash: huella("control"),
    hookHash: huella("hook"),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const req = (ruta, token, body) =>
    fetch(url + ruta, {
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
  assert.equal(estado[0].fase, "investigar");
  assert.equal(JSON.stringify(estado).includes("secreto"), false);
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
  assert.deepEqual(await (await req("/estado", "control")).json(), estado);
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
function huella(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("las rutas de equipo exigen control y enlazan mensajes al miembro activo", async (t) => {
  const registro = {
    leer: () => [{ id: "s1", motor: "codex", estado: "trabajando" }],
    subscribe: () => () => {},
  };
  const equipos = {
    estado: (id) => ({ lider: id }),
    bandeja: (id) => [{ para: id }],
    mensaje: async (de, para, texto) => ({ de, para, texto }),
    entregar: async (de, titulo, contenido) => ({ de, titulo, contenido }),
  };
  const ejecutor = {
    encargarHija: async (id, datos) => {
      if (datos.motor === "deepseek")
        throw new Error("Saldo DeepSeek insuficiente");
      return { id: "hija", padreId: id, ...datos };
    },
    esperarHija: async () => ({ estado: "terminada" }),
  };
  const server = createLauncherServer({
    registro,
    ejecutor,
    equipos,
    controlHash: huella("control"),
    hookHash: huella("hook"),
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
  const saldo = await post("/equipo/encargar", "control", {
    sesion: "s1",
    actor: "menta",
    motor: "deepseek",
    brief: "consulta",
  });
  assert.equal((await saldo.json()).error, "Saldo DeepSeek insuficiente");
});
