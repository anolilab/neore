// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ComposerInputArea from "./composer-input-area";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("./composer-tiptap/composer-tiptap-editor", () => {
    return {
        ComposerTiptapEditor: () => <div data-testid="editor" />,
    };
});

const renderArea = (props: { isSendWaiting?: boolean; isUploading?: boolean; value?: string }) => {
    const onSubmit = vi.fn();

    render(
        <ComposerInputArea
            isSendWaiting={props.isSendWaiting}
            isUploading={props.isUploading}
            onChange={() => {}}
            onSubmit={onSubmit}
            value={props.value ?? ""}
        />,
    );

    return { onSubmit };
};

describe("send button while attachments upload", () => {
    it("is the plain send button when nothing uploads", () => {
        renderArea({ value: "hello" });

        expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
    });

    it("stays enabled during an upload, and says it will send when the uploads finish", () => {
        const { onSubmit } = renderArea({ isUploading: true });
        const send = screen.getByRole("button", { name: "Send when uploads finish" }) as HTMLButtonElement;

        expect(send.disabled).toBe(false);

        fireEvent.click(send);

        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it("shows the pending state once a send waits for the uploads", () => {
        renderArea({ isSendWaiting: true, isUploading: true, value: "see the file" });
        const send = screen.getByRole("button", { name: "Sending once uploads finish…" }) as HTMLButtonElement;

        expect(send.disabled).toBe(false);
    });

    it("announces that a send is waiting, in a live region that is always there", () => {
        renderArea({ isSendWaiting: true, isUploading: true, value: "see the file" });

        expect(screen.getByText("Sending once uploads finish…", { selector: "[role='status']" })).toBeTruthy();
    });

    it("keeps the live region empty when no send waits", () => {
        renderArea({ isUploading: true });

        expect(screen.queryByText("Sending once uploads finish…", { selector: "[role='status']" })).toBeNull();
    });
});
