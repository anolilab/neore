// @vitest-environment jsdom

/** The sidebar search: one server query per typing pause, and the last answer stays on screen until the next one arrives. */
import { QueryClient, QueryClientProvider, skipToken } from "@tanstack/react-query";
// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest runs without globals, so nothing else cleans up between tests
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useThreadListUIStore } from "./stores/thread-list-ui-store";

/** What the list was given on each render: the query it searches for and the thread results it has. */
const listRenders = vi.hoisted(() => [] as { searchQuery: string; threadSearchResults: unknown }[]);

/** The thread searches the server was asked, each with the answer the test hands back. */
const searches = vi.hoisted(() => [] as { query: string; respond: (titles: string[]) => void }[]);

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray) => strings[0] };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        useLocation: () => {
            return { pathname: "/chat" };
        },
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    const organization = { data: null };

    return {
        useAuth: () => {
            return { hooks: { useActiveOrganization: () => organization } };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    const pageOf = (titles: string[]) => {
        return {
            page: titles.map((title) => {
                return { _id: title, title };
            }),
        };
    };
    const ask = (query: string) =>
        new Promise((resolve) => {
            searches.push({ query, respond: (titles) => resolve(pageOf(titles)) });
        });
    const searchOptions = (name: string) => {
        return {
            queryOptions: (args: typeof skipToken | { searchQuery: string }) => {
                if (args === skipToken) {
                    return { queryFn: skipToken, queryKey: [name, "skip"] };
                }

                return {
                    queryFn: () => ask(args.searchQuery),
                    queryKey: [name, args],
                };
            },
        };
    };

    return {
        useCRPC: () => {
            return {
                chat: {
                    composite: {
                        getThreadListData: {
                            queryOptions: () => {
                                return { queryFn: skipToken, queryKey: ["threadList"] };
                            },
                        },
                    },
                    functions: { searchMessages: searchOptions("searchMessages"), searchThreads: searchOptions("searchThreads") },
                },
            };
        },
        useLunoraAuth: () => {
            return { isAuthenticated: true, isLoading: false };
        },
    };
});

vi.mock("./hooks/use-thread-list-cache", () => {
    return { useThreadListPlaceholder: () => undefined };
});

vi.mock("@/features/chat/tags/manage-thread-tags-dialog", () => {
    return { default: () => null };
});

vi.mock("./hierarchical-thread-list", () => {
    return {
        default: (props: { searchQuery: string; threadSearchResults: unknown }) => {
            listRenders.push({ searchQuery: props.searchQuery, threadSearchResults: props.threadSearchResults });

            return null;
        },
    };
});

const { default: ThreadList } = await import("./thread-list");

/** A quick typist's gap between keys, and a pause long enough for any search debounce. */
const KEY_GAP_MS = 40;
const PAUSE_MS = 1000;

/** Types `text` one character at a time, faster than the debounce. */
const typeQuickly = (text: string, from = "") => {
    for (let index = 1; index <= text.length; index += 1) {
        act(() => {
            useThreadListUIStore.getState().setSearchQuery(from + text.slice(0, index));
            vi.advanceTimersByTime(KEY_GAP_MS);
        });
    }
};

const settle = async () => {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(PAUSE_MS);
    });
};

beforeEach(() => {
    vi.useFakeTimers();
    listRenders.length = 0;
    searches.length = 0;
    useThreadListUIStore.getState().reset();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

const renderList = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
        <QueryClientProvider client={queryClient}>
            <ThreadList />
        </QueryClientProvider>,
    );
};

/** Answers every search asked so far, each with a result named after its query. */
const answerAll = async () => {
    await act(async () => {
        for (const search of searches) {
            search.respond([`${search.query} result`]);
        }

        await vi.advanceTimersByTimeAsync(0);
    });
};

describe("the sidebar search", () => {
    it("asks the server once for five characters typed quickly", async () => {
        renderList();

        typeQuickly("hello");
        await settle();

        expect(searches.map((search) => search.query)).toStrictEqual(["hello"]);
    });

    it("never gives the list a search without an answer to show: every thread until the first, then the last answer until the next", async () => {
        renderList();

        typeQuickly("hello");
        await settle();
        await answerAll();

        // A second burst: the first answer stays on screen until the second arrives.
        typeQuickly(" there", "hello");
        await settle();
        await answerAll();

        expect(listRenders.filter((props) => props.searchQuery !== "" && props.threadSearchResults === undefined)).toStrictEqual([]);
        expect(listRenders.at(-1)).toMatchObject({ searchQuery: "hello there", threadSearchResults: { page: [{ title: "hello there result" }] } });
    });
});
