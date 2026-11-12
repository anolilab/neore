/**
 * Offline with something cached keeps the app on screen under a slim banner; the
 * full-screen view is for a window with nothing to show, and comes at once when
 * the browser says it is offline.
 */
import type { ConnectionStatus } from "@lunora/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONNECTION_THRESHOLDS_MS } from "../lib/connection-state";
import ConnectionProvider from "./connection-provider";
import OfflineBanner from "./offline-banner";
import OfflineScreen from "./offline-screen";

const client = vi.hoisted(() => {
    const listeners = new Set<(status: ConnectionStatus) => void>();

    return {
        /** What the client reports when the banner subscribes: `connected` mid-session, `connecting` on a start. */
        initial: "connected" as ConnectionStatus,
        emit: (status: ConnectionStatus) => {
            for (const listener of listeners) {
                listener(status);
            }
        },
        onConnectionStatus: (listener: (status: ConnectionStatus) => void) => {
            listeners.add(listener);
            listener(client.initial);

            return () => listeners.delete(listener);
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return { useLunora: () => client };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

const THREAD_LIST_KEY = ["lunora", "chat_composite:getThreadListData", { paginationOpts: { cursor: null, numItems: 100 } }];

const renderApp = (queryClient: QueryClient) =>
    render(
        <QueryClientProvider client={queryClient}>
            <ConnectionProvider>
                <OfflineScreen />
                <OfflineBanner />
            </ConnectionProvider>
        </QueryClientProvider>,
    );

const setBrowserOnline = (online: boolean) => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(online);
    act(() => {
        globalThis.dispatchEvent(new Event(online ? "online" : "offline"));
    });
};

describe("offline presentation", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        client.initial = "connected";
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("shows the banner at once and keeps the cached app on screen", () => {
        const queryClient = new QueryClient();

        queryClient.setQueryData(THREAD_LIST_KEY, { threads: { page: [] } });
        renderApp(queryClient);

        setBrowserOnline(false);

        expect(screen.getAllByRole("status").some((status) => status.textContent === "Offline – reconnecting…")).toBe(true);
        expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("covers the window at once on an offline start with nothing cached", () => {
        client.initial = "connecting";
        renderApp(new QueryClient());

        setBrowserOnline(false);

        expect(screen.getByRole("alertdialog")).toBeTruthy();
    });

    it("mid-session with nothing cached, keeps the banner and covers the window only after the offline threshold", () => {
        renderApp(new QueryClient());

        setBrowserOnline(false);

        expect(screen.queryByRole("alertdialog")).toBeNull();

        act(() => {
            vi.advanceTimersByTime(CONNECTION_THRESHOLDS_MS.offlineScreen);
        });

        expect(screen.getByRole("alertdialog")).toBeTruthy();
    });

    it("says back online after a reconnect, then clears by itself", () => {
        renderApp(new QueryClient());
        setBrowserOnline(false);

        setBrowserOnline(true);

        expect(screen.getAllByRole("status").some((status) => status.textContent === "Back online")).toBe(true);

        act(() => {
            vi.advanceTimersByTime(CONNECTION_THRESHOLDS_MS.backOnline);
        });

        expect(screen.getAllByRole("status").every((status) => status.textContent === "")).toBe(true);
    });

    it("stays up while the socket reconnects after the network is back, then says back online", () => {
        renderApp(new QueryClient());
        setBrowserOnline(false);
        act(() => {
            client.emit("connecting");
        });

        setBrowserOnline(true);

        expect(screen.getAllByRole("status").some((status) => status.textContent === "Reconnecting to the server…")).toBe(true);

        act(() => {
            client.emit("connected");
        });

        expect(screen.getAllByRole("status").some((status) => status.textContent === "Back online")).toBe(true);
    });

    it("does not announce a socket bounce the banner never showed", () => {
        renderApp(new QueryClient());

        act(() => {
            client.emit("connecting");
        });
        act(() => {
            client.emit("connected");
        });

        expect(screen.getAllByRole("status").every((status) => status.textContent === "")).toBe(true);
    });
});
