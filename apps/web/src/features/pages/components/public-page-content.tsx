"use client";

import type { JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import type { FC } from "react";

import { getCanvasExtensions } from "@/features/canvas/lib/tiptap-extensions";

/** A read-only render of a page document. Default export for `lazy()`. */
const PublicPageContent: FC<{ content: JSONContent }> = ({ content }) => {
    const editor = useEditor({
        content,
        editable: false,
        extensions: getCanvasExtensions(),
        immediatelyRender: false,
    });

    return <EditorContent className="prose prose-slate dark:prose-invert max-w-none" editor={editor} />;
};

export default PublicPageContent;
