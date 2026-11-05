import type { ArgsOf, FunctionReference, ReturnOf } from "@lunora/react";
import { encodeWire } from "@lunora/wire";
import type { HttpHandler } from "msw";
import { delay, http, HttpResponse } from "msw";

import env from "@/lib/env";

/**
 * The backend, for Storybook: one MSW handler on `POST /_lunora/rpc` that answers
 * each procedure from a fixture keyed by its `api.*` reference.
 *
 * Fixtures are typed against the generated API, so a backend change that renames a
 * field fails `lint:types` here instead of rendering a story with `undefined`:
 *
 * ```ts
 * parameters: {
 *     msw: { handlers: { lunora: lunoraHandlers(
 *         lunora(api.chat.functions.getThreads, { page: [], isDone: true, continueCursor: "" }),
 *         lunoraError(api.auth.functions.getUserSettings, "UNAUTHENTICATED"),
 *     ) } },
 * }
 * ```
 *
 * Queries, mutations and actions all go through the same endpoint (`LunoraClient#rpc`).
 * Live queries do not: Storybook never calls `connectLiveQueries`, so `crpc` falls back
 * to the plain RPC (see `lib/lunora/crpc.tsx`).
 */

type Resolver<F extends FunctionReference> = ((args: ArgsOf<F>) => Promise<ReturnOf<F>> | ReturnOf<F>) | ReturnOf<F>;

export interface LunoraFixture {
    readonly functionPath: string;
    readonly respond: (args: unknown) => Promise<Response>;
}

interface RpcBody {
    args?: unknown;
    functionPath?: string;
}

const pathOf = (reference: FunctionReference): string => (reference as unknown as { __lunoraRef: string }).__lunoraRef;

/** A procedure that answers with `value`, or with what `value(args)` returns. */
export const lunora = <F extends FunctionReference>(reference: F, value: Resolver<F>, options: { delayMs?: number } = {}): LunoraFixture => {
    return {
        functionPath: pathOf(reference),
        respond: async (args) => {
            if (options.delayMs) {
                await delay(options.delayMs);
            }

            const result = typeof value === "function" ? await (value as (args: ArgsOf<F>) => ReturnOf<F>)(args as ArgsOf<F>) : value;

            return HttpResponse.json({ result: encodeWire(result) });
        },
    };
};

/** A procedure that fails with a Lunora error envelope (`code` as `LunoraError#code`). */
export const lunoraError = (reference: FunctionReference, code: string, message = code, status = 400): LunoraFixture => {
    return {
        functionPath: pathOf(reference),
        respond: async () => HttpResponse.json({ error: { code, message } }, { status }),
    };
};

/** A procedure that never answers: the component's loading state. */
export const lunoraPending = (reference: FunctionReference): LunoraFixture => {
    return {
        functionPath: pathOf(reference),
        respond: async () => {
            await delay("infinite");

            return HttpResponse.json({});
        },
    };
};

/** Procedures answered since the story started, and the `play` functions waiting on one. */
const answeredPaths = new Set<string>();
const waiting = new Map<string, (() => void)[]>();

/** Called by a preview loader before each story. */
export const resetLunoraAnswers = (): void => {
    answeredPaths.clear();
};

const noteAnswered = (functionPath: string): void => {
    answeredPaths.add(functionPath);

    const resolvers = waiting.get(functionPath) ?? [];

    for (const resolve of resolvers) {
        resolve();
    }

    waiting.delete(functionPath);
};

/**
 * Resolves once `reference` has been answered in this story, and the client has had a moment
 * to store it. For a `play` that must not act before a screen has its data: an edit built on
 * the user's preferences refuses until they load, as it does in the app.
 */
export const lunoraAnswered = async (reference: FunctionReference): Promise<void> => {
    const path = pathOf(reference);

    if (!answeredPaths.has(path)) {
        await new Promise<void>((resolve) => {
            waiting.set(path, [...(waiting.get(path) ?? []), resolve]);
        });
    }

    // The response is decoded and written to the query cache after the handler returns.
    await delay(50);
};

/**
 * The `/_lunora/rpc` handler for a set of fixtures. A procedure without one answers
 * `NOT_FOUND` and is logged, so a story shows what it is missing instead of hanging.
 * Later fixtures win, which lets a story override one entry of a shared set.
 */
export const lunoraHandlers = (...fixtures: ReadonlyArray<LunoraFixture>): HttpHandler => {
    const byPath = new Map(fixtures.map((fixture) => [fixture.functionPath, fixture]));

    return http.post(`${env.VITE_LUNORA_URL}/_lunora/rpc`, async ({ request }) => {
        const { args, functionPath = "" } = (await request.json()) as RpcBody;
        const fixture = byPath.get(functionPath);

        if (!fixture) {
            console.warn(`[storybook] no Lunora fixture for "${functionPath}"`, args);

            return HttpResponse.json({ error: { code: "NOT_FOUND", message: `No Storybook fixture for ${functionPath}` } }, { status: 404 });
        }

        const response = await fixture.respond(args);

        noteAnswered(functionPath);

        return response;
    });
};
