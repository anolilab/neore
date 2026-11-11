import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import AuthUIProviderTanstack from "./auth-ui-provider-tanstack";

const provider = vi.hoisted(() => {
    return {
        mutators: undefined as { setActiveSession: (parameters: { sessionToken: string }) => Promise<unknown> } | undefined,
        session: { data: { user: { id: "alice" } } },
    };
});

vi.mock("@/lib/auth/client", () => {
    return { authClient: { $store: { atoms: { session: { get: () => provider.session } } } } };
});

vi.mock("./use-tanstack-options", () => {
    return {
        default: () => {
            return { hooks: {}, mutators: { setActiveSession: async () => {} }, onSessionChange: async () => {}, optimistic: true };
        },
    };
});
vi.mock("../auth-ui-provider", () => {
    return {
        AuthUIProvider: ({ mutators }: { mutators: typeof provider.mutators }) => {
            provider.mutators = mutators;

            return null;
        },
    };
});

describe("switching accounts", () => {
    it("tells both phases who is leaving, read from the session before the switch, with no composer shown on this page load", async () => {
        const onSessionSwitch = vi.fn();

        render(
            <AuthUIProviderTanstack authClient={{} as never} onSessionSwitch={onSessionSwitch}>
                {null}
            </AuthUIProviderTanstack>,
        );

        await act(async () => {
            // The next account's session is read before "after" runs.
            onSessionSwitch.mockImplementationOnce(() => {
                provider.session.data.user.id = "bob";
            });
            await provider.mutators?.setActiveSession({ sessionToken: "bob-session" });
        });

        expect(onSessionSwitch.mock.calls).toStrictEqual([
            ["before", "alice"],
            ["after", "alice"],
        ]);
    });
});
