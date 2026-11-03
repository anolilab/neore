/**
 * The first-run setup checklist: state follows the device list, and skip / resume write the user's settings.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import SetupChecklist from "./setup-checklist";

const { devices, settings, updateLatest } = vi.hoisted(() => {
    return {
        devices: { current: [] as unknown[] },
        settings: { current: { setupStepsSkipped: undefined as string[] | undefined } },
        updateLatest: vi.fn(async (_build: unknown) => {}),
    };
});

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

vi.mock("@/components/settings/settings-card", () => {
    return {
        default: ({ children, title }: { children: React.ReactNode; title: string }) => <section aria-label={title}>{children}</section>,
    };
});

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUpdateUserSettings: () => {
            return { updateLatest };
        },
        useUserSettings: () => {
            return { data: settings.current };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                devices: {
                    functions: {
                        listDevices: {
                            queryOptions: () => {
                                return { queryFn: async () => devices.current, queryKey: ["listDevices"] };
                            },
                        },
                    },
                },
            };
        },
    };
});

const renderChecklist = () =>
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <SetupChecklist />
        </QueryClientProvider>,
    );

describe("<SetupChecklist>", () => {
    it("shows every step to do and writes a skip", async () => {
        devices.current = [];
        settings.current = { setupStepsSkipped: undefined };
        renderChecklist();

        expect(await screen.findAllByText("(To do)")).toHaveLength(3);
        fireEvent.click(screen.getByRole("button", { name: /Skip.*Add an SSH server/ }));
        expect(updateLatest).toHaveBeenCalledTimes(1);

        const build = updateLatest.mock.calls[0]?.[0] as (current: { setupStepsSkipped?: string[] } | undefined) => unknown;

        expect(build(undefined)).toEqual({ setupStepsSkipped: ["ssh"] });
    });

    it("offers resume for a skipped step and drops it once its state appears", async () => {
        devices.current = [];
        settings.current = { setupStepsSkipped: ["agent"] };
        const { unmount } = renderChecklist();

        expect(await screen.findByRole("button", { name: /Resume.*Install a coding agent/ })).toBeTruthy();
        unmount();

        devices.current = [{ acpOffers: [{}] }];
        renderChecklist();
        expect((await screen.findAllByText("(Done)")).length).toBe(2);
        expect(screen.queryByRole("button", { name: /Resume/ })).toBeNull();
    });
});
