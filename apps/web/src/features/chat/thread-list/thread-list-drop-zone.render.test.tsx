// @vitest-environment jsdom

/** Files dropped on the thread list are queued for the new-chat composer, which opens unless it is already open. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createPortal } from "react-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => vi.fn());
const requestComposerAttach = vi.hoisted(() => vi.fn());
const withdrawComposerAttach = vi.hoisted(() => vi.fn());
const showError = vi.hoisted(() => vi.fn());
const location = vi.hoisted(() => {
    return { pathname: "/chat/k17abc" };
});

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        useNavigate: () => navigate,
        useRouter: () => {
            return { state: { location } };
        },
    };
});

vi.mock("@/features/chat/core/utils/composer-submit", () => {
    return { requestComposerAttach, withdrawComposerAttach };
});

const session = vi.hoisted(() => {
    return { data: { user: { id: "u1" } } as { user: { id: string } } | null };
});

vi.mock("@/features/auth/hooks/use-auth-session", () => {
    return {
        useAuthSession: () => {
            return { data: session.data, isPending: false };
        },
    };
});

vi.mock("@/lib/toast", () => {
    return { showError };
});

const { default: ThreadListDropZone, isNewChatPath } = await import("./thread-list-drop-zone");

const DROP_HINT = "Drop files to start a new chat";

/** A drag event's data carrying `files`, as a browser builds it for a drag from the file manager. */
const filesTransfer = (files: File[]) => {
    return {
        dataTransfer: {
            files,
            items: files.map((file) => {
                return { getAsFile: () => file, kind: "file", type: file.type };
            }),
            types: ["Files"],
        },
    };
};

const renderZone = () =>
    render(
        <ThreadListDropZone>
            <ul aria-label="Threads">
                <li>Quarterly plan</li>
            </ul>
        </ThreadListDropZone>,
    );

describe(isNewChatPath, () => {
    it.each([
        ["/chat", true],
        ["/chat/", true],
        ["/chat/k17abc", false],
        ["/settings", false],
    ])("%s is %s", (pathname, expected) => {
        expect(isNewChatPath(pathname)).toBe(expected);
    });
});

describe("ThreadListDropZone", () => {
    beforeEach(() => {
        navigate.mockReset();
        // A navigation lands on the new chat unless a test says otherwise.
        navigate.mockImplementation(async () => {
            location.pathname = "/chat";
        });
        requestComposerAttach.mockReset();
        withdrawComposerAttach.mockReset();
        showError.mockReset();
        location.pathname = "/chat/k17abc";
        session.data = { user: { id: "u1" } };
    });

    it("queues dropped files for a new chat and opens it", async () => {
        const report = new File(["%PDF"], "report.pdf", { type: "application/pdf" });
        const photo = new File(["png"], "photo.png", { type: "image/png" });

        renderZone();
        fireEvent.drop(screen.getByTestId("thread-list-drop-zone"), filesTransfer([report, photo]));

        await waitFor(() => {
            expect(requestComposerAttach).toHaveBeenCalledTimes(1);
        });
        expect(requestComposerAttach.mock.calls[0]?.[0]).toEqual({ accountId: "u1", files: [report, photo] });
        expect(navigate).toHaveBeenCalledWith({ search: {}, to: "/chat" });
        expect(withdrawComposerAttach).not.toHaveBeenCalled();
    });

    it("marks a drop made with no one signed in as signed out, so a later sign-in never takes it", async () => {
        session.data = null;
        renderZone();
        fireEvent.drop(screen.getByTestId("thread-list-drop-zone"), filesTransfer([new File(["a"], "a.txt", { type: "text/plain" })]));

        await waitFor(() => {
            expect(requestComposerAttach).toHaveBeenCalledTimes(1);
        });
        expect(requestComposerAttach.mock.calls[0]?.[0]).toMatchObject({ accountId: "signed-out" });
    });

    it("takes the files back and says so when the new chat does not open", async () => {
        const report = new File(["%PDF"], "report.pdf", { type: "application/pdf" });

        // The update dialog stops the move: the thread stays open.
        navigate.mockImplementation(async () => {});
        renderZone();
        fireEvent.drop(screen.getByTestId("thread-list-drop-zone"), filesTransfer([report]));

        await waitFor(() => {
            expect(withdrawComposerAttach).toHaveBeenCalledWith([report]);
        });
        expect(showError).toHaveBeenCalledTimes(1);
    });

    it("stays on the new-chat page when it is already open", async () => {
        location.pathname = "/chat";
        renderZone();
        fireEvent.drop(screen.getByTestId("thread-list-drop-zone"), filesTransfer([new File(["a"], "a.txt", { type: "text/plain" })]));

        await waitFor(() => {
            expect(requestComposerAttach).toHaveBeenCalledTimes(1);
        });
        expect(navigate).not.toHaveBeenCalled();
    });

    it("does nothing for a drop that carries no files", async () => {
        renderZone();
        fireEvent.drop(screen.getByTestId("thread-list-drop-zone"), { dataTransfer: { files: [], items: [], types: ["text/plain"] } });

        expect(requestComposerAttach).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
    });

    it("announces the drop target while files are dragged over the list", async () => {
        renderZone();

        expect(screen.queryByRole("status")).toBeNull();

        fireEvent.dragEnter(screen.getByTestId("thread-list-drop-zone"), filesTransfer([new File(["a"], "a.txt", { type: "text/plain" })]));

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toBe(DROP_HINT);
        });
    });

    it("ignores files dropped on a dialog the list opens in a portal", async () => {
        render(<ThreadListDropZone>{createPortal(<div role="dialog">Project form</div>, document.body)}</ThreadListDropZone>);
        fireEvent.drop(screen.getByRole("dialog"), filesTransfer([new File(["a"], "rules.md", { type: "text/markdown" })]));
        // react-dropzone reads the drop asynchronously: give it that turn before asserting that nothing happened.
        await new Promise((resolve) => {
            setTimeout(resolve, 20);
        });

        expect(requestComposerAttach).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
    });

    it("keeps the list itself in place", () => {
        renderZone();

        expect(screen.getByRole("list", { name: "Threads" })).toBeTruthy();
    });
});
