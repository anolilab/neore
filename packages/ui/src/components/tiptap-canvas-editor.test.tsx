// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { TiptapCanvasEditorRef } from "./tiptap-canvas-editor";
import { TiptapCanvasEditor } from "./tiptap-canvas-editor";

// eslint-disable-next-line no-restricted-syntax -- vi.mock is hoisted; there is nothing to inject into
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray) => strings.join("") };
        },
    };
});

// React only batches updates inside `act` when this flag is set.
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

describe(TiptapCanvasEditor, () => {
    it("saves an edit still waiting for its debounce when the editor goes away, so opening another page keeps it", async () => {
        const host = document.createElement("div");

        document.body.append(host);

        const root = createRoot(host);
        const ref = createRef<TiptapCanvasEditorRef>();
        const onSave = vi.fn();

        await act(async () => {
            root.render(<TiptapCanvasEditor autoSaveDelay={60_000} content="" onSave={onSave} ref={ref} />);
        });
        await act(async () => {
            ref.current?.editor?.commands.insertContent("Draft line");
        });

        expect(onSave).not.toHaveBeenCalled();

        act(() => root.unmount());
        host.remove();

        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onSave.mock.calls[0]?.[0]).toContain("Draft line");
    });
});
