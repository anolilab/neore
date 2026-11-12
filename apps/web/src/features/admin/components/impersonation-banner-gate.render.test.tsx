// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest runs without globals, so nothing else cleans up between tests
import { act, cleanup, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ImpersonationBannerGate from "./impersonation-banner-gate";

const state = vi.hoisted(() => {
    return { bannerImported: false, isImpersonating: false };
});

vi.mock("../hooks/use-is-impersonating", () => {
    return {
        useIsImpersonating: () => {
            return { data: { isImpersonating: state.isImpersonating } };
        },
    };
});

// The banner's chunk is gone (a deploy replaced it, or the network dropped): every import of it rejects.
vi.mock("./impersonation-banner", () => {
    state.bannerImported = true;

    throw new TypeError("Failed to fetch dynamically imported module");
});

const renderApp = () =>
    render(
        <div>
            <span>app content</span>
            <Suspense fallback={null}>
                <ImpersonationBannerGate />
            </Suspense>
        </div>,
    );

describe("the impersonation banner gate", () => {
    // Each test starts with no fetch seen, whatever order they run in.
    beforeEach(() => {
        state.bannerImported = false;
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it("never fetches the banner for a session that is not impersonated", async () => {
        state.isImpersonating = false;

        renderApp();
        await act(async () => {
            await Promise.resolve();
        });

        expect(state.bannerImported).toBe(false);
        expect(screen.getByText("app content")).toBeTruthy();
    });

    it("keeps the app mounted when the banner's chunk fails to load", async () => {
        vi.useFakeTimers();
        state.isImpersonating = true;

        renderApp();
        // Past every retry (1, 2 and 4 seconds).
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
        });

        expect(state.bannerImported).toBe(true);
        expect(screen.getByText("app content")).toBeTruthy();
    });
});
