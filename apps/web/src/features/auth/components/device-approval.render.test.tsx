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

const CONSENT_HEADINGS = /Pair this machine\?|Sign in the command line\?/u;

const API_KEY_WORDING = /API key|read-only/iu;

const machine = { client_id: "neore-host", hostname: "build-box", platform: "linux", status: "pending", storage: "keychain" };

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

    it("words a machine code as pairing a machine, with its details, and never as an API key", async () => {
        fetchMock.mockResolvedValue({ data: { ...machine, hostname: "<b>box</b>" }, error: null });
        mount();

        expect(await screen.findByRole("heading", { level: 1, name: "Pair this machine?" })).toBeTruthy();

        const group = screen.getByRole("group", { name: "Pairing request" });

        expect(group.textContent).toContain("<b>box</b>");
        expect(group.textContent).toContain("linux");
        expect(group.textContent).toContain("The operating system keychain");
        expect(group.textContent).toContain("ABCD-EFGH");

        const page = document.body.textContent ?? "";

        expect(page).toContain("neore-host pair");
        expect(page).toContain("tools on it in the chats of the projects you choose");
        expect(page).toContain("Its device secret goes only to that machine, never to this page.");
        expect(page).toContain("The assistant won't use it in any chat until you choose projects.");
        expect(page).toContain("you can start coding agents on it yourself");
        expect(page).not.toMatch(API_KEY_WORDING);
    });

    it("says where a machine keeps its secret when it has no keychain", async () => {
        fetchMock.mockResolvedValue({ data: { ...machine, storage: "file" }, error: null });
        mount();

        const group = await screen.findByRole("group", { name: "Pairing request" });

        expect(group.textContent).toContain("A file only its owner can read");
    });

    it("says storage is unknown when the machine names none, or one the page does not know", async () => {
        fetchMock.mockResolvedValue({ data: { ...machine, storage: "tpm" }, error: null });
        mount();

        const group = await screen.findByRole("group", { name: "Pairing request" });

        expect(group.textContent).toContain("Secret kept inunknown");
        expect(group.textContent).not.toContain("file only its owner");
    });

    it.each([
        ["an unknown client", { client_id: "other-client", hostname: "box", status: "pending" }, "This code can't be approved here."],
        ["no client", { hostname: "box", status: "pending" }, "different account"],
    ])("shows neither consent and no buttons for a code from %s", async (_name, body, text) => {
        fetchMock.mockResolvedValue({ data: body, error: null });
        mount();

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toContain(text);
        expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
        expect(document.body.textContent).not.toMatch(CONSENT_HEADINGS);
    });

    it("tells the person a machine cannot be paired when the account has no room for another device", async () => {
        fetchMock.mockResolvedValueOnce({ data: machine, error: null }).mockResolvedValueOnce(failure("device_limit", 403));
        mount();
        fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe(
            "This account already has the maximum number of paired devices. Remove one in Settings, then run `neore-host pair` again.",
        );
        // Focus moves in an effect, which can land a tick after the content appears.
        await vi.waitFor(() => {
            expect(screen.getByRole("heading", { level: 1 }).matches(":focus")).toBe(true);
        });
    });

    it("announces the machine outcome, which tells the person to choose projects", async () => {
        fetchMock.mockResolvedValueOnce({ data: machine, error: null }).mockResolvedValueOnce({ data: {}, error: null });
        mount();
        fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

        await screen.findByRole("heading", { level: 1, name: "Approved" });

        const live = screen.getByRole("status").textContent ?? "";

        // Approval is recorded here; the machine registers on its next poll, which can still fail.
        expect(live).toContain("it finishes pairing on its next check");
        expect(live).not.toContain("is paired");
        expect(live).toContain("choose projects for it in Settings");
        expect(live).not.toContain("command line");
    });

    it("words a denied machine code as not paired", async () => {
        fetchMock.mockResolvedValueOnce({ data: machine, error: null }).mockResolvedValueOnce({ data: {}, error: null });
        mount();
        fireEvent.click(await screen.findByRole("button", { name: "Deny" }));

        await screen.findByRole("heading", { level: 1, name: "Denied" });

        expect(screen.getByRole("status").textContent).toContain("The machine was not paired");
    });

    it.each([
        ["expired", failure("expired_token", 400)],
        ["invalid", failure("invalid_grant", 400)],
        ["opened by another account", { data: { hostname: "devbox", status: "pending" }, error: null }],
    ])("names both commands in the problem for a code that is %s", async (_name, answer) => {
        fetchMock.mockResolvedValue(answer);
        mount();

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toContain("neore login --device");
        expect(alert.textContent).toContain("neore-host pair");
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

        // Focus moves in an effect, which can land a tick after the heading appears.
        await vi.waitFor(() => {
            expect(heading.matches(":focus")).toBe(true);
        });
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
        // Focus moves in an effect, which can land a tick after the content appears.
        await vi.waitFor(() => {
            expect(screen.getByRole("heading", { level: 1 }).matches(":focus")).toBe(true);
        });
    });

    it("looks again when the answer was already processed, and says so", async () => {
        fetchMock
            .mockResolvedValueOnce({ data: pending, error: null })
            .mockResolvedValueOnce(failure("invalid_request", 400))
            .mockResolvedValueOnce({ data: { ...pending, status: "approved" }, error: null });
        mount();
        fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

        const heading = await screen.findByRole("heading", { level: 1, name: "Approve a code" });

        // Focus moves in an effect, which can land a tick after the heading appears.
        await vi.waitFor(() => {
            expect(heading.matches(":focus")).toBe(true);
        });
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

    it("moves focus to the problem when the re-read after a processed answer fails", async () => {
        fetchMock
            .mockResolvedValueOnce({ data: pending, error: null })
            .mockResolvedValueOnce(failure("invalid_request", 400))
            .mockResolvedValueOnce(failure("", 503));
        mount();
        fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

        await screen.findByRole("button", { name: "Try again" });

        // Focus moves in an effect, which can land a tick after the content appears.
        await vi.waitFor(() => {
            expect(screen.getByRole("heading", { level: 1 }).matches(":focus")).toBe(true);
        });
    });

    it("does not announce 'already answered' for a code opened by another account", async () => {
        fetchMock.mockResolvedValueOnce({ data: { hostname: "devbox", status: "approved" }, error: null });
        mount();

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toContain("different account");
        expect(screen.getByRole("status").textContent).toBe("");
    });

    it("keeps the page heading while the code is being checked", async () => {
        fetchMock.mockReturnValueOnce(new Promise<void>(() => {}));
        mount();

        expect(await screen.findByRole("status")).toBeTruthy();
        expect(screen.getByRole("heading", { level: 1, name: "Approve a code" })).toBeTruthy();
    });

    it("offers to try a rate-limited lookup again", async () => {
        fetchMock.mockResolvedValueOnce(failure("", 429)).mockResolvedValueOnce({ data: pending, error: null });
        mount();
        fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

        expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
        expect(paths()).toEqual(["GET /device", "GET /device"]);
    });
});
