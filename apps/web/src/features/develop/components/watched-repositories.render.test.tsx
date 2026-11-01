/**
 * The watched-repositories panel: a webhook's secret is shown once and only when it was just issued, a watch the
 * backend refuses says why, and a stop button names its repository.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import WatchedRepositories from "./watched-repositories";

const { calls, state } = vi.hoisted(() => {
    return {
        calls: { disableWebhook: vi.fn(), enableWebhook: vi.fn(), unwatch: vi.fn(), watch: vi.fn() },
        state: {
            current: { data: undefined, isPending: false } as { data?: unknown; isError?: boolean; isPending: boolean },
            results: {} as Record<string, unknown>,
        },
    };
});

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    const text = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t: text };
        },
    };
});

vi.mock("@/lib/env", () => {
    return { default: { VITE_LUNORA_URL: "https://api.example" } };
});

// Like the real hook, every call owns its mutations: a result lands in the component that mutated.
vi.mock("../lib/use-watched", async () => {
    const { useState } = await import("react");

    const useMutation = (name: "disableWebhook" | "enableWebhook" | "unwatch" | "watch") => {
        const [data, setData] = useState<unknown>(undefined);

        return {
            data,
            isPending: false,
            mutate: (input: unknown, options?: { onSuccess?: (outcome: unknown) => void }) => {
                calls[name](input, options);

                const outcome = state.results[name];

                setData(outcome);
                options?.onSuccess?.(outcome);
            },
        };
    };

    return {
        useRefreshWatchedOnOpen: vi.fn(),
        useWatchedRepositories: () => state.current,
        useWatchMutations: () => {
            return {
                disableWebhook: useMutation("disableWebhook"),
                enableWebhook: useMutation("enableWebhook"),
                unwatch: useMutation("unwatch"),
                watch: useMutation("watch"),
            };
        },
    };
});

const WEBHOOK_URL = /api\.example\/source-control\/webhook\/w1/u;

const watched = (overrides: Record<string, unknown> = {}) => {
    return {
        checkedAt: 1_800_000_000_000,
        dirty: false,
        id: "w1",
        lastStatus: "ok",
        repository: "octo/hello",
        requested: [{ authorLogin: "alice", number: 7, title: "Fix it", updatedAt: 1, url: "https://x/7" }],
        webhook: { enabled: false, seenAt: 0 },
        ...overrides,
    };
};

beforeEach(() => {
    for (const call of Object.values(calls)) {
        call.mockClear();
    }

    state.results = { watch: { status: "ok" } };
    state.current = { data: { limit: 20, watched: [watched()] }, isPending: false };
});

describe("WatchedRepositories", () => {
    it("opens a request from the cached list", () => {
        const onSelect = vi.fn();

        render(<WatchedRepositories onSelect={onSelect} webhooks />);
        fireEvent.click(screen.getByText("Fix it"));

        expect(onSelect).toHaveBeenCalledWith("octo/hello", 7);
    });

    it("says so when the list cannot be loaded, instead of showing nothing", () => {
        state.current = { data: undefined, isError: true, isPending: false };

        render(<WatchedRepositories onSelect={vi.fn()} webhooks />);

        expect(screen.getByRole("alert").textContent).toBe("Your watched repositories could not be loaded.");
        expect(screen.queryByText("You are not watching any repository.")).toBeNull();
    });

    it("watches the typed repository and stops one by name", () => {
        render(<WatchedRepositories onSelect={vi.fn()} webhooks />);
        fireEvent.change(screen.getByLabelText("Repository to watch"), { target: { value: "octo/new" } });
        fireEvent.click(screen.getByText("Watch"));
        fireEvent.click(screen.getByLabelText("Stop watching octo/hello"));

        expect(calls.watch).toHaveBeenCalledWith({ repository: "octo/new" }, expect.anything());
        expect(calls.unwatch).toHaveBeenCalledWith({ repository: "octo/hello" }, undefined);
    });

    it("says why a repository was refused", () => {
        state.results.watch = { status: "limit" };

        render(<WatchedRepositories onSelect={vi.fn()} webhooks />);
        fireEvent.change(screen.getByLabelText("Repository to watch"), { target: { value: "octo/new" } });
        fireEvent.click(screen.getByText("Watch"));

        expect(screen.getByText("You are watching as many repositories as is allowed.")).toBeTruthy();
    });

    it("ties the refusal to the field, so a screen reader hears it there", () => {
        state.results.watch = { status: "invalid" };

        render(<WatchedRepositories onSelect={vi.fn()} webhooks />);

        const field = screen.getByLabelText("Repository to watch");

        fireEvent.change(field, { target: { value: "not a repo" } });
        fireEvent.click(screen.getByText("Watch"));

        const message = screen.getByRole("alert");

        expect(field.getAttribute("aria-invalid")).toBe("true");
        expect(field.getAttribute("aria-describedby")).toBe(message.id);
        expect(message.textContent).toBe("That is not a repository address.");
    });

    it("shows the secret in the row that issued it, once it arrives", () => {
        state.results.enableWebhook = { id: "w1", secret: "s3cret", status: "ok" };

        render(<WatchedRepositories onSelect={vi.fn()} webhooks />);

        expect(screen.queryByText("s3cret")).toBeNull();

        fireEvent.click(screen.getByText("Set up a webhook"));

        expect(screen.getByText("s3cret")).toBeTruthy();
        expect(screen.getByText(WEBHOOK_URL)).toBeTruthy();
    });

    it("never shows a secret for a row that only has a webhook, and offers to remove it", () => {
        state.current = { data: { limit: 20, watched: [watched({ webhook: { enabled: true, seenAt: 0 } })] }, isPending: false };

        render(<WatchedRepositories onSelect={vi.fn()} webhooks />);

        expect(screen.queryByText("s3cret")).toBeNull();
        expect(screen.getByText("Remove the webhook")).toBeTruthy();
    });

    it("offers no webhook where the host declares none", () => {
        render(<WatchedRepositories onSelect={vi.fn()} webhooks={false} />);

        expect(screen.queryByText("Set up a webhook")).toBeNull();
    });

    it("tells the person what is wrong with a repository it could not read", () => {
        state.current = { data: { limit: 20, watched: [watched({ lastStatus: "needs_reconnect" })] }, isPending: false };

        render(<WatchedRepositories onSelect={vi.fn()} webhooks />);

        expect(screen.getByText("Sign in to the host again to keep this fresh.")).toBeTruthy();
    });
});
