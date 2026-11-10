/** The approval page: it only ever asks about a code until the person presses Approve or Deny. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceApproval } from "./device-approval";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

const fetchMock = vi.fn();

vi.mock("@/lib/auth/client", () => {
    return { authClient: { $fetch: (...args: unknown[]) => fetchMock(...args) as unknown } };
});

vi.mock("@/features/auth/hooks/use-authenticate", () => {
    return {
        default: () => {
            return { data: { user: { email: "me@example.com", id: "u1" } }, error: null, isPending: false, refetch: vi.fn() };
        },
    };
});

vi.mock("@/features/auth/hooks/use-is-anonymous", () => {
    return {
        default: () => {
            return { isAnonymous: false };
        },
    };
});

const pending = { client_id: "neore-cli", hostname: "devbox", status: "pending" };

const failure = (error: string, status: number) => {
    return { data: null, error: { error, status } };
};

const paths = () => fetchMock.mock.calls.map(([path, options]) => `${(options as { method: string }).method} ${path as string}`);

const mount = (rawCode: string | undefined = "ABCDEFGH") => {
    render(
        <QueryClientProvider client={new QueryClient()}>
            <DeviceApproval onCode={vi.fn()} rawCode={rawCode} />
        </QueryClientProvider>,
    );
};

describe("DeviceApproval", () => {
    beforeEach(() => {
        fetchMock.mockReset();
    });

    it("only looks the code up on load, and offers Approve and Deny with the host shown as text", async () => {
        fetchMock.mockResolvedValue({ data: { ...pending, hostname: "<b>devbox</b>" }, error: null });
        mount();

        expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
        expect(paths()).toEqual(["GET /device"]);
        expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
        expect(screen.getByText("<b>devbox</b>")).toBeTruthy();
    });

    it("looks a numeric-looking code up as the string it is", async () => {
        fetchMock.mockResolvedValue({ data: pending, error: null });
        mount("2E345678");
        await screen.findByRole("button", { name: "Approve" });

        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ query: { user_code: "2E345678" } });
    });

    it.each([
        ["opened by another account", { hostname: "devbox", status: "pending" }],
        ["already answered", { ...pending, status: "approved" }],
    ])("shows no buttons for a code that was %s, and keeps a heading", async (_name, body) => {
        fetchMock.mockResolvedValue({ data: body, error: null });
        mount();

        await screen.findByRole("heading", { level: 1 });

        expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
        expect(paths()).toEqual(["GET /device"]);
    });

    it("announces the outcome in the live region and moves focus to its heading", async () => {
        fetchMock.mockResolvedValueOnce({ data: pending, error: null }).mockResolvedValueOnce({ data: {}, error: null });
        mount();
        fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

        const heading = await screen.findByRole("heading", { level: 1, name: "Approved" });

        expect(heading.matches(":focus")).toBe(true);
        expect(screen.getByRole("status").textContent).toContain("Approved");
        expect(paths()).toEqual(["GET /device", "POST /device/approve"]);
    });

    it("shows the busy text on the button that was pressed", async () => {
        fetchMock.mockResolvedValueOnce({ data: pending, error: null }).mockReturnValueOnce(new Promise<void>(() => {}));
        mount();
        fireEvent.click(await screen.findByRole("button", { name: "Deny" }));

        const busy = await screen.findByRole("button", { name: "Working…" });

        expect(busy.hasAttribute("disabled")).toBe(true);
        expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    });

    it("reads a refused approval as 'different account', not as an admin session", async () => {
        fetchMock.mockResolvedValueOnce({ data: pending, error: null }).mockResolvedValueOnce(failure("access_denied", 403));
        mount();
        fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toContain("different account");
        expect(screen.getByRole("heading", { level: 1 }).matches(":focus")).toBe(true);
    });

    it("looks again when the answer was already processed, and says so", async () => {
        fetchMock
            .mockResolvedValueOnce({ data: pending, error: null })
            .mockResolvedValueOnce(failure("invalid_request", 400))
            .mockResolvedValueOnce({ data: { ...pending, status: "approved" }, error: null });
        mount();
        fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

        const heading = await screen.findByRole("heading", { level: 1, name: "Sign in the command line" });

        expect(heading.matches(":focus")).toBe(true);
        expect(screen.getByRole("status").textContent).toBe("This code has already been answered.");
        expect(paths()).toEqual(["GET /device", "POST /device/approve", "GET /device"]);
    });

    it("keeps both buttons disabled while it looks again after a processed answer", async () => {
        let finishLookup: (value: unknown) => void = () => {};
        // The tsconfig lib predates `Promise.withResolvers`.
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        const heldLookup = new Promise((resolve) => {
            finishLookup = resolve;
        });

        fetchMock.mockResolvedValueOnce({ data: pending, error: null }).mockResolvedValueOnce(failure("invalid_request", 400)).mockReturnValueOnce(heldLookup);
        mount();
        fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
        await vi.waitFor(() => {
            expect(paths()).toEqual(["GET /device", "POST /device/approve", "GET /device"]);
        });

        expect(screen.getByRole("button", { name: "Working…" }).hasAttribute("disabled")).toBe(true);
        expect(screen.getByRole("button", { name: "Deny" }).hasAttribute("disabled")).toBe(true);

        finishLookup({ data: { ...pending, status: "approved" }, error: null });

        await vi.waitFor(() => {
            expect(screen.getByRole("status").textContent).toBe("This code has already been answered.");
        });
    });

    it("keeps the page heading while the code is being checked", async () => {
        fetchMock.mockReturnValueOnce(new Promise<void>(() => {}));
        mount();

        expect(await screen.findByRole("status")).toBeTruthy();
        expect(screen.getByRole("heading", { level: 1, name: "Sign in the command line" })).toBeTruthy();
    });

    it("offers to try a rate-limited lookup again", async () => {
        fetchMock.mockResolvedValueOnce(failure("", 429)).mockResolvedValueOnce({ data: pending, error: null });
        mount();
        fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

        expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
        expect(paths()).toEqual(["GET /device", "GET /device"]);
    });
});
