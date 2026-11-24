// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest runs without globals, so nothing else cleans up between tests
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ImpersonationState } from "../hooks/use-is-impersonating";
import ChangedByAdminMark from "./changed-by-admin-mark";

const state = vi.hoisted(() => {
    return { session: "self" as ImpersonationState };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn(), success: vi.fn() } };
});

vi.mock("@/features/admin/hooks/use-is-impersonating", () => {
    return { useImpersonationState: () => state.session };
});

afterEach(() => {
    cleanup();
    state.session = "self";
});

describe("the changed-by-an-admin mark", () => {
    it("names the field on its button, and keeps it as the person's on click", async () => {
        const onKeep = vi.fn(async () => null);

        render(<ChangedByAdminMark fieldLabel="Helper" onKeep={onKeep} />);

        expect(screen.getByText("Changed by an admin")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Keep as mine: Helper" }));

        await waitFor(() => {
            expect(onKeep).toHaveBeenCalledTimes(1);
        });
    });

    it.each<ImpersonationState>(["impersonating", "unknown"])("shows the badge but no button while the session is %s", (session) => {
        state.session = session;
        render(<ChangedByAdminMark fieldLabel="Helper" onKeep={vi.fn()} />);

        expect(screen.getByText("Changed by an admin")).toBeTruthy();
        expect(screen.queryByRole("button")).toBeNull();
    });
});
