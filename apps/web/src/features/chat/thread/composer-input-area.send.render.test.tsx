// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
        const send = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;

        expect(send.disabled).toBe(false);

        fireEvent.click(send);

        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it("announces that a send is waiting, in a live region that is always there", () => {
        renderArea({ isSendWaiting: true, isUploading: true, value: "see the file" });

        expect(screen.getByText("Sending once uploads finish…", { selector: "[aria-live='polite']" })).toBeTruthy();
    });

    it("shows on the queue button, while a reply streams, that a send now waits for the uploads", async () => {
        // The tooltip positions itself with a ResizeObserver, which the shared jsdom setup stubs as a plain function.
        vi.stubGlobal(
            "ResizeObserver",
            // eslint-disable-next-line prefer-arrow-callback -- the tooltip calls `new ResizeObserver()`, which an arrow function cannot serve
            vi.fn(function ResizeObserver() {
                return { disconnect: vi.fn(), observe: vi.fn(), unobserve: vi.fn() };
            }),
        );

        render(
            <ComposerInputArea
                canQueueWhileStreaming
                isSendWaiting
                isStreaming
                isUploading
                onCancel={() => {}}
                onChange={() => {}}
                onSubmit={() => {}}
                value="see the file"
            />,
        );

        fireEvent.focus(screen.getByRole("button", { name: "Waiting for uploads to complete…" }));

        await waitFor(() => {
            // Once in the live region, which is always there, and once in the queue button's tooltip.
            expect(screen.getAllByText("Sending once uploads finish…")).toHaveLength(2);
        });
    });

    it("keeps the live region empty when no send waits", () => {
        renderArea({ isUploading: true });

        expect(screen.queryByText("Sending once uploads finish…", { selector: "[aria-live='polite']" })).toBeNull();
    });
});
