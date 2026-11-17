/**
 * While feedback is sending, what it sends cannot change, the dialog does not close and the send is announced; a failed
 * send says why; a drop of text is left to the text box; every preview URL made is given back.
 */
import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SendFeedbackDialog from "./send-feedback-dialog";

const submit = vi.hoisted(() => vi.fn());

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

vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

vi.mock("@neore/backend/api", () => {
    return { api: { feedback: { functions: { submitFeedback: {} } } } };
});

vi.mock("@/lib/lunora/crpc", () => {
    return { useAction: () => submit };
});

vi.mock("@tanstack/react-router", () => {
    return {
        useLocation: () => {
            return { pathname: "/chat" };
        },
    };
});

vi.mock("@/lib/upload/upload-file", () => {
    return { uploadFile: async () => "upload-1" };
});

vi.mock("@/lib/upload/image-downscale", () => {
    return { downscaleOversizedImage: async (file: File) => file };
});

vi.mock("@/lib/analytics/posthog-client", () => {
    return { captureException: vi.fn() };
});

vi.mock("@/lib/toast", () => {
    return { showError: vi.fn(), showSuccess: vi.fn() };
});

const renderDialog = () => {
    const onOpenChange = vi.fn();
    const { unmount } = render(
        <StrictMode>
            <SendFeedbackDialog onOpenChange={onOpenChange} open />
        </StrictMode>,
    );

    return { onOpenChange, unmount };
};

const dropFile = () => {
    const file = new File(["png"], "shot.png", { type: "image/png" });

    fireEvent.drop(screen.getByLabelText("Your feedback"), { dataTransfer: { files: [file], types: ["Files"] } });
};

const { createObjectURL, revokeObjectURL } = URL;

beforeEach(() => {
    URL.createObjectURL = vi.fn(() => `blob:${crypto.randomUUID()}`);
    URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
    submit.mockReset();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
});

describe("send feedback dialog", () => {
    it("locks the images and the page choice while sending, announces the send, and stays open on Escape", async () => {
        submit.mockReturnValue(
            new Promise(() => {
                // Never settles: the send stays in flight.
            }),
        );
        const { onOpenChange } = renderDialog();

        dropFile();
        fireEvent.change(screen.getByLabelText("Your feedback"), { target: { value: "It broke" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));

        await waitFor(() => {
            expect((screen.getByRole("button", { name: "Remove attachment 1" }) as HTMLButtonElement).disabled).toBe(true);
        });
        expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByRole("status").textContent).toBe("Sending…");

        fireEvent.keyDown(screen.getByLabelText("Your feedback"), { key: "Escape" });

        expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });

    it("names the hourly limit when the server refuses a send for it", async () => {
        submit.mockRejectedValue(Object.assign(new Error("Too many requests"), { code: "TOO_MANY_REQUESTS" }));

        renderDialog();

        fireEvent.change(screen.getByLabelText("Your feedback"), { target: { value: "Again" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("You have sent a lot of feedback recently. Please try again in an hour.");
    });

    it("gives back every preview URL it made once it closes", () => {
        const { unmount } = renderDialog();

        dropFile();
        unmount();

        const created = vi.mocked(URL.createObjectURL).mock.results.map((result) => result.value);

        expect(created.length).toBeGreaterThan(0);
        expect(vi.mocked(URL.revokeObjectURL).mock.calls.map(([url]) => url)).toStrictEqual(created);
    });

    it("leaves a drop of text to the text box", () => {
        renderDialog();

        const textarea = screen.getByLabelText("Your feedback");
        const drop = createEvent.drop(textarea, { dataTransfer: { files: [], types: ["text/plain"] } });

        fireEvent(textarea, drop);

        expect(drop.defaultPrevented).toBe(false);
    });
});
