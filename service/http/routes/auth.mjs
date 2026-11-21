import { body, send } from "../io.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const authRoutes = (ctx, req) => {
  const { auth, mcpRemoto: mcpRemote } = ctx;
  const { request, response } = req;
  return {
    "GET /auth/status": async () => {
      return send(response, 200, {
        authenticated: auth.authenticated(request),
        enabled: auth.enabled,
        needsSetup: auth.enabled && !auth.state.passwordHash,
        // Display name only (SB_OWNER_NAME); empty keeps the UI neutral.
        ownerName: String(process.env.SB_OWNER_NAME ?? "")
          .trim()
          .slice(0, 60),
      });
    },
    "GET /auth/csrf": async () => {
      return send(response, 200, auth.csrf(request, response));
    },
    "POST /auth/setup": async () => {
      return send(
        response,
        200,
        await auth.setup(await body(request), request, response),
      );
    },
    "POST /auth/login": async () => {
      return send(
        response,
        200,
        await auth.login(await body(request), request, response),
      );
    },
    "POST /auth/logout": async () => {
      await auth.logout(request, response);
      return send(response, 204);
    },
    "POST /auth/totp/start": async () => {
      return send(response, 200, await auth.startTotp());
    },
    "POST /auth/totp/enable": async () => {
      return send(
        response,
        200,
        await auth.enableTotp((await body(request)).code),
      );
    },
    "GET /oauth/clients": async () => send(response, 200, mcpRemote.listar()),
    "POST /oauth/clients/revoke": async () => {
      await mcpRemote.revocar((await body(request)).id);
      return send(response, 200, { ok: true });
    },
  };
};
