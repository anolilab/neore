/** The edit dialog keeps what was typed after a refusal, closes after an unconfirmed answer, and says what happened on the panel; the reviewer and revert actions follow the same rules. */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import PullRequestActionsPanel from "./pull-request-actions-panel";

const { available, edit, pending, requestReviewers, revert } = vi.hoisted(() => {
    return {
        available: vi.fn((_report: unknown, _key: string) => true),
        edit: vi.fn(),
        pending: { current: false, revert: false },
        requestReviewers: vi.fn(),
        revert: vi.fn(),
    };
});

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    const text = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        Plural: ({ value }: { value: number }) => <>{value}</>,
        Trans: ({ children }: { children: unknown }) => <>{children as never}</>,
        useLingui: () => {
            return { i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en", number: String }, t: text };
        },
    };
});

vi.mock("@lingui/core/macro", () => {
    return {
        plural: (value: number, forms: { one: string; other: string }) => (value === 1 ? forms.one : forms.other).split("#").join(String(value)),
    };
});

vi.mock("@neore/backend/source-control/capabilities", () => {
    return {
        isHostCapabilityAvailable: available,
    };
});

vi.mock("../lib/use-pull-request-actions", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/use-pull-request-actions")>()),
        usePullRequestActions: () => {
            return {
                edit: { isPending: pending.current, mutateAsync: edit },
                requestReviewers: { isPending: pending.current, mutateAsync: requestReviewers },
                revert: { isPending: pending.revert, mutateAsync: revert },
            };
        },
    };
});

