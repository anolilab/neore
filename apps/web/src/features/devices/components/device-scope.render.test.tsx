/**
 * The device scope picker: a project already in the scope but outside the loaded page of projects can still be
 * taken out of the scope.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import DeviceScope from "./device-scope";

const { projectList, setDeviceProjectScope } = vi.hoisted(() => {
    return {
        projectList: { current: { isAnswered: true, projects: [{ _id: "p-listed", projectType: "chat", title: "Listed" }] as unknown[] } },
        setDeviceProjectScope: vi.fn(async (_variables: unknown) => null),
    };
});

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn() } };
});

vi.mock("@/features/projects/hooks/use-projects", () => {
    return {
        useProjectList: () => projectList.current,
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                devices: {
                    functions: {
                        setDeviceProjectScope: {
                            mutationOptions: () => {
                                return { mutationFn: setDeviceProjectScope };
                            },
                        },
                    },
                },
            };
        },
    };
});

describe("<DeviceScope>", () => {
    it("lets an in-scope project outside the loaded list be removed from the scope", async () => {
        render(
            <QueryClientProvider client={new QueryClient()}>
                <DeviceScope deviceId="d1" projectIds={["p-listed", "p-old"]} />
            </QueryClientProvider>,
        );

        const unlisted = screen.getByRole("checkbox", { name: "An older project not listed here" });

        expect(unlisted.getAttribute("aria-checked")).toBe("true");

        fireEvent.click(unlisted);

        await waitFor(() => {
            expect(setDeviceProjectScope.mock.calls[0]?.[0]).toStrictEqual({ deviceId: "d1", scope: { kind: "projects", projectIds: ["p-listed"] } });
        });
    });

    it("does not claim there are no projects while the list has not been answered", () => {
        projectList.current = { isAnswered: false, projects: [] };

        render(
            <QueryClientProvider client={new QueryClient()}>
                <DeviceScope deviceId="d1" projectIds={[]} />
            </QueryClientProvider>,
        );

        expect(screen.queryByText("You have no projects yet.")).toBeNull();
        expect(screen.getByText("Loading your projects…")).toBeTruthy();
    });
});
