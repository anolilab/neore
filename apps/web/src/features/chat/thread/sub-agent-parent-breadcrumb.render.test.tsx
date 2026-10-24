// @vitest-environment jsdom

/**
 * The sub-agent parent breadcrumb: shown for a sub-agent child, hidden for a
 * root thread, and never carrying a parent title the viewer was not given.
 */

import { QueryClient, QueryClientProvider, skipToken } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { ElementType, ReactNode } from "react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

type Relationship = { branchType?: string; parentThreadId: string } | null;

const harness = vi.hoisted(() => {
    return {
        parent: null as { title?: string } | null,
        parentReads: [] as string[],
        relationship: null as Relationship,
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                agent: {
                    threads: {
                        getThreadRelationship: {
                            queryOptions: (args: unknown) => {
                                return { queryFn: args === skipToken ? skipToken : async () => harness.relationship, queryKey: ["relationship", args] };
                            },
                        },
                    },
                },
                chat: {
                    functions: {
                        getThread: {
                            queryOptions: (args: typeof skipToken | { threadId: string }) => {
                                return {
                                    queryFn:
                                        args === skipToken
                                            ? skipToken
                                            : async () => {
                                                  harness.parentReads.push(args.threadId);

                                                  return harness.parent;
                                              },
                                    queryKey: ["thread", args],
                                };
                            },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        Link: ({ children, params, to, ...rest }: { children: ReactNode; params: { threadId: string }; to: string }) =>
            createElement("a", { href: to.split("$threadId").join(params.threadId), ...rest }, children),
    };
});

// The real tooltip mounts its content only while open: render it inline so the full title is observable.
vi.mock("@neore/ui/components/tooltip", () => {
    return {
        Tooltip: ({ children }: { children: ReactNode }) => createElement("div", null, children),
        TooltipContent: ({ children }: { children: ReactNode }) => createElement("div", { "data-testid": "tooltip" }, children),
        TooltipTrigger: ({ children, render: element }: { children: ReactNode; render: { props: object; type: ElementType } }) =>
            createElement(element.type, element.props, children),
    };
});

const { default: SubAgentParentBreadcrumb } = await import("./sub-agent-parent-breadcrumb");

const LONG_TITLE = "A very long parent conversation title that the header has to truncate to fit";

const mount = (threadId: string | undefined = "child-1") => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    return render(createElement(QueryClientProvider, { client: queryClient }, createElement(SubAgentParentBreadcrumb, { threadId })));
};

const settle = async () => {
    await new Promise((resolve) => {
        setTimeout(resolve, 20);
    });
};

afterEach(() => {
    harness.parent = null;
    harness.parentReads = [];
    harness.relationship = null;
});

describe("sub-agent parent breadcrumb", () => {
    it("links a sub-agent child to its parent, with the full title in the tooltip", async () => {
        harness.relationship = { branchType: "subagent", parentThreadId: "parent-1" };
        harness.parent = { title: LONG_TITLE };
        mount();

        const link = await screen.findByRole("link", { name: LONG_TITLE });

        expect(link.getAttribute("href")).toBe("/chat/parent-1");
        expect(within(link).getByText(LONG_TITLE).className).toContain("truncate");
        expect(screen.getByTestId("tooltip").textContent).toBe(LONG_TITLE);
    });

    it("is hidden for a root thread", async () => {
        harness.parent = { title: "Should not be read" };
        const { container } = mount("root-1");

        await settle();

        expect(container.textContent).toBe("");
        expect(screen.queryByRole("navigation")).toBeNull();
        expect(harness.parentReads).toEqual([]);
    });

    it("is hidden for a branch or comparison child", async () => {
        harness.relationship = { branchType: "comparison", parentThreadId: "parent-1" };
        harness.parent = { title: "Comparison parent" };
        const { container } = mount();

        await settle();

        expect(container.textContent).toBe("");
        expect(screen.queryByRole("navigation")).toBeNull();
        expect(harness.parentReads).toEqual([]);
    });

    it("shows nothing when the parent read answers nobody", async () => {
        harness.relationship = { branchType: "subagent", parentThreadId: "parent-1" };
        harness.parent = null;
        const { container } = mount();

        await vi.waitFor(() => {
            expect(harness.parentReads).toEqual(["parent-1"]);
        });
        await settle();

        expect(container.textContent).toBe("");
        expect(screen.queryByRole("navigation")).toBeNull();
    });

    it("shows nothing for a locked parent, whose stub carries no title", async () => {
        harness.relationship = { branchType: "subagent", parentThreadId: "parent-1" };
        harness.parent = {};
        const { container } = mount();

        await vi.waitFor(() => {
            expect(harness.parentReads).toEqual(["parent-1"]);
        });
        await settle();

        expect(container.textContent).toBe("");
        expect(screen.queryByRole("navigation")).toBeNull();
    });

    it("never reads the parent when the relation is withheld from the viewer", async () => {
        // `getThreadRelationship` answers a non-owner with null, so the parent id never reaches the page.
        harness.relationship = null;
        harness.parent = { title: "Secret parent title" };
        const { container } = mount();

        await settle();

        expect(harness.parentReads).toEqual([]);
        expect(container.textContent).not.toContain("Secret parent title");
    });
});
