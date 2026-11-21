// @vitest-environment jsdom

/**
 * Renders `useProjectConfirm` in a probe inside the real auth and offline contexts. What is measured is when the hook
 * reads its project and what it reports back to the connection state.
 */
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthValue } from "@/auth/auth-state";
import { AuthContext } from "@/auth/auth-state";
import type { OfflineValue } from "@/offline/offline-context";
import { OfflineContext } from "@/offline/offline-context";

import { useProjectConfirm } from "./use-projects";

const harness = vi.hoisted(() => {
    return {
        query: vi.fn(async (): Promise<unknown> => null),
    };
});

// `getClient` builds the app's one client from its config; the hook is given a client that answers from the test.
// eslint-disable-next-line no-restricted-syntax -- `getClient` reads the app's config and builds the real client, which a test must not
vi.mock(import("@/lib/lunora"), () => {
    const client = { query: harness.query };

    return { getClient: () => client } as never;
});

const reportRead = vi.fn();

const signedIn = (overrides: Partial<AuthValue> = {}): AuthValue => {
    return {
        hasToken: true,
        isConfirming: false,
        retryToken: async () => undefined,
        signIn: async () => undefined,
        signOut: async () => undefined,
        status: "signed-in",
        user: { id: "u1" } as AuthValue["user"],
        ...overrides,
    };
};

const connection = (overrides: Partial<OfflineValue> = {}): OfflineValue => {
    return { cache: undefined, isChecking: true, isOffline: false, refreshTick: 0, reportRead, ...overrides };
};

describe("useProjectConfirm", () => {
    let container: HTMLDivElement;
    let root: Root;
    let auth: AuthValue;
    let offline: OfflineValue;

    const Probe = ({ projectId }: { projectId: string }) => {
        const refusal = useProjectConfirm(projectId);

        return createElement("p", null, refusal ?? "none");
    };

    const render = async () => {
        const probe = createElement(Probe, { projectId: "p1" });
        const withOffline = createElement(OfflineContext, { value: offline }, probe);
        const tree = createElement(AuthContext, { value: auth }, withOffline);

        await act(async () => {
            root.render(tree);
        });
    };

    const flush = async () => {
        await act(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 0);
            });
        });
    };

    beforeEach(() => {
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
        auth = signedIn();
        offline = connection();
        reportRead.mockClear();
        harness.query.mockReset();
        harness.query.mockResolvedValue(null);
    });

    afterEach(() => {
        act(() => {
            root.unmount();
        });
        container.remove();
    });

    it("reads its project once when it mounts while the connection is unconfirmed, and reports the answer", async () => {
        await render();
        await flush();

        expect(harness.query).toHaveBeenCalledTimes(1);
        expect(reportRead).toHaveBeenCalledWith("succeeded");
    });

    it("reads again on each refresh tick, and not on a render without one", async () => {
        await render();
        await flush();

        offline = connection();
        await render();
        await flush();
        expect(harness.query).toHaveBeenCalledTimes(1);

        offline = connection({ refreshTick: 1 });
        await render();
        await flush();
        expect(harness.query).toHaveBeenCalledTimes(2);
    });

    it("does not read while offline", async () => {
        offline = connection({ isOffline: true });
        await render();
        await flush();

        expect(harness.query).not.toHaveBeenCalled();
        expect(reportRead).not.toHaveBeenCalled();
    });

    it("does not read without a token", async () => {
        auth = signedIn({ hasToken: false });
        await render();
        await flush();

        expect(harness.query).not.toHaveBeenCalled();
    });

    it("does not read once the connection is already confirmed", async () => {
        offline = connection({ isChecking: false });
        await render();
        await flush();

        expect(harness.query).not.toHaveBeenCalled();
    });

    it("shows the server's refusal and reports no success", async () => {
        harness.query.mockRejectedValue(new Error("FORBIDDEN"));
        await render();
        await flush();

        expect(container.textContent).toBe("FORBIDDEN");
        expect(reportRead).not.toHaveBeenCalled();
    });

    it("stops showing a refusal once the connection is confirmed by a live answer", async () => {
        harness.query.mockRejectedValue(new Error("FORBIDDEN"));
        await render();
        await flush();
        expect(container.textContent).toBe("FORBIDDEN");

        offline = connection({ isChecking: false });
        await render();
        await flush();

        expect(container.textContent).toBe("none");
    });

    it("reports nothing on a network failure, and shows no refusal", async () => {
        harness.query.mockRejectedValue(new TypeError("Network request failed"));
        await render();
        await flush();

        expect(container.textContent).toBe("none");
        expect(reportRead).not.toHaveBeenCalled();
    });

    it("clears a refusal once a later read answers", async () => {
        harness.query.mockRejectedValueOnce(new Error("FORBIDDEN"));
        await render();
        await flush();
        expect(container.textContent).toBe("FORBIDDEN");

        offline = connection({ refreshTick: 1 });
        await render();
        await flush();

        expect(container.textContent).toBe("none");
        expect(reportRead).toHaveBeenCalledWith("succeeded");
    });
});
