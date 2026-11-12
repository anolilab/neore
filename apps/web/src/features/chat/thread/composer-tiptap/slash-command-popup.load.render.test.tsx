/**
 * The "/" menu's prompts and skills: loaded when the composer is warm, so "/prompt" and "/skill" open with them. A load
 * that failed is tried again when the menu opens, only for what failed, and offline it fails at once instead of waiting
 * for the network to come back. Both follow the active organization, so a switch loads them again for the new one.
 */
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SlashCommandMatch } from "./extensions/slash-command";
import SlashCommandPopup from "./slash-command-popup";

const harness = vi.hoisted(() => {
    return { calls: { prompts: 0, skills: 0 }, organizationId: null as null | string, skillsFail: false };
});

vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: ReactNode }) => children,
        useLingui: () => {
            return { i18n: { _: (descriptor: { id: string }) => descriptor.id }, t: (strings: TemplateStringsArray) => strings.join("") };
        },
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                hooks: {
                    useSession: () => {
                        return { data: { session: { activeOrganizationId: harness.organizationId }, user: { id: "owner" } } };
                    },
                },
            };
        },
    };
});

vi.mock("@/components/model-picker/model-picker-popup-store", () => {
    return {
        useModelPickerPopupActions: () => {
            return { open: vi.fn() };
        },
    };
});

vi.mock("@/features/chat/compaction/use-compact-thread", () => {
    return {
        default: () => {
            return { compact: vi.fn(), isCompacting: false };
        },
    };
});

vi.mock("@/features/chat/context-reset/use-clear-context", () => {
    return {
        default: () => {
            return { clear: vi.fn(), isClearing: false };
        },
    };
});

vi.mock("@/lib/lunora/crpc", async () => {
    const { api } = await import("@neore/backend/api");
    const prompts = {
        mutationFn: async () => {
            harness.calls.prompts += 1;

            return [{ _id: "p1", content: "", name: "Saved prompt" }];
        },
    };
    const skills = {
        mutationFn: async () => {
            harness.calls.skills += 1;

            if (harness.skillsFail) {
                throw new Error("unavailable");
            }

            return harness.organizationId === null
                ? [{ _id: "s1", description: "Reviews code", name: "Code review", slug: "review" }]
                : [{ _id: "s2", description: "Writes release notes", name: "Release notes", slug: "release" }];
        },
    };

    return {
        useLunoraActionOptions: (reference: unknown) => (reference === api.skills.functions.getSkills ? skills : prompts),
    };
});

const RECT = new DOMRect(0, 400, 600, 0);

const skillMatch: SlashCommandMatch = { command: "skill", from: 1, query: "", startOffset: 0, text: "/skill ", to: 8, wholeDraft: true };

const popup = (client: QueryClient, match: SlashCommandMatch | null, warm: boolean) => (
    <QueryClientProvider client={client}>
        <SlashCommandPopup
            currentThreadId="a"
            editorRect={RECT}
            favoriteModelIds={[]}
            match={match}
            models={[]}
            onDismiss={() => {}}
            onReplace={() => {}}
            readDraft={() => ""}
            warm={warm}
        />
    </QueryClientProvider>
);

beforeEach(() => {
    harness.calls = { prompts: 0, skills: 0 };
    harness.organizationId = null;
    harness.skillsFail = false;
    Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
    vi.stubGlobal(
        "ResizeObserver",
        class {
            public disconnect = vi.fn();

            public observe = vi.fn();

            public unobserve = vi.fn();
        },
    );
});

afterEach(() => {
    onlineManager.setOnline(true);
});

describe("SlashCommandPopup prompts and skills", () => {
    it("tries a failed warm load again when the menu opens, for what failed only", async () => {
        expect.hasAssertions();

        const client = new QueryClient();

        harness.skillsFail = true;

        const view = render(popup(client, null, true));

        await waitFor(() => {
            expect(harness.calls).toStrictEqual({ prompts: 1, skills: 1 });
        });

        harness.skillsFail = false;
        view.rerender(popup(client, skillMatch, true));

        expect(await screen.findByText("Code review")).toBeTruthy();
        expect(harness.calls).toStrictEqual({ prompts: 1, skills: 2 });
    });

    it("does not load again once both have loaded", async () => {
        expect.hasAssertions();

        const client = new QueryClient();
        const view = render(popup(client, null, true));

        await waitFor(() => {
            expect(harness.calls).toStrictEqual({ prompts: 1, skills: 1 });
        });

        view.rerender(popup(client, skillMatch, true));
        await screen.findByText("Code review");
        view.rerender(popup(client, null, true));
        view.rerender(popup(client, skillMatch, true));

        expect(harness.calls).toStrictEqual({ prompts: 1, skills: 1 });
    });

    it("drops what it loaded when the active organization changes, and loads the new one's", async () => {
        expect.hasAssertions();

        const client = new QueryClient();
        const view = render(popup(client, null, true));

        await waitFor(() => {
            expect(harness.calls).toStrictEqual({ prompts: 1, skills: 1 });
        });

        harness.organizationId = "org-b";
        view.rerender(popup(client, skillMatch, true));

        expect(await screen.findByText("Release notes")).toBeTruthy();
        expect(screen.queryByText("Code review")).toBeNull();
        expect(harness.calls).toStrictEqual({ prompts: 2, skills: 2 });
    });

    it("runs the load while offline instead of holding it for reconnect", async () => {
        expect.hasAssertions();

        const client = new QueryClient();

        act(() => {
            onlineManager.setOnline(false);
        });
        render(popup(client, null, true));

        await waitFor(() => {
            expect(harness.calls).toStrictEqual({ prompts: 1, skills: 1 });
        });
    });
});
