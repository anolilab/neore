import type { ArgsOf, FunctionReference, ReturnOf } from "@lunora/react";
import { decodeWire, encodeWire } from "@lunora/wire";
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

/** What one call answers: the body the RPC endpoint returns for it, and its HTTP status. */
interface Answer {
    body: { error: { code: string; message: string } } | { result: unknown };
    status: number;
}

export interface LunoraFixture {
    readonly answer: (args: unknown) => Promise<Answer>;
    readonly functionPath: string;
    /** Never answers: left out of `lunoraIdle`, or every loading story would wait out the limit. */
    readonly pending?: true;
}

interface RpcCall {
    args?: unknown;
    functionPath?: string;
    id?: number;
}

const pathOf = (reference: FunctionReference): string => (reference as unknown as { __lunoraRef: string }).__lunoraRef;

/** A procedure that answers with `value`, or with what `value(args)` returns. */
export const lunora = <F extends FunctionReference>(reference: F, value: Resolver<F>, options: { delayMs?: number } = {}): LunoraFixture => {
    return {
        answer: async (args) => {
            if (options.delayMs) {
                await delay(options.delayMs);
            }

            const result = typeof value === "function" ? await (value as (args: ArgsOf<F>) => ReturnOf<F>)(args as ArgsOf<F>) : value;

            return { body: { result: encodeWire(result) }, status: 200 };
        },
        functionPath: pathOf(reference),
    };
};

/** A procedure that fails with a Lunora error envelope (`code` as `LunoraError#code`). */
export const lunoraError = (reference: FunctionReference, code: string, message = code, status = 400): LunoraFixture => {
    return {
        answer: async () => {
            return { body: { error: { code, message } }, status };
        },
        functionPath: pathOf(reference),
    };
};

/** A procedure that never answers: the component's loading state. */
export const lunoraPending = (reference: FunctionReference): LunoraFixture => {
    return {
        answer: async () => {
            await delay("infinite");

            return { body: { result: null }, status: 200 };
        },
        functionPath: pathOf(reference),
        pending: true,
    };
};

/** Procedures answered since the story started, and the `play` functions waiting on one. */
const answeredPaths = new Set<string>();
const waiting = new Map<string, (() => void)[]>();

/** Calls in flight, and when the last one was answered: what `lunoraIdle` waits on. */
const traffic = { inFlight: 0, lastAnswerAt: 0 };

const storyResets: (() => void)[] = [];

/**
 * Registers a fixture's reset: stateful rows (a write merges into them) start over before each story, so a story
 * never sees what an earlier story, or an earlier visit to the same one, saved.
 */
export const onStoryReset = (reset: () => void): void => {
    storyResets.push(reset);
};

/** Called by a preview loader before each story. */
export const resetLunoraAnswers = (): void => {
    answeredPaths.clear();

    for (const reset of storyResets) {
        reset();
    }
};

const QUIET_MS = 300;
const IDLE_LIMIT_MS = 5000;

/**
 * Resolves once no Lunora call has been in flight for `QUIET_MS`, or after `IDLE_LIMIT_MS`
 * (polling and never-answering fixtures keep a page busy for good). The preview awaits it
 * before axe runs, so the check sees the page with its data, not its loading state.
 */
export const lunoraIdle = async (): Promise<void> => {
    const started = Date.now();

    while (Date.now() - started < IDLE_LIMIT_MS) {
        if (traffic.inFlight === 0 && Date.now() - traffic.lastAnswerAt >= QUIET_MS) {
            return;
        }

        await delay(50);
    }
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
 * The `/_lunora/rpc` and `/_lunora/rpc-batch` handlers for a set of fixtures (the batch endpoint
 * is what live subscriptions poll on when there is no socket). A procedure without a fixture
 * answers `NOT_FOUND` and is logged, so a story shows what it is missing instead of hanging.
 * Later fixtures win, which lets a story override one entry of a shared set.
 */
export const lunoraHandlers = (...fixtures: ReadonlyArray<LunoraFixture>): HttpHandler[] => {
    const byPath = new Map(fixtures.map((fixture) => [fixture.functionPath, fixture]));

    const answerCall = async ({ args, functionPath = "" }: RpcCall): Promise<Answer> => {
        const fixture = byPath.get(functionPath);

        if (!fixture) {
            console.warn(`[storybook] no Lunora fixture for "${functionPath}"`, args);

            return { body: { error: { code: "NOT_FOUND", message: `No Storybook fixture for ${functionPath}` } }, status: 404 };
        }

        // The app's arguments arrive in Lunora's wire format; a resolver gets the value the real server would decode.
        const decoded = decodeWire(args);

        if (fixture.pending) {
            return await fixture.answer(decoded);
        }

        traffic.inFlight += 1;

        try {
            return await fixture.answer(decoded);
        } finally {
            traffic.inFlight -= 1;
            traffic.lastAnswerAt = Date.now();
            noteAnswered(functionPath);
        }
    };

    return [
        http.post(`${env.VITE_LUNORA_URL}/_lunora/rpc`, async ({ request }) => {
            const { body, status } = await answerCall((await request.json()) as RpcCall);

            return HttpResponse.json(body, { status });
        }),
        http.post(`${env.VITE_LUNORA_URL}/_lunora/rpc-batch`, async ({ request }) => {
            const { calls = [] } = (await request.json()) as { calls?: RpcCall[] };
            const results = await Promise.all(
                calls.map(async (call) => {
                    // Each slot carries its own status, as Lunora's batch contract requires: a failed call is not a 200.
                    const { body, status } = await answerCall(call);

                    return { body, id: call.id, status };
                }),
            );

            return HttpResponse.json({ results });
        }),
    ];
};
