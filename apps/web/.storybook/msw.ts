import { setupWorker } from "msw/browser";

import { sessionHandlers } from "../src/storybook/session";

/**
 * Started at module scope rather than in a loader, so it is up as early as possible: better-auth
 * reads the session as its module loads. That read can still win the race (sibling modules
 * evaluate while this one awaits), which is why the preview also awaits `settleSession`.
 *
 * The session handlers are initial handlers, which survive the reset between stories; they
 * answer as the active persona. A request no handler answers goes to the network, which
 * for the `*.storybook.test` origins does not resolve: the story shows the failure, and
 * the console names the request.
 */
export const worker = setupWorker(...sessionHandlers());

const isPageRequest = (data: unknown): boolean => {
    const { request } = data as { request?: unknown };

    if (!(request instanceof Request)) {
        return false;
    }

    const url = new URL(request.url);

    // better-auth calls the page's own origin too; an unmocked auth endpoint is a missing fixture.
    return url.origin === globalThis.location.origin && !url.pathname.startsWith("/api/auth/");
};

/** A request to a backend the stories mock (Lunora's RPC, the auth API, the gateway): unanswered, it is a missing fixture. */
const isBackendRequest = (data: unknown): boolean => {
    const { request } = data as { request?: unknown };

    if (!(request instanceof Request)) {
        return false;
    }

    const { pathname } = new URL(request.url);

    return pathname.includes("/_lunora/") || pathname.startsWith("/api/") || pathname.startsWith("/v1/");
};

// Under the test runner (`VITE_STORYBOOK_MODE` is set by `vitest.storybook.config.ts`) a missing backend fixture fails
// the request, so the story that made it fails too; a warning is all a story would otherwise get.
const underTest = import.meta.env.VITE_STORYBOOK_MODE !== undefined;

await worker.start({
    // Storybook's and Vite's own requests are the page's; anything else unanswered is a missing fixture.
    onUnhandledFrame: ({ defaults, frame }) => {
        if (isPageRequest(frame.data)) {
            return;
        }

        if (underTest && isBackendRequest(frame.data)) {
            defaults.error();

            return;
        }

        defaults.warn();
    },
    quiet: true,
});
