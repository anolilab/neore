/**
 * Marks a request dispatched in-process by another route (`/v1/responses` through the
 * top-level app), and carries the outer request's telemetry so the inner request joins it.
 *
 * The app-level middleware runs for the inner request too. Without this marker it would
 * open a second root span, count a second request, log a second line and mint a second
 * request id for one client call. The outer request owns those; the inner one records
 * into the outer's telemetry and adopts its request id.
 *
 * Same technique as `binding-caller.ts`: a module-private `Symbol` on the env object handed
 * to the dispatch. A request header would not do, because a client could send it and switch
 * off its own logging. Object spread copies own symbol keys, so a binding-caller env keeps
 * its own marker when it is spread.
 */
import type { AppEnv } from "../env.js";
import type { RequestTelemetry, Span } from "./otel/index.js";

const DISPATCHED_FROM: unique symbol = Symbol("llm-gateway.dispatched-from");

/** The outer request's identity and telemetry, shared with the request it dispatches. */
export interface DispatchedFrom {
    requestId: string;
    rootSpan: Span;
    telemetry: RequestTelemetry;
}

/** The env to dispatch with: the Worker env plus the outer request's marker. */
export const asDispatchedEnv = (env: AppEnv, outer: DispatchedFrom): AppEnv & { [DISPATCHED_FROM]: DispatchedFrom } => {
    return { ...env, [DISPATCHED_FROM]: outer };
};

/** The outer request's identity, when `env` is one `asDispatchedEnv` built; undefined for a request that came from outside. */
export const dispatchedFrom = (env: unknown): DispatchedFrom | undefined => {
    if (typeof env !== "object" || env === null) {
        return undefined;
    }

    return (env as { [DISPATCHED_FROM]?: DispatchedFrom })[DISPATCHED_FROM];
};
