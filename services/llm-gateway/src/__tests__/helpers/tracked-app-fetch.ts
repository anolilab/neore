/**
 * `app.fetch` for integration tests, with every request's execution context
 * tracked and settled before the test ends.
 *
 * The app hands work to `waitUntil` (usage logging, the usage report to the
 * backend, cache writes). That work outlives the response: a streamed reply's
 * logging settles only once the body is drained. A test that checks the status
 * and moves on leaves it running into teardown, and the log it emits there
 * fails the whole run with "EnvironmentTeardownError: Closing rpc while
 * onUserConsoleLog was pending" — intermittently, whenever the timing loses.
 *
 * `useTrackedAppFetch()` registers the hooks: `afterEach` cancels undrained
 * bodies and awaits every context's `flush()`. It also stubs the global `fetch`
 * (answering 204), so the usage reporter never reaches the network: a real
 * fetch to the mock env's `*.invalid` backend depends on the machine's resolver
 * and firewall, and a slow one outlives the test too.
 */
import { afterEach, beforeEach, vi } from "vitest";

import { app } from "../../index.js";
import { createMockCtx as createMockContext } from "./mock-env.js";

type MockContext = ReturnType<typeof createMockContext>;

export const useTrackedAppFetch = (): ((request: Request, env: unknown) => Promise<Response>) => {
    const inFlight: { context: MockContext; response: Response }[] = [];

    beforeEach(() => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(null, { status: 204 })),
        );
    });

    afterEach(async () => {
        const settled = [...inFlight];

        inFlight.length = 0;

        for (const { context, response } of settled) {
            if (!response.bodyUsed) {
                await response.body?.cancel().catch(() => undefined);
            }

            await context.flush();
        }

        vi.unstubAllGlobals();
    });

    return async (request, env) => {
        const context = createMockContext();
        const response = await app.fetch(request, env as never, context as unknown as ExecutionContext);

        inFlight.push({ context, response });

        return response;
    };
};
