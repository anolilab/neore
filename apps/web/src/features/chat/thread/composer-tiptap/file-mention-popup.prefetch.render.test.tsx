/**
 * The "@" menu opens with its data: focusing the composer prefetches the menu's reads under the menu's own query keys,
 * so opening it renders from the cache and fetches nothing. The menu lists the current chat's project first, and its
 * motion is short and off under reduced motion. `crpc` is stood in for with keys shaped like the real ones.
 */
import { QueryClient, QueryClientProvider, skipToken } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return {
        calls: { files: 0, search: 0, threads: 0 },
        files: [] as unknown[],
        threads: [] as unknown[],
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@/hooks/use-after-first-paint", () => {
    return { default: () => true };
});

vi.mock("@/features/chat/group/use-group-chat", () => {
    return { useGroupChat: () => undefined };
});

vi.mock("@/features/chat/group/speaker-label", () => {
    return { SpeakerAvatar: () => null };
});

vi.mock("@/lib/lunora/crpc", () => {
    const leaf = (path: string, counter: keyof typeof harness.calls, answer: () => unknown) => {
        return {
            queryOptions: (args: unknown) => {
                return {
                    queryFn:
                        args === skipToken
                            ? skipToken
                            : async () => {
                                  harness.calls[counter] += 1;

                                  return answer();
                              },
                    queryKey: ["lunora", path, args === skipToken ? undefined : JSON.stringify(args), null],
                    staleTime: Infinity,
                };
            },
        };
    };
    const crpc = {
        chat: {
            composite: {
                getThreadListData: leaf("chat_composite:getThreadListData", "threads", () => {
                    return { tags: [], threads: { isDone: true, page: harness.threads } };
                }),
            },
            functions: {
                searchThreads: leaf("chat_functions:searchThreads", "search", () => {
                    return { isDone: true, page: [] };
                }),
            },
        },
        vault: { functions: { getAttachmentsForUser: leaf("vault_functions:getAttachmentsForUser", "files", () => harness.files) } },
    };

    return {
        useCRPC: () => crpc,
        useLunoraAuth: () => {
            return { isAuthenticated: true, isLoading: false };
        },
    };
});

const { default: FileMentionPopup } = await import("./file-mention-popup");
const { POPUP_ENTER_MOTION } = await import("./popup-motion");
const { default: useMentionPrefetch } = await import("./use-mention-prefetch");

const fakeEditor = () => {
    const listeners = new Set<() => void>();

    return {
        editor: {
            isFocused: false,
            off: (_event: string, listener: () => void) => listeners.delete(listener),
            on: (_event: string, listener: () => void) => listeners.add(listener),
        } as unknown as Editor,
        focus: () => {
            for (const listener of listeners) {
                listener();
            }
        },
    };
};

const thread = (id: string, title: string, updatedAt: number, projectId?: string) => {
    return { _creationTime: updatedAt, _id: id, projectId, title, updatedAt };
};

const file = (id: string, fileName: string, chatId: string) => {
    return { _id: id, chatId, fileName, fileSize: 1024, fileType: "text/plain" };
};

// The scroll area under the list needs a constructible observer and jsdom lacks getAnimations; the setup's mock is an
// arrow function and is re-installed before every test.
beforeEach(() => {
    Element.prototype.getAnimations = () => [];
    vi.stubGlobal(
        "ResizeObserver",
        class {
            disconnect = vi.fn();

            observe = vi.fn();

            unobserve = vi.fn();
        },
    );
});

const setup = () => {
    harness.calls = { files: 0, search: 0, threads: 0 };
    harness.threads = [
        thread("current", "Current chat", 50, "project-a"),
        thread("sibling", "Sibling chat", 10, "project-a"),
        thread("elsewhere", "Elsewhere chat", 40),
    ];
    harness.files = [file("file-elsewhere", "elsewhere.txt", "elsewhere"), file("file-sibling", "sibling.txt", "sibling")];

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

    return { queryClient, wrapper };
};

