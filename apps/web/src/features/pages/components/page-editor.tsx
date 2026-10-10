"use client";

import { useLingui } from "@lingui/react/macro";
import type { ChangeCommit, TiptapCanvasEditorRef } from "@neore/ui/components/tiptap-canvas-editor";
import type { JSONContent } from "@tiptap/core";
import type { ComponentProps, FC, Ref } from "react";
import { lazy, Suspense } from "react";

import { CommentMark } from "../lib/comment-mark";

// Lazy for the same reason as the canvas: `reactjs-tiptap-editor` brings KaTeX.
const TiptapCanvasEditor = lazy(() =>
    import("@neore/ui/components/tiptap-canvas-editor").then((m) => {
        const Editor: FC<Omit<ComponentProps<typeof m.TiptapCanvasEditor>, "locale"> & { appLocale: string }> = ({ appLocale, ...props }) => (
            <m.TiptapCanvasEditor {...props} locale={m.EDITOR_LOCALE_MAP[appLocale] ?? "en"} />
        );

        return { default: Editor };
    }),
);

/** Read once at editor mount — a stable reference, so the editor is not rebuilt. */
const PAGE_EXTENSIONS = [CommentMark];

interface PageEditorProps {
    content: string | null;
    contentJson: JSONContent | undefined;
    editable: boolean;
    editorRef: Ref<TiptapCanvasEditorRef>;
    onSave: (markdown: string, json: JSONContent, commit?: ChangeCommit) => void;
}

const PageEditor: FC<PageEditorProps> = ({ content, contentJson, editable, editorRef, onSave }) => {
    const { i18n, t } = useLingui();

    return (
        <Suspense
            fallback={
                <div aria-live="polite" className="text-muted-foreground flex h-full items-center justify-center text-sm" role="status">
                    {t`Loading editor…`}
                </div>
            }
        >
            <TiptapCanvasEditor
                appLocale={i18n.locale}
                autoSaveDelay={1200}
                content={content ?? ""}
                contentJson={contentJson ?? null}
                editable={editable}
                extensions={PAGE_EXTENSIONS}
                onSave={onSave}
                ref={editorRef}
                toolbar
            />
        </Suspense>
    );
};

export default PageEditor;
