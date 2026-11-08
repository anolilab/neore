// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { dismissToast } from "@/lib/toast";

import useBlockedPdfNoticeLifetime, { BLOCKED_PDF_NOTICE_ID } from "./use-blocked-pdf-notice";

vi.mock("@/lib/toast", () => {
    return { dismissToast: vi.fn() };
});

describe("the notice that an open document blocks a PDF", () => {
    beforeEach(() => {
        useChatUIStore.getState().reset();
        useChatUIStore.getState().closeCanvas();
        vi.mocked(dismissToast).mockClear();
    });

    it("stays while the document is open and goes when it closes", () => {
        useChatUIStore.getState().openCanvas("doc-1");
        renderHook(() => useBlockedPdfNoticeLifetime());

        expect(dismissToast).not.toHaveBeenCalled();

        act(() => {
            useChatUIStore.getState().closeCanvas();
        });

        expect(dismissToast).toHaveBeenCalledWith(BLOCKED_PDF_NOTICE_ID);
    });

    it("goes when a PDF takes the document's place", () => {
        useChatUIStore.getState().openCanvas("doc-1");
        renderHook(() => useBlockedPdfNoticeLifetime());

        act(() => {
            useChatUIStore.getState().openPreviewFile({ filename: "a.pdf", threadId: "thread-1", url: "https://files.example/a.pdf" });
        });

        expect(dismissToast).toHaveBeenCalledWith(BLOCKED_PDF_NOTICE_ID);
    });

    it("goes when the chat view leaves while a document is still open", () => {
        useChatUIStore.getState().openCanvas("doc-1");
        const { unmount } = renderHook(() => useBlockedPdfNoticeLifetime());

        unmount();

        expect(dismissToast).toHaveBeenCalledWith(BLOCKED_PDF_NOTICE_ID);
    });
});
