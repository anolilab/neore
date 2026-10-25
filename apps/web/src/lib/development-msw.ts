/**
 * Dev-only mocked gateway for the e2e suite. The browser's gateway requests go
 * through a service worker (msw) when a test sets `E2E_MSW_KEY` in localStorage
 * before the page loads. Only ever imported behind `import.meta.env.DEV`, so
 * the worker and its handlers never reach a production bundle.
 *
 * The page is marked `data-msw-ready` once the worker controls it, so a test can
 * wait for it before the first request it means to intercept.
 */

const E2E_MSW_KEY = "neore:e2e-msw";

interface MockedGatewayConfig {
    scenario: "rate-limited";
}

const RATE_LIMITED = {
    error: { code: "RATE_LIMITED", message: "Rate limit exceeded: 30 requests per minute", retryAfter: 30 },
};

export const startMockedGateway = async (): Promise<void> => {
    const raw = globalThis.localStorage.getItem(E2E_MSW_KEY);

    if (!raw) {
        return;
    }

    const { scenario } = JSON.parse(raw) as MockedGatewayConfig;
    // Dev-only dependency, reached only behind `import.meta.env.DEV`.
    // eslint-disable-next-line import/no-extraneous-dependencies
    const { http, HttpResponse } = await import("msw");
    // eslint-disable-next-line import/no-extraneous-dependencies
    const { setupWorker } = await import("msw/browser");

    const handlers = {
        "rate-limited": [http.post("*/llm-gateway/v1/chat", () => HttpResponse.json(RATE_LIMITED, { status: 429 }))],
    } satisfies Record<MockedGatewayConfig["scenario"], unknown[]>;

    await setupWorker(...handlers[scenario]).start({ onUnhandledFrame: "bypass" });

    globalThis.document.documentElement.dataset.mswReady = "true";
};
