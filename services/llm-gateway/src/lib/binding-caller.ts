/**
 * Marks a request as having arrived through the `InternalApi` entrypoint — i.e.
 * over a Cloudflare service binding from the backend, never from the internet.
 *
 * The gateway is public (the browser posts to `/v1/*`), and the default `fetch`
 * handler cannot tell a binding call from an internet request. A NAMED
 * entrypoint can: it is not served on any route or `workers.dev`, so only a
 * service binding reaches it. `InternalApi` (src/index.ts) runs the same Hono
 * app with an env carrying this marker, and `internalAuth` admits a request to
 * an internal route only when the marker is present.
 *
 * The marker is a module-private `Symbol`, not a string key: a `vars` entry or
 * a secret cannot produce it, so no deploy configuration can open the internal
 * routes to the public handler.
 */
const VIA_BINDING: unique symbol = Symbol("llm-gateway.via-binding");

/** The env the `InternalApi` entrypoint hands the app: the Worker env plus the marker. */
export const asBindingCallerEnv = <Environment extends object>(env: Environment): Environment => {
    return { ...env, [VIA_BINDING]: true };
};

/** Whether `env` is the one `asBindingCallerEnv` built — the request came through the binding. */
export const isBindingCall = (env: unknown): boolean => typeof env === "object" && env !== null && (env as { [VIA_BINDING]?: unknown })[VIA_BINDING] === true;