const openPopup = (wrapper: (props: { children: ReactNode }) => ReactNode) =>
    render(
        <FileMentionPopup
            currentThreadId="current"
            editorRect={new DOMRect(0, 0, 100, 20)}
            match={{ from: 0, query: "", to: 1 }}
            onDismiss={() => {}}
            onReplace={() => {}}
            onSelectChat={() => {}}
        />,
        { wrapper },
    );

describe("FileMentionPopup prefetch", () => {
    it("prefetches the menu's reads once the composer is focused, then opens from the cache", async () => {
        expect.hasAssertions();

        const { wrapper } = setup();
        const { editor, focus } = fakeEditor();
        const { result } = renderHook(() => useMentionPrefetch(editor, true), { wrapper });

        expect(harness.calls.files).toBe(0);
        expect(result.current).toBe(false);

        act(focus);
        act(focus);

        await waitFor(() => {
            expect(harness.calls).toStrictEqual({ files: 1, search: 0, threads: 1 });
        });
        expect(result.current).toBe(true);

        openPopup(wrapper);

        // Rendered on the first paint of the menu, from the cache.
        expect(screen.getByText("sibling.txt")).toBeTruthy();
        expect(screen.getByText("Elsewhere chat")).toBeTruthy();
        expect(harness.calls).toStrictEqual({ files: 1, search: 0, threads: 1 });
    });

    it("prefetches nothing while suggestions are off", async () => {
        expect.hasAssertions();

        const { wrapper } = setup();
        const { editor, focus } = fakeEditor();

        renderHook(() => useMentionPrefetch(editor, false), { wrapper });
        act(focus);

        await Promise.resolve();
        expect(harness.calls).toStrictEqual({ files: 0, search: 0, threads: 0 });
    });
});

describe("FileMentionPopup project ranking", () => {
    it("lists the current project's files and chats first, under their own label", async () => {
        expect.hasAssertions();

        const { wrapper } = setup();

        openPopup(wrapper);

        const projectGroup = await screen.findByRole("group", { name: "In this project" });

        expect(within(projectGroup).getByText("sibling.txt")).toBeTruthy();
        expect(within(projectGroup).getByText("Sibling chat")).toBeTruthy();
        expect(within(projectGroup).queryByText("elsewhere.txt")).toBeNull();

        const options = screen.getAllByRole("option").map((option) => option.textContent);
        const order = ["sibling.txt", "Sibling chat", "elsewhere.txt", "Elsewhere chat"].map((name) => options.findIndex((text) => text?.includes(name)));

        expect(order).toStrictEqual([...order].toSorted((a, b) => a - b));
        expect(order[0]).toBeGreaterThan(0);
    });

    it("has no project section when the current chat has no project", async () => {
        expect.hasAssertions();

        const { wrapper } = setup();

        render(
            <FileMentionPopup
                currentThreadId="elsewhere"
                editorRect={new DOMRect(0, 0, 100, 20)}
                match={{ from: 0, query: "", to: 1 }}
                onDismiss={() => {}}
                onReplace={() => {}}
                onSelectChat={() => {}}
            />,
            { wrapper },
        );

        await screen.findByText("sibling.txt");
        expect(screen.queryByText("In this project")).toBeNull();
    });
});

describe("FileMentionPopup motion", () => {
    it("enters in 100 ms, highlights rows in 75 ms, and drops both under reduced motion", async () => {
        expect.hasAssertions();

        const { wrapper } = setup();

        openPopup(wrapper);

        const [option] = await screen.findAllByRole("option");
        const enter = POPUP_ENTER_MOTION.split(" ");

        // The panel's own classes are not reachable through roles; every popup takes them from this one constant.
        expect(enter).toStrictEqual(expect.arrayContaining(["animate-in", "duration-100", "motion-reduce:animate-none"]));
        expect(option?.className.split(" ")).toStrictEqual(expect.arrayContaining(["transition-colors", "duration-75", "motion-reduce:transition-none"]));
    });
});
