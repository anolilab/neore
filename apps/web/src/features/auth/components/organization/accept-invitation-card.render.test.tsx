/**
 * `<AcceptInvitationCard>`: an invitation is accepted or rejected by its id, a dead
 * link (missing, answered, or expired) is reported and left, and a refused accept
 * leaves the visitor on the card to try again.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Invitation = {
    expiresAt: Date;
    id: string;
    organizationId: string;
    organizationName: string;
    organizationSlug: string;
    role: string;
    status: string;
};

const harness = vi.hoisted(() => {
    return {
        acceptInvitation: vi.fn(),
        invitation: undefined as Invitation | null | undefined,
        invitationId: "inv_1" as string | undefined,
        rejectInvitation: vi.fn(),
        replace: vi.fn(),
        toast: vi.fn(),
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        useParams: () => (harness.invitationId === undefined ? {} : { invitationId: harness.invitationId }),
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                authClient: { organization: { acceptInvitation: harness.acceptInvitation, rejectInvitation: harness.rejectInvitation } },
                organization: null,
                redirectTo: "/chat",
                replace: harness.replace,
                toast: harness.toast,
            };
        },
    };
});

vi.mock("@/features/auth/hooks/session-user-management", () => {
    return {
        useSession: () => {
            return { data: { session: {}, user: { id: "user_1" } } };
        },
    };
});

vi.mock("@/features/auth/hooks/organization-management", () => {
    return {
        useInvitation: () => {
            return { data: harness.invitation, isPending: false };
        },
    };
});

vi.mock("@/features/auth/hooks/use-authenticate", () => {
    return {
        default: () => {
            return {};
        },
    };
});

const { default: AcceptInvitationCard } = await import("./accept-invitation-card");

const FUTURE = new Date(Date.now() + 86_400_000);
const PAST = new Date(Date.now() - 86_400_000);

const pendingInvitation = (overrides: Partial<Invitation> = {}): Invitation => {
    return {
        expiresAt: FUTURE,
        id: "inv_1",
        organizationId: "org_1",
        organizationName: "Acme",
        organizationSlug: "acme",
        role: "member",
        status: "pending",
        ...overrides,
    };
};

const accept = () => screen.getByRole("button", { name: "Accept" });
const reject = () => screen.getByRole("button", { name: "Reject" });

beforeEach(() => {
    harness.invitation = pendingInvitation();
    harness.invitationId = "inv_1";
    harness.acceptInvitation.mockResolvedValue({});
    harness.rejectInvitation.mockResolvedValue({});
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("AcceptInvitationCard", () => {
    it("shows the organization and the role the invitation offers", async () => {
        render(<AcceptInvitationCard />);

        expect(await screen.findByText("Acme")).toBeTruthy();
        expect(screen.getByText("Member")).toBeTruthy();
    });

    it("accepts the invitation by its id, then sends the visitor on to where they were going", async () => {
        const user = userEvent.setup();

        render(<AcceptInvitationCard />);

        await user.click(await screen.findByRole("button", { name: "Accept" }));

        await waitFor(() => {
            expect(harness.replace).toHaveBeenCalledWith("/chat");
        });
        expect(harness.acceptInvitation).toHaveBeenCalledWith(expect.objectContaining({ invitationId: "inv_1" }));
        expect(harness.toast).toHaveBeenCalledWith({ message: "Invitation accepted", variant: "success" });
    });

    it("rejects the invitation without accepting it", async () => {
        const user = userEvent.setup();

        render(<AcceptInvitationCard />);

        await user.click(await screen.findByRole("button", { name: "Reject" }));

        await waitFor(() => {
            expect(harness.replace).toHaveBeenCalledWith("/chat");
        });
        expect(harness.rejectInvitation).toHaveBeenCalledWith(expect.objectContaining({ invitationId: "inv_1" }));
        expect(harness.acceptInvitation).not.toHaveBeenCalled();
    });

    it("shows why an accept was refused, does not leave, and frees the buttons to retry", async () => {
        const user = userEvent.setup();
        // The client reports a refusal by throwing only when `fetchOptions.throw` is set; otherwise it resolves with `error`.
        const refusal = { error: { code: "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION" } };

        harness.acceptInvitation.mockImplementation(async (options: { fetchOptions?: { throw?: boolean } }) => {
            if (options.fetchOptions?.throw) {
                throw refusal;
            }

            return refusal;
        });
        render(<AcceptInvitationCard />);

        await user.click(await screen.findByRole("button", { name: "Accept" }));

        await waitFor(() => {
            expect(harness.toast).toHaveBeenCalledWith({ message: "User is already a member of this organization", variant: "error" });
        });
        expect(harness.acceptInvitation).toHaveBeenCalledWith(expect.objectContaining({ fetchOptions: { throw: true }, invitationId: "inv_1" }));
        expect(harness.replace).not.toHaveBeenCalled();
        expect(accept().hasAttribute("disabled")).toBe(false);
        expect(reject().hasAttribute("disabled")).toBe(false);
    });

    it("says an expired invitation is expired and leaves without accepting it", async () => {
        harness.invitation = pendingInvitation({ expiresAt: PAST });
        render(<AcceptInvitationCard />);

        await waitFor(() => {
            expect(harness.toast).toHaveBeenCalledWith({ message: "Invitation expired", variant: "error" });
        });
        expect(harness.replace).toHaveBeenCalledWith("/chat");
        expect(harness.acceptInvitation).not.toHaveBeenCalled();
    });

    it("says an invitation already answered is not found and leaves", async () => {
        harness.invitation = pendingInvitation({ status: "accepted" });
        render(<AcceptInvitationCard />);

        await waitFor(() => {
            expect(harness.toast).toHaveBeenCalledWith({ message: "Invitation not found", variant: "error" });
        });
        expect(harness.replace).toHaveBeenCalledWith("/chat");
    });

    it("says a missing invitation is not found and leaves", async () => {
        harness.invitation = null;
        render(<AcceptInvitationCard />);

        await waitFor(() => {
            expect(harness.toast).toHaveBeenCalledWith({ message: "Invitation not found", variant: "error" });
        });
        expect(harness.replace).toHaveBeenCalledWith("/chat");
    });

    it("leaves at once when the link has no invitation id", async () => {
        harness.invitationId = undefined;
        render(<AcceptInvitationCard />);

        await waitFor(() => {
            expect(harness.replace).toHaveBeenCalledWith("/chat");
        });
        expect(harness.toast).toHaveBeenCalledWith({ message: "Invitation not found", variant: "error" });
        expect(harness.acceptInvitation).not.toHaveBeenCalled();
    });
});
