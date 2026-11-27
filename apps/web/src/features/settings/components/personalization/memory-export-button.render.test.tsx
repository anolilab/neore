/* eslint-disable testing-library/no-node-access -- focus placement (document.activeElement) is what this test asserts */

/**
 * `<MemoryExportButton>`: a click downloads the server's Markdown as a `.md` file, the button is busy (and keeps focus)
 * meanwhile, a failure is said next to it, and an answer that arrives after another account signed in is never saved.
 */
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MemoryExportButton from "./memory-export-button";

const harness = vi.hoisted(() => {
    return { exportMemories: vi.fn(), userId: "user-1" as string | undefined };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

// The session store, read when the answer arrives: `userId` is whoever is signed in at that moment.
vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                authClient: {
                    $store: {
                        atoms: {
                            session: {
                                get: () => {
                                    return { data: harness.userId === undefined ? null : { user: { id: harness.userId } } };
                                },
                            },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useLunoraActionOptions: () => {
            return { mutationFn: harness.exportMemories };
        },
    };
});

const queryClient = (): QueryClient => new QueryClient({ defaultOptions: { mutations: { retry: false } } });

const renderButton = (client: QueryClient = queryClient()) =>
    render(
        <QueryClientProvider client={client}>
            <MemoryExportButton />
        </QueryClientProvider>,
    );

describe("MemoryExportButton", () => {
    let blobs: Blob[];
    let click: ReturnType<typeof vi.spyOn>;
    let revoke: ReturnType<typeof vi.fn>;
    /** How many URLs were revoked when each link was clicked. */
    let revokedAtClick: number[];
    /** The links clicked: the spy records each call's `this`. */
    const clicks = (): HTMLAnchorElement[] => click.mock.contexts as HTMLAnchorElement[];

    beforeEach(() => {
        blobs = [];
        revoke = vi.fn();
        revokedAtClick = [];
        vi.stubGlobal("URL", {
            ...URL,
            createObjectURL: (blob: Blob) => {
                blobs.push(blob);

                return "blob:memories";
            },
            revokeObjectURL: revoke,
        });
        click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
            revokedAtClick.push(revoke.mock.calls.length);
        });
    });

    afterEach(() => {
        harness.userId = "user-1";
        onlineManager.setOnline(true);
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        harness.exportMemories.mockReset();
    });

    it("downloads the Markdown as a .md file", async () => {
        harness.exportMemories.mockResolvedValue({ count: 1, day: "2026-03-02", markdown: "# Your memories\n", truncated: false });
        renderButton();

        fireEvent.click(screen.getByRole("button", { name: "Download memories (Markdown)" }));

        await waitFor(() => {
            expect(clicks()).toHaveLength(1);
        });
        expect(clicks()[0]?.download).toBe("memories-2026-03-02.md");
        expect(clicks()[0]?.getAttribute("href")).toBe("blob:memories");
        expect(await blobs[0]?.text()).toBe("# Your memories\n");
        expect(blobs[0]?.type).toBe("text/markdown;charset=utf-8");
        // Revoked only after the click, once the download has begun.
        expect(revokedAtClick).toStrictEqual([0]);
        await waitFor(() => {
            expect(revoke).toHaveBeenCalledWith("blob:memories");
        });
    });

    it("fails at once while offline instead of waiting for a connection", async () => {
        onlineManager.setOnline(false);
        harness.exportMemories.mockRejectedValue(new Error("Failed to fetch"));
        renderButton();

        fireEvent.click(screen.getByRole("button", { name: "Download memories (Markdown)" }));

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toContain("The download could not be prepared.");
    });

    it("is busy while the file is prepared, and says when it failed", async () => {
        let fail: (error: Error) => void = () => {};

        harness.exportMemories.mockReturnValue(
            // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- the app's TypeScript lib predates `Promise.withResolvers`
            new Promise((_resolve, reject) => {
                fail = reject;
            }),
        );
        renderButton();

        const button = screen.getByRole("button", { name: "Download memories (Markdown)" });

        button.focus();
        fireEvent.click(button);

        const busy = await screen.findByRole("button", { name: "Preparing your memories…" });

        expect(busy.getAttribute("aria-disabled")).toBe("true");
        expect(busy.getAttribute("aria-busy")).toBe("true");
        expect(document.activeElement).toBe(busy);
        expect(screen.getByRole("status").textContent).toBe("Preparing your memories…");

        fail(new Error("rate limited"));

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toContain("The download could not be prepared.");
        expect(screen.getByRole("button", { name: "Download memories (Markdown)" }).getAttribute("aria-describedby")).toBe(alert.id);
        expect(clicks()).toHaveLength(0);
    });

    /** Holds the action's answer until the test releases it. */
    const heldAnswer = (): ((value: unknown) => void) => {
        let answer: (value: unknown) => void = () => {};

        harness.exportMemories.mockReturnValue(
            // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- the app's TypeScript lib predates `Promise.withResolvers`
            new Promise((resolve) => {
                answer = resolve;
            }),
        );

        return (value) => {
            answer(value);
        };
    };

    const ANSWER = { count: 1, day: "2026-03-02", markdown: "# Your memories\n", truncated: false };

    it.each([
        ["another account signed in", "user-2"],
        ["the account signed out", undefined],
    ])("drops an answer that arrives after %s", async (_case, nextUserId) => {
        const answer = heldAnswer();

        renderButton();
        fireEvent.click(screen.getByRole("button", { name: "Download memories (Markdown)" }));
        await screen.findByRole("button", { name: "Preparing your memories…" });

        harness.userId = nextUserId;
        answer(ANSWER);

        await screen.findByRole("button", { name: "Download memories (Markdown)" });
        expect(clicks()).toHaveLength(0);
        expect(blobs).toHaveLength(0);
    });

    it("saves nothing when the button left the page before the answer", async () => {
        const answer = heldAnswer();
        const { unmount } = renderButton();

        fireEvent.click(screen.getByRole("button", { name: "Download memories (Markdown)" }));
        await screen.findByRole("button", { name: "Preparing your memories…" });

        unmount();
        // `act` lets the answer's promise chain run to the end before the assertions.
        await act(async () => {
            answer(ANSWER);
        });

        expect(clicks()).toHaveLength(0);
        expect(blobs).toHaveLength(0);
    });
});
