/** The edit dialog keeps what was typed after a refusal, closes after an unconfirmed answer, and says what happened on the panel. */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import PullRequestActionsPanel from "./pull-request-actions-panel";

const { edit, requestReviewers, revert } = vi.hoisted(() => {
    return { edit: vi.fn(), requestReviewers: vi.fn(), revert: vi.fn() };
});

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    const text = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        Plural: ({ value }: { value: number }) => <>{value}</>,
        Trans: ({ children }: { children: unknown }) => <>{children as never}</>,
        useLingui: () => {
            return { i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" }, t: text };
        },
    };
});

vi.mock("@neore/backend/source-control/capabilities", () => {
    return {
        isHostCapabilityAvailable: () => true,
    };
});

vi.mock("../lib/use-pull-request-actions", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/use-pull-request-actions")>()),
        usePullRequestActions: () => {
            return {
                edit: { isPending: false, mutateAsync: edit },
                requestReviewers: { isPending: false, mutateAsync: requestReviewers },
                revert: { isPending: false, mutateAsync: revert },
            };
        },
    };
});

vi.mock("../lib/use-review-messages", () => {
    return {
        useReviewMessages: () => {
            return { edit: String, write: (outcome: { status: string }) => `The host answered ${outcome.status}` };
        },
    };
});

/** A press as a person makes it: the pointer goes down and up over the element, and the click lands. */
const pressButton = (element: HTMLElement): void => {
    fireEvent.pointerDown(element);
    fireEvent.mouseDown(element);
    fireEvent.pointerUp(element);
    fireEvent.mouseUp(element);
    fireEvent.click(element);
};

/** Typing as a person does: the field takes focus, its value changes, and it loses focus again. */
const typeInto = (element: HTMLElement, value: string): void => {
    fireEvent.focus(element);
    fireEvent.change(element, { target: { value } });
    fireEvent.blur(element);
};

const ADDRESS = { number: 7, repository: "octo/hello" } as const;

const renderPanel = (state: "merged" | "open" = "open") =>
    render(
        <PullRequestActionsPanel
            host={{ capabilities: {} as never, label: "GitHub", noun: "pull request" }}
            pull={{ address: ADDRESS as never, body: "The description", bodyTruncated: false, state, title: "Old title" }}
        />,
    );

/** Opens the edit dialog and types a new title, so Save has a change to send. */
const typeNewTitle = async () => {
    pressButton(screen.getByRole("button", { name: "Edit title and description" }));

    const title = await screen.findByLabelText("Title");

    typeInto(title, "New title");
};

describe("PullRequestActionsPanel edit dialog", () => {
    it("keeps the dialog open with the typed title when the host refuses the edit", async () => {
        edit.mockResolvedValueOnce({ reason: "Not allowed", status: "rejected" });
        renderPanel();

        await typeNewTitle();
        pressButton(screen.getByRole("button", { name: "Save" }));

        // The reason shows in the dialog and on the panel, so the person sees it whichever they look at.
        expect(await screen.findAllByText("The host answered rejected")).not.toHaveLength(0);
        expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("New title");
    });

    it("closes the dialog and says it is not confirmed when the answer never came back", async () => {
        edit.mockResolvedValueOnce({ status: "unconfirmed" });
        renderPanel();

        await typeNewTitle();
        pressButton(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Not confirmed")).toBeTruthy();
        await waitFor(() => {
            expect(screen.queryByLabelText("Title")).toBeNull();
        });
    });

    it("keeps the dialog open when the server refused the request before any host call", async () => {
        edit.mockRejectedValueOnce(Object.assign(new Error("bad"), { code: "BAD_REQUEST" }));
        renderPanel();

        await typeNewTitle();
        pressButton(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findAllByText("Not changed")).not.toHaveLength(0);
        expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("New title");
    });

    it("says the edit was saved and closes the dialog when the host took it", async () => {
        edit.mockResolvedValueOnce({ status: "ok" });
        renderPanel();

        await typeNewTitle();
        pressButton(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Saved on GitHub.")).toBeTruthy();
        await waitFor(() => {
            expect(screen.queryByLabelText("Title")).toBeNull();
        });
    });
});

describe("PullRequestActionsPanel reviewer dialog", () => {
    it("keeps the logins typed when the host refuses the request", async () => {
        requestReviewers.mockResolvedValueOnce({ reason: "Not a reviewer", status: "rejected" });
        renderPanel();

        pressButton(screen.getByRole("button", { name: "Request reviewers" }));
        typeInto(await screen.findByLabelText("Logins"), "alice");
        pressButton(screen.getByRole("button", { name: "Request" }));

        expect(await screen.findAllByText("The host answered rejected")).not.toHaveLength(0);
        expect((screen.getByLabelText("Logins") as HTMLInputElement).value).toBe("alice");
    });

    it("closes the dialog and says it is not confirmed when the answer never came back", async () => {
        requestReviewers.mockResolvedValueOnce({ status: "unconfirmed" });
        renderPanel();

        pressButton(screen.getByRole("button", { name: "Request reviewers" }));
        typeInto(await screen.findByLabelText("Logins"), "alice");
        pressButton(screen.getByRole("button", { name: "Request" }));

        expect(await screen.findByText("Not confirmed")).toBeTruthy();
        await waitFor(() => {
            expect(screen.queryByLabelText("Logins")).toBeNull();
        });
    });
});

describe("PullRequestActionsPanel revert", () => {
    it("shows a link to the revert pull request the host opened", async () => {
        revert.mockResolvedValueOnce({ status: "ok", url: "https://github.com/octo/hello/pull/9" });
        renderPanel("merged");

        pressButton(screen.getByRole("button", { name: "Revert" }));
        pressButton(await screen.findByRole("button", { name: "Open revert" }));

        expect(await screen.findByText("Opened a revert pull request on GitHub.")).toBeTruthy();
        expect(screen.getByRole("link", { name: "Open the revert pull request on GitHub" }).getAttribute("href")).toBe("https://github.com/octo/hello/pull/9");
    });

    it("says nothing changed when the server refused the revert before any host call", async () => {
        revert.mockRejectedValueOnce(Object.assign(new Error("slow down"), { code: "TOO_MANY_REQUESTS" }));
        renderPanel("merged");

        pressButton(screen.getByRole("button", { name: "Revert" }));
        pressButton(await screen.findByRole("button", { name: "Open revert" }));

        expect(await screen.findAllByText("Not changed")).not.toHaveLength(0);
    });
});
