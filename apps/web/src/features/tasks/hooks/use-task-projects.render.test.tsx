import { QueryClient, QueryClientProvider, skipToken } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import useTaskProjects from "./use-task-projects";

const OWN = { _id: "p_own", title: "Mine", userId: "me" };
const TEAMMATE = { _id: "p_teammate", organizationId: "org", title: "Theirs", userId: "teammate" };
const SHARED = { _id: "p_shared", organizationId: "org", title: "Nobody's" };

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                projects: {
                    functions: {
                        getProject: {
                            queryOptions: () => {
                                return { queryFn: skipToken, queryKey: ["getProject"] };
                            },
                        },
                        listProjects: {
                            queryOptions: (args: typeof skipToken | { organizationId?: string }) =>
                                args === skipToken
                                    ? { queryFn: skipToken, queryKey: ["listProjects", "skipped"] }
                                    : {
                                          queryFn: async () => {
                                              return { continueCursor: "", isDone: true, page: args.organizationId ? [TEAMMATE, SHARED] : [OWN] };
                                          },
                                          queryKey: ["listProjects", args.organizationId ?? "own"],
                                      },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return { authClient: {} };
        },
    };
});

vi.mock("@/features/auth/hooks/organization-management", () => {
    return {
        useActiveOrganization: () => {
            return { data: { id: "org" } };
        },
    };
});

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;

describe("useTaskProjects", () => {
    it("files tasks only in projects a member may write, but offers every readable project's repositories", async () => {
        const { result } = renderHook(() => useTaskProjects(""), { wrapper });

        await waitFor(() => expect(result.current.readableProjects).toHaveLength(3));

        expect(result.current.projects.map((project) => project._id)).toStrictEqual(["p_own", "p_shared"]);
        expect(result.current.readableProjects.map((project) => project._id)).toStrictEqual(["p_own", "p_teammate", "p_shared"]);
    });
});
