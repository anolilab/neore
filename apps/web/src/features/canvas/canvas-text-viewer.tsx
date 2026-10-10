"use client";

/**
 * Canvas Text Viewer - Renders markdown content for text documents.
 * Uses the same Streamdown markdown renderer used in chat messages.
 */

import cn from "@neore/ui/utils/cn";
import type { FC } from "react";

interface CanvasTextViewerProps {
    className?: string;
    content: string;
}

const CanvasTextViewer: FC<CanvasTextViewerProps> = ({ className, content }) => (
    <div
        className={cn(
            "prose prose-slate dark:prose-invert max-w-none p-6",
            "prose-headings:font-semibold",
            "prose-code:before:content-[''] prose-code:after:content-['']",
            "prose-pre:bg-muted prose-pre:rounded-lg",
            className,
        )}
    >
        {/* Render as pre-formatted markdown content */}
        <div className="whitespace-pre-wrap">{content}</div>
    </div>
);

export default CanvasTextViewer;
