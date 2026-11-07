// @vitest-environment jsdom

import type { ToolPart } from "@neore/chat-ui/types";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import SubAgentToolView from "./sub-agent-tool-view";

const state = vi.hoisted(() => {
    return {
        approvals: [] as Record<string, unknown>[],
        listArgs: [] as unknown[],
        mutate: vi.fn(),
        run: null as Record<string, unknown> | null,
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) => {
                    if (typeof strings === "string") {
                        return strings;
                    }

                    return strings.map((chunk, index) => `${chunk}${String(values[index] ?? "")}`).join("");
                },
            };
        },
    };
});
vi.mock("@tanstack/react-query", () => {
    return {
        skipToken: Symbol("skip"),
        useMutation: () => {
            return { isPending: false, mutate: state.mutate };
        },
        useQuery: (options: { queryKey: string[] }) => {
            return { data: options.queryKey[0] === "approvals" ? state.approvals : state.run, isPending: false };
        },
    };
});
vi.mock("@tanstack/react-router", () => {
    return { Link: ({ children }: { children: unknown }) => children };
});
vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                hooks: {
                    useSession: () => {
                        return { data: { user: { id: "owner" } } };
                    },
                },
            };
        },
    };
});
vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatThread: () => {
            return { thread: { userId: "owner" }, threadId: "parent-1" };
        },
    };
});
vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                chat: {
                    tool_permissions: {
                        respondToToolApproval: {
                            mutationOptions: () => {
                                return {};
                            },
                        },
                    },
                },
                sub_agents: {
                    functions: {
                        cancelRun: {
                            mutationOptions: () => {
                                return {};
                            },
                        },
                        getRunByToolCall: {
                            queryOptions: () => {
                                return { queryKey: ["run"] };
                            },
                        },
                        listSubAgentApprovals: {
                            queryOptions: (args: unknown) => {
                                state.listArgs.push(args);

                                return { queryKey: ["approvals"] };
                            },
                        },
                    },
                },
            };
        },
    };
});
vi.mock("@/lib/toast", () => {
    return { showError: vi.fn() };
});

vi.mock("@neore/client-runtime", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("@neore/client-runtime")>()),
        // Each chat has its own proof: the parent's reads the list, the child's answers its request.
        useUnlockProof: (threadId: string | undefined) => ({ "child-1": "proof-child", "parent-1": "proof-1" })[threadId ?? ""],
    };
});

const part = { input: { task: "Tidy up" }, state: "output-available", toolCallId: "call-1", type: "tool-delegateToSubAgent" } as unknown as ToolPart;

const RUN = { _id: "run-1", childThreadId: "child-1", completedAt: null, createdAt: 0, depth: 1, error: null, result: null, task: "Tidy up" };

const WANTS_TO_RUN = /wants to run "mcp_Files__delete"/u;
const ALWAYS_ALLOW = /Always allow/u;
const FOR_AN_HOUR = /for 1 hour/u;
const OTHER_TOOL = /webSearch/u;
const CUT_NOTICE = /500 more characters not shown; approving runs the whole call/u;
const EXPIRED = /request for approval was not answered in time/u;

afterEach(() => {
    state.approvals = [];
    state.listArgs = [];
    state.mutate.mockReset();
    state.run = null;
});

describe("sub-agent card", () => {
    it("shows a waiting child's request, answered on the child's own thread", () => {
        state.run = { ...RUN, status: "awaiting" };
        state.approvals = [
            {
                approvalId: "approval-1",
                childThreadId: "child-1",
                input: '{"path":"/tmp/old.txt"}',
                omittedCharacters: 0,
                runId: "run-1",
                skillSlug: null,
                task: "Tidy up",
                toolName: "mcp_Files__delete",
            },
            {
                approvalId: "approval-other",
                childThreadId: "child-2",
                input: "{}",
                omittedCharacters: 0,
                runId: "run-2",
                skillSlug: null,
                task: "Other",
                toolName: "webSearch",
            },
        ];

        render(<SubAgentToolView part={part} />);

        // The parent may be locked: the list is asked with the owner's unlock proof for it.
        expect(state.listArgs).toStrictEqual([{ parentThreadId: "parent-1", unlockProof: "proof-1" }]);
        expect(screen.getByText(WANTS_TO_RUN)).toBeTruthy();
        // Another child's request belongs on that child's card.
        expect(screen.queryByText(OTHER_TOOL)).toBeNull();
        expect(screen.getByRole("button", { name: ALWAYS_ALLOW })).toBeTruthy();
        // A sub-agent's run inherits no time-boxed allow, so the card offers none.
        expect(screen.queryByRole("button", { name: FOR_AN_HOUR })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: ALWAYS_ALLOW }));

        // Answered with the child's proof, so a locked child's request can be answered once its owner unlocks it.
        expect(state.mutate).toHaveBeenCalledWith(
            { approvalId: "approval-1", decision: "always", threadId: "child-1", unlockProof: "proof-child" },
            expect.anything(),
        );
    });

    it("says in the reader's language that a cut preview leaves part of the call out", () => {
        state.run = { ...RUN, status: "awaiting" };
        state.approvals = [
            {
                approvalId: "approval-1",
                childThreadId: "child-1",
                input: "x".repeat(10),
                omittedCharacters: 500,
                runId: "run-1",
                server: null,
                skillSlug: null,
                task: "Tidy up",
                toolName: "mcp_Files__delete",
            },
        ];

        render(<SubAgentToolView part={part} />);

        expect(screen.getByText(CUT_NOTICE)).toBeTruthy();
    });

    it("words an expired request from its code, not the stored English error", () => {
        state.run = { ...RUN, error: "stored text", errorCode: "approval-expired", status: "failed" };

        render(<SubAgentToolView part={part} />);

        expect(screen.getByText(EXPIRED)).toBeTruthy();
        expect(screen.queryByText("stored text")).toBeNull();
    });

    it("reads no approvals while the child is working", () => {
        state.run = { ...RUN, status: "running" };

        render(<SubAgentToolView part={part} />);

        expect(state.listArgs).toStrictEqual([]);
        expect(screen.queryByText(WANTS_TO_RUN)).toBeNull();
    });
});
