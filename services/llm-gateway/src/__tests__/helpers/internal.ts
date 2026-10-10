/**
 * Requests to the internal surface, as the backend's service binding sends them.
 *
 * Nothing is signed any more: an internal route admits a request only when it
 * came through the `InternalApi` entrypoint, which hands the app an env marked
 * by `asBindingCallerEnv`. A suite passes that env (`bindingEnv(env)`) for a
 * binding call and the plain env for an internet request.
 */
import { asBindingCallerEnv } from "../../lib/binding-caller.js";

export const makeInternalRequest = (method: string, path: string, body: string = ""): Request => {
    // GET and HEAD requests cannot have a body — the Request constructor will throw.
    const isBodyless = ["GET", "HEAD"].includes(method.toUpperCase());

    return new Request(`http://localhost${path}`, {
        headers: { "Content-Type": "application/json" },
        method,
        ...(!isBodyless && { body }),
    });
};

/** The env the `InternalApi` entrypoint runs the app with. */
export const bindingEnv = <Environment extends object>(env: Environment): Environment => asBindingCallerEnv(env);