vi.mock("../lib/use-review-messages", () => {
    return {
        useReviewMessages: () => {
            return {
                edit: String,
                write: (outcome: { reason?: string | null; status: string }) => `The host answered ${outcome.status}: ${outcome.reason ?? ""}`,
            };
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

const panel = (bodyTruncated = false, body = "The description", noun = "pull request", state: "closed" | "merged" | "open" = "open", maxReviewers = 15) => (
    <PullRequestActionsPanel
        host={{ capabilities: {} as never, label: "GitHub", maxReviewers, noun }}
        pull={{ address: ADDRESS as never, body, bodyTruncated, state, title: "Old title" }}
    />
);

const renderPanel = (...args: Parameters<typeof panel>) => render(panel(...args));

/** Opens the reviewers dialog and types the logins. */
const typeLogins = async (value: string) => {
    pressButton(screen.getByRole("button", { name: "Request reviewers" }));
    typeInto(await screen.findByLabelText("Logins"), value);
};

/** Opens the edit dialog and types a new title, so Save has a change to send. */
const typeNewTitle = async () => {
    pressButton(screen.getByRole("button", { name: "Edit title and description" }));

    const title = await screen.findByLabelText("Title");

    typeInto(title, "New title");
};

beforeEach(() => {
    available.mockReset();
    available.mockReturnValue(true);
    edit.mockReset();
    requestReviewers.mockReset();
    revert.mockReset();
    pending.current = false;
    pending.revert = false;
});

describe("PullRequestActionsPanel edit dialog", () => {
    it("keeps the dialog open with the typed title when the host refuses the edit", async () => {
        edit.mockResolvedValueOnce({ reason: "Not allowed", status: "rejected" });
        renderPanel();

        await typeNewTitle();
        pressButton(screen.getByRole("button", { name: "Save" }));

        // The reason shows in the dialog and on the panel, so the person sees it whichever they look at.
        expect(await screen.findAllByText("The host answered rejected: Not allowed")).not.toHaveLength(0);
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

describe("PullRequestActionsPanel cut-short description", () => {
    it("makes the description read-only and saves only the title", async () => {
        edit.mockResolvedValueOnce({ status: "ok" });
        renderPanel(true);

        await typeNewTitle();

        const description = screen.getByLabelText("Description") as HTMLTextAreaElement;

        expect(description.readOnly).toBe(true);
        typeInto(description, "Rewritten");
        pressButton(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => {
            expect(edit).toHaveBeenCalledTimes(1);
        });
        expect(edit).toHaveBeenCalledWith({ title: "New title" });
    });
});

describe("PullRequestActionsPanel description comparison", () => {
    it("does not send a description that only differs by line endings", async () => {
        edit.mockResolvedValueOnce({ status: "ok" });
        renderPanel(false, "one\r\ntwo");

        await typeNewTitle();
        typeInto(screen.getByLabelText("Description"), "one\ntwo");
        pressButton(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => {
            expect(edit).toHaveBeenCalledTimes(1);
        });
        expect(edit).toHaveBeenCalledWith({ title: "New title" });
    });
});

describe("PullRequestActionsPanel capability", () => {
    it("does not offer the edit when the host does not declare it", () => {
        available.mockReturnValue(false);
        renderPanel();

        expect(screen.queryByRole("button", { name: "Edit title and description" })).toBeNull();
    });

    it("offers reviewers only on an open request and a revert only on a merged one, each by its own capability", () => {
        const view = renderPanel(false, "d", "pull request", "open");

        expect(screen.getByRole("button", { name: "Request reviewers" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();

        view.rerender(panel(false, "d", "pull request", "merged"));
        expect(screen.queryByRole("button", { name: "Request reviewers" })).toBeNull();
        expect(screen.getByRole("button", { name: "Revert" })).toBeTruthy();

        available.mockImplementation((_report, key) => key === "pullRequest.edit");
        view.rerender(panel(false, "d", "pull request", "merged"));
        expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();
    });

    it("hides the reviewers when only that capability is off", () => {
        available.mockImplementation((_report, key) => key !== "reviewers.request");
        renderPanel();

        expect(screen.queryByRole("button", { name: "Request reviewers" })).toBeNull();
        expect(screen.getByRole("button", { name: "Edit title and description" })).toBeTruthy();
    });

    it("keeps the panel and its answer when a refetch takes the last capability away", async () => {
        available.mockImplementation((_report, key) => key === "reviewers.request");
        requestReviewers.mockResolvedValueOnce({ status: "ok" });
        const view = renderPanel();

        await typeLogins("octocat");
        pressButton(screen.getByRole("button", { name: "Request" }));
        available.mockReturnValue(false);
        view.rerender(panel(false, "d", "pull request", "merged"));

        expect(await screen.findByText("Review requested on GitHub.")).toBeTruthy();
    });
});

describe("PullRequestActionsPanel while saving", () => {
    it("keeps the fields read-only and shows the progress cue", async () => {
        const view = renderPanel();

        await typeNewTitle();
        pending.current = true;
        // A new render of the panel reads the pending flag.
        view.rerender(panel());

        expect((screen.getByLabelText("Title") as HTMLInputElement).readOnly).toBe(true);
        expect((screen.getByLabelText("Description") as HTMLTextAreaElement).readOnly).toBe(true);
        expect(screen.getByRole("button", { name: "Saving…" })).toBeTruthy();
    });
});

describe("PullRequestActionsPanel naming", () => {
    it("names the region after the host's request noun", () => {
        renderPanel(false, "The description", "merge request");

        expect(screen.getByRole("region", { name: "Merge request" })).toBeTruthy();
    });
});

describe("PullRequestActionsPanel title comparison", () => {
    it("sends only the description when the title differs by a space", async () => {
        edit.mockResolvedValueOnce({ status: "ok" });
        renderPanel();

        pressButton(screen.getByRole("button", { name: "Edit title and description" }));
        typeInto(await screen.findByLabelText("Title"), "Old title ");
        typeInto(screen.getByLabelText("Description"), "New description");
        pressButton(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => {
            expect(edit).toHaveBeenCalledTimes(1);
        });
        expect(edit).toHaveBeenCalledWith({ body: "New description" });
    });

    it("sends nothing when only a space was added to the title", async () => {
        renderPanel();

        pressButton(screen.getByRole("button", { name: "Edit title and description" }));
        typeInto(await screen.findByLabelText("Title"), "Old title ");
        pressButton(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => {
            expect(screen.queryByLabelText("Title")).toBeNull();
        });
        expect(edit).not.toHaveBeenCalled();
    });
});

describe("PullRequestActionsPanel validation notes", () => {
    it("announces an empty title and links it to the field", async () => {
        renderPanel();

        pressButton(screen.getByRole("button", { name: "Edit title and description" }));

        const title = await screen.findByLabelText("Title");

        typeInto(title, "  ");

        const note = screen.getByRole("alert");

        expect(note.textContent).toContain("needs a title");
        expect(title.getAttribute("aria-invalid")).toBe("true");
        expect(title.getAttribute("aria-describedby")).toBe(note.id);
    });
});

describe("PullRequestActionsPanel reviewers", () => {
    it("keeps the dialog open with the typed logins when the host refuses", async () => {
        requestReviewers.mockResolvedValueOnce({ reason: "Cannot review", status: "rejected" });
        renderPanel();

        await typeLogins("@octocat, hubot");
        pressButton(screen.getByRole("button", { name: "Request" }));

        expect(await screen.findAllByText("The host answered rejected: Cannot review")).not.toHaveLength(0);
        expect(requestReviewers).toHaveBeenCalledTimes(1);
        expect(requestReviewers).toHaveBeenCalledWith(["octocat", "hubot"]);
        expect((screen.getByLabelText("Logins") as HTMLInputElement).value).toBe("@octocat, hubot");
    });

    it("says the review was requested and closes the dialog when the host took it", async () => {
        requestReviewers.mockResolvedValueOnce({ status: "ok" });
        renderPanel();

        await typeLogins("octocat");
        pressButton(screen.getByRole("button", { name: "Request" }));

        expect(await screen.findByText("Review requested on GitHub.")).toBeTruthy();
        await waitFor(() => {
            expect(screen.queryByLabelText("Logins")).toBeNull();
        });
    });

    it("shows the server's own reason when it refuses a login before any host call", async () => {
        requestReviewers.mockRejectedValueOnce(Object.assign(new Error('"ghost" is not a valid login'), { code: "BAD_REQUEST" }));
        renderPanel();

        await typeLogins("ghost");
        pressButton(screen.getByRole("button", { name: "Request" }));

        expect(await screen.findAllByText('"ghost" is not a valid login')).not.toHaveLength(0);
        expect((screen.getByLabelText("Logins") as HTMLInputElement).value).toBe("ghost");
    });

    it("counts a login named twice once", async () => {
        requestReviewers.mockResolvedValueOnce({ status: "ok" });
        renderPanel(false, "d", "pull request", "open", 2);

        await typeLogins("a, @A, b");
        pressButton(screen.getByRole("button", { name: "Request" }));

        await waitFor(() => {
            expect(requestReviewers).toHaveBeenCalledTimes(1);
        });
        expect(requestReviewers).toHaveBeenCalledWith(["A", "b"]);
    });

    it("says it is not confirmed, and not as a success, when the answer never came back", async () => {
        requestReviewers.mockResolvedValueOnce({ status: "unconfirmed" });
        renderPanel();

        await typeLogins("octocat");
        pressButton(screen.getByRole("button", { name: "Request" }));

        expect(await screen.findByText("Not confirmed")).toBeTruthy();
        expect(screen.queryByText("Review requested on GitHub.")).toBeNull();
    });

    it("announces a login the host would refuse, links it to the field and sends nothing", async () => {
        renderPanel();

        await typeLogins("octo--cat");

        const field = screen.getByLabelText("Logins");
        const note = screen.getByRole("alert");

        expect(note.textContent).toContain('"octo--cat" is not a valid login');
        expect(field.getAttribute("aria-invalid")).toBe("true");
        expect(field.getAttribute("aria-describedby")).toBe(note.id);
        expect((screen.getByRole("button", { name: "Request" }) as HTMLButtonElement).disabled).toBe(true);
        expect(requestReviewers).not.toHaveBeenCalled();
    });

    it("names a bare @ instead of dropping it", async () => {
        renderPanel();

        await typeLogins("octocat, @");

        expect(screen.getByRole("alert").textContent).toContain('"@" is not a valid login');
        expect(requestReviewers).not.toHaveBeenCalled();
    });

    it("announces more logins than the host takes in one request", async () => {
        renderPanel(false, "d", "merge request", "open", 2);

        await typeLogins("a b c");

        expect(screen.getByRole("alert").textContent).toBe("Request at most 2 reviewers at a time.");
        expect((screen.getByRole("button", { name: "Request" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("keeps the field read-only and shows the progress cue while the request is pending", async () => {
        const view = renderPanel();

        await typeLogins("octocat");
        pending.current = true;
        view.rerender(panel());

        expect((screen.getByLabelText("Logins") as HTMLInputElement).readOnly).toBe(true);
        expect(screen.getByRole("button", { name: "Requesting…" })).toBeTruthy();
    });
});

describe("PullRequestActionsPanel revert", () => {
    const pressRevert = async () => {
        pressButton(screen.getByRole("button", { name: "Revert" }));
        pressButton(await screen.findByRole("button", { name: "Open revert" }));
    };

    // The client has no web origin to compare with; it keeps plain https links, and the server has already refused any off-origin one.
    it("names the host's noun in the confirmation and links to the new request on the host", async () => {
        revert.mockResolvedValueOnce({ number: 8, repository: "octo/hello", status: "ok", url: "https://github.com/octo/hello/pull/8" });
        renderPanel(false, "d", "merge request", "merged");

        pressButton(screen.getByRole("button", { name: "Revert" }));
        expect(await screen.findByText("Open a revert of this merge request?")).toBeTruthy();
        pressButton(screen.getByRole("button", { name: "Open revert" }));

        expect(await screen.findByText("Opened a revert merge request on GitHub.")).toBeTruthy();
        expect(revert).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("link", { name: "Open the revert merge request on GitHub" }).getAttribute("href")).toBe("https://github.com/octo/hello/pull/8");
    });

    it("shows no link when the returned address is not an https one", async () => {
        revert.mockResolvedValueOnce({ number: 8, repository: "octo/hello", status: "ok", url: "ftp://example.test/octo/hello/pull/8" });
        renderPanel(false, "d", "pull request", "merged");

        await pressRevert();

        expect(await screen.findByText("Opened a revert pull request on GitHub.")).toBeTruthy();
        expect(screen.queryByRole("link")).toBeNull();
    });

    it("shows the host's reason when it refuses, with no link and no success", async () => {
        revert.mockResolvedValueOnce({ reason: "Already reverted", status: "rejected" });
        renderPanel(false, "d", "pull request", "merged");

        await pressRevert();

        expect(await screen.findByText("The host answered rejected: Already reverted")).toBeTruthy();
        expect(screen.getByText("Not changed")).toBeTruthy();
        expect(screen.queryByRole("link")).toBeNull();
    });

    it("says it is not confirmed when the answer never came back", async () => {
        revert.mockResolvedValueOnce({ status: "unconfirmed" });
        renderPanel(false, "d", "pull request", "merged");

        await pressRevert();

        expect(await screen.findByText("Not confirmed")).toBeTruthy();
        expect(screen.queryByText("Opened a revert pull request on GitHub.")).toBeNull();
    });

    it("shows the progress cue and disables the button while the revert is pending", () => {
        pending.revert = true;
        renderPanel(false, "d", "pull request", "merged");

        expect((screen.getByRole("button", { name: "Reverting…" }) as HTMLButtonElement).disabled).toBe(true);
    });
});
