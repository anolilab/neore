/**
 * While feedback is sending, what it sends cannot change and the dialog does not close; a failed send says why; a
 * drop of text is left to the text box.
 */
import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

    render(<SendFeedbackDialog onOpenChange={onOpenChange} open />);

    return { onOpenChange };
};

const dropFile = () => {
    const file = new File(["png"], "shot.png", { type: "image/png" });

    fireEvent.drop(screen.getByLabelText("Your feedback"), { dataTransfer: { files: [file], types: ["Files"] } });
};

afterEach(() => {
    submit.mockReset();
});

describe("send feedback dialog", () => {
    it("locks the images and the page choice while sending, and stays open on Escape", async () => {
        submit.mockReturnValue(
            new Promise(() => {
                // Never settles: the send stays in flight.
            }),
        );
        URL.createObjectURL = vi.fn(() => "blob:preview");

        const { onOpenChange } = renderDialog();

        dropFile();
        fireEvent.change(screen.getByLabelText("Your feedback"), { target: { value: "It broke" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));

        await waitFor(() => {
            expect((screen.getByRole("button", { name: "Remove attachment 1" }) as HTMLButtonElement).disabled).toBe(true);
        });
        expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).toBe("true");

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

    it("leaves a drop of text to the text box", () => {
        renderDialog();

        const textarea = screen.getByLabelText("Your feedback");
        const drop = createEvent.drop(textarea, { dataTransfer: { files: [], types: ["text/plain"] } });

        fireEvent(textarea, drop);

        expect(drop.defaultPrevented).toBe(false);
    });
});
