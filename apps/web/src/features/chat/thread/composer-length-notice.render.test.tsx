// @vitest-environment jsdom

import { MAX_PROMPT_CHARS } from "@neore/ai/constants";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ComposerInputArea from "./composer-input-area";
import { ComposerLengthNotice } from "./composer-length-notice";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});
vi.mock("./composer-tiptap/composer-tiptap-editor", () => {
    return {
        ComposerTiptapEditor: ({ describedBy, invalid }: { describedBy?: string; invalid?: boolean }) => (
            <div data-described-by={describedBy} data-invalid={String(Boolean(invalid))} data-testid="editor" />
        ),
    };
});

describe("ComposerLengthNotice", () => {
    it("renders nothing at the cap", () => {
        render(<ComposerLengthNotice chars={MAX_PROMPT_CHARS} onAttachAsFile={() => {}} />);

        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("names the cap and offers the file once over it", () => {
        const onAttachAsFile = vi.fn();

        render(<ComposerLengthNotice chars={MAX_PROMPT_CHARS + 1} onAttachAsFile={onAttachAsFile} />);

        expect(screen.getByRole("alert").textContent).toContain("100,000");

        fireEvent.click(screen.getByRole("button", { name: "Attach as file" }));

        expect(onAttachAsFile).toHaveBeenCalledTimes(1);
    });

    it("offers no file where the text cannot become one", () => {
        render(<ComposerLengthNotice chars={MAX_PROMPT_CHARS + 1} />);

        expect(screen.getByRole("alert").textContent).toContain("100,000");
        expect(screen.queryByRole("button")).toBeNull();
    });
});

describe("ComposerLengthNotice live region", () => {
    it("keeps the alert text the same while the count grows, and shows the count outside it", () => {
        const { rerender } = render(<ComposerLengthNotice chars={MAX_PROMPT_CHARS + 1} onAttachAsFile={() => {}} />);
        const before = screen.getByRole("alert").textContent;

        rerender(<ComposerLengthNotice chars={MAX_PROMPT_CHARS + 2} onAttachAsFile={() => {}} />);

        expect(screen.getByRole("alert").textContent).toBe(before);
        expect(screen.getByRole("alert").textContent).not.toContain("100,002");
        expect(screen.getByText("100,002 characters now.")).toBeTruthy();
    });
});

describe("ComposerLengthNotice when the file would not fit either", () => {
    it("says so and offers no file", () => {
        render(<ComposerLengthNotice chars={MAX_PROMPT_CHARS + 1} onAttachAsFile={() => {}} tooLongForFile />);

        expect(screen.getByRole("alert").textContent).toContain("too long to send even as a file");
        expect(screen.queryByRole("button")).toBeNull();
    });
});

describe("the composer over the cap", () => {
    const over = "x".repeat(MAX_PROMPT_CHARS + 5);

    it("disables Send and points it at the notice", () => {
        render(<ComposerInputArea onChange={() => {}} onSubmit={() => {}} value={over} />);

        const send = screen.getByRole("button", { name: "Send message" });

        expect((send as HTMLButtonElement).disabled).toBe(true);
        expect(send.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
    });

    it("keeps Send enabled at the cap", () => {
        render(<ComposerInputArea onChange={() => {}} onSubmit={() => {}} value={"x".repeat(MAX_PROMPT_CHARS)} />);

        expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("disables Queue and Steer too while a reply streams", () => {
        render(
            <ComposerInputArea canQueueWhileStreaming followUp="steer" isStreaming onChange={() => {}} onSteer={() => {}} onSubmit={() => {}} value={over} />,
        );

        expect((screen.getByRole("button", { name: "Queue message" }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole("button", { name: "Steer the reply" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("shows the cap under the input", () => {
        render(<ComposerInputArea onAttachDraftAsFile={() => {}} onChange={() => {}} onSubmit={() => {}} value={"x".repeat(MAX_PROMPT_CHARS + 5)} />);

        expect(screen.getByRole("alert").textContent).toContain("100,000");
    });

    it("points the editor at the notice and marks it invalid", () => {
        render(<ComposerInputArea onChange={() => {}} onSubmit={() => {}} value={over} />);

        const editor = screen.getByTestId("editor");

        expect(editor.dataset.describedBy).toBe(screen.getByRole("alert").id);
        expect(editor.dataset.invalid).toBe("true");
    });

    it("leaves the editor undescribed and valid under the cap", () => {
        render(<ComposerInputArea onChange={() => {}} onSubmit={() => {}} value="hi" />);

        const editor = screen.getByTestId("editor");

        expect(Object.hasOwn(editor.dataset, "describedBy")).toBe(false);
        expect(editor.dataset.invalid).toBe("false");
    });
});

describe("an attachment-only draft", () => {
    it("shows an enabled Send control", () => {
        render(<ComposerInputArea hasAttachments onChange={() => {}} onSubmit={() => {}} value="" />);

        expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("shows no Send control with neither text nor attachments", () => {
        render(<ComposerInputArea onChange={() => {}} onSubmit={() => {}} value="" />);

        expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    });
});
