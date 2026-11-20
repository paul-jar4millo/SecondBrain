import path from "node:path";
import { body, send, validateNotePath } from "../io.mjs";
import { readFile } from "node:fs/promises";
import { Failure, hash } from "../../vault.mjs";
import { sendItems } from "../../http-items.mjs";
import { reminders } from "../../reminders.mjs";
import { strToU8, zip } from "fflate";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const vaultRoutes = (ctx, req) => {
  const { auth, change, root, vault } = ctx;
  const { consulta: query, request, response } = req;
  return {
    "GET /vault/files": async () => {
      return send(response, 200, await vault.files());
    },
    "GET /vault/note": async () => {
      const relative = query.get("path");
      validateNotePath(relative);
      await vault.queue;
      const content = await readFile(await vault.safe(relative), "utf8");
      return send(response, 200, {
        path: relative,
        content,
        hash: hash(content),
      });
    },
    "POST /vault/note": async () => {
      const { path: relative, content, expectedHash } = await body(request);
      validateNotePath(relative);
      // Every agent reads these first; a rewrite would steer all of them.
      if (
        auth.isRoomAgent(request) &&
        /^(AGENTS\.md$|99-Meta\/)/.test(path.posix.normalize(relative))
      )
        throw new Failure("Las reglas del vault solo las edita su dueño.", 403);
      if (relative.split("/").pop() === "Datos-financieros.md")
        throw new Failure(
          "Usa las operaciones de finanzas para los datos estructurados.",
        );
      if (
        typeof content !== "string" ||
        Buffer.byteLength(content) > 2 * 1024 * 1024 ||
        (expectedHash !== null && !/^[a-f0-9]{64}$/.test(expectedHash || ""))
      )
        throw new Failure(
          "Envía el contenido y el hash leído; null solo para notas nuevas.",
        );
      await vault.exclusive(() =>
        vault.transaction(() => vault.atomic(relative, content, expectedHash)),
      );
      change();
      return send(response, 200, { path: relative, hash: hash(content) });
    },
    "GET /vault/status": async () => {
      const snapshot = await vault.read();
      return send(response, 200, {
        root,
        source: "Obsidian · Markdown",
        documents: snapshot.byPath.size,
        issues: snapshot.issues,
      });
    },
    "GET /items": async () => {
      const snapshot = await vault.read();
      return await sendItems(request, response, [
        ...snapshot.items,
        ...reminders(snapshot.items),
      ]);
    },
    "POST /mutations": async () => {
      const result = await vault.mutate(await body(request));
      change();
      return send(response, 200, result);
    },
    "POST /imports": async () => {
      const result = await vault.import((await body(request)).items);
      change();
      return send(response, 200, result);
    },
    "GET /export": async () => {
      const snapshot = await vault.read();
      /** @type {Record<string, Uint8Array>} */
      const files = {};
      const manifest = [];
      for (const record of snapshot.byPath.values()) {
        files[record.relative] = strToU8(record.text);
        manifest.push({
          path: record.relative,
          sha256: hash(record.text),
        });
      }
      files["second-brain-vault.json"] = strToU8(
        JSON.stringify(
          {
            schemaVersion: 2,
            source: "obsidian-markdown",
            exportedAt: new Date().toISOString(),
            files: manifest,
          },
          null,
          2,
        ),
      );
      const archive = await new Promise((resolve, reject) =>
        zip(files, (error, archive) =>
          error ? reject(error) : resolve(archive),
        ),
      );
      response.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="second-brain-vault.zip"',
      });
      response.end(archive);
      return;
    },
  };
};
