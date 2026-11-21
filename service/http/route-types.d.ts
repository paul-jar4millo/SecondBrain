import type { ServerResponse } from "node:http";
import type { HttpRequest } from "../types.d.ts";
import type { AppContext } from "./context.mjs";

/** What a route handler knows about the request it is answering. */
export interface RouteRequest {
  request: HttpRequest;
  /** Whether the request used a temporary legacy route alias. */
  legacy?: boolean;
  response: ServerResponse;
  /** Query parameters, already validated against the route's schema. */
  consulta: URLSearchParams;
  /** A query value the route's schema requires. */
  required(name: string): string;
  /** The agent capability of the caller, or null for a user session. */
  callerCap: ReturnType<AppContext["assertAgentCapabilityForRoute"]>;
}

/** "METHOD /path" → handler. Keys must match service/routes.mjs. */
export type Routes = Partial<Record<string, () => Promise<unknown>>>;

/** Each file in http/routes exports one of these per domain. */
export type RouteModule = (ctx: AppContext, req: RouteRequest) => Routes;
