/**
 * The sibling Workers this backend calls, over Cloudflare service bindings.
 *
 * `lunora.config.ts` declares them; codegen types `ctx.services.<key>` on
 * ACTIONS only (queries and mutations cannot call out, and an HTTP action
 * reaches a service through `ctx.runAction`). There is no URL and no signing
 * secret: a binding call runs on the same machine, and a service with
 * `workers_dev: false` and no route has no other way in. The gateway is public
 * as well, so the backend binds its `InternalApi` entrypoint, which is the only
 * door to its `/internal/*` routes.
 *
 * Code deep in a call chain (the gateway `LanguageModelV3` / embedding proxies
 * inside the agent loop, the utility model, memory extraction) receives a
 * {@link ServiceFetch} threaded down EXPLICITLY from the action's `ctx` — never
 * a module-level client, because a binding belongs to the request that holds it.
 */
import type { LunoraServices } from "../_generated/server";

/** A `fetch` that goes to one service. The URL's host is ignored by the binding; only path and query route. */
export type ServiceFetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

/** The declared services, by `ctx.services` key. */
export type ServiceKey = keyof LunoraServices;

/** What carries the bindings: an action's `ctx`. */
export interface ServicesContext {
    readonly services: LunoraServices;
}

/**
 * Placeholder origins for building request URLs. A service binding delivers the
 * request to its Worker whatever the host says, so these never resolve — they
 * only make URLs well-formed and logs readable.
 */
export const SERVICE_ORIGIN: Readonly<Record<ServiceKey, string>> = {
    browserRenderer: "https://browser-renderer.internal",
    documentParser: "https://document-parser.internal",
    llmGateway: "https://llm-gateway.internal",
    nsfwChecker: "https://nsfw-checker.internal",
};

/**
 * The binding's `fetch`, as a plain function.
 *
 * Wrapped rather than passed through: a `Fetcher` method detached from its
 * binding throws `Illegal invocation` (Lunora pre-binds `fetch` for a fetch
 * service, but not for an RPC-entrypoint one), and the binding is looked up at
 * CALL time, so building a client never throws on a ctx whose binding is
 * absent — only using it does, with Lunora's own message naming it.
 */
export const serviceFetch =
    (ctx: ServicesContext, key: ServiceKey): ServiceFetch =>
    async (input, init) =>
        await ctx.services[key].fetch(input, init);

/** The LLM gateway's internal entrypoint (`/internal/*`). */
export const gatewayFetch = (ctx: ServicesContext): ServiceFetch => serviceFetch(ctx, "llmGateway");

/**
 * Whether the binding is present in this Worker. Lunora resolves an absent
 * binding to a stand-in that throws on first touch, so this probes inside a
 * `try`. Used where a missing service DEGRADES a feature (text extraction,
 * NSFW checks) instead of failing the request.
 */
export const isServiceBound = (ctx: ServicesContext, key: ServiceKey): boolean => {
    try {
        return typeof ctx.services[key].fetch === "function";
    } catch {
        return false;
    }
};

/**
 * For code that builds an `Agent` in a query or mutation — to read or save
 * messages, never to generate. Any model call through it throws, because a
 * service can only be called from an action.
 */
export const NO_SERVICE_FETCH: ServiceFetch = async () => {
    throw new Error("A service binding is reachable from actions only — this agent was built in a query or mutation and cannot call the LLM gateway.");
};

/**
 * The gateway fetch for a ctx of ANY kind: the binding when `ctx` is an
 * action's (it carries `services`), {@link NO_SERVICE_FETCH} otherwise. For
 * helpers shared by queries, mutations and actions (`getAgentForUser`).
 */
export const gatewayFetchFor = (ctx: object): ServiceFetch => ("services" in ctx ? gatewayFetch(ctx as ServicesContext) : NO_SERVICE_FETCH);
