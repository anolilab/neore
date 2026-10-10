"use client";

/**
 * Canvas Code Diff Viewer — Inline code diff using CodeMirror's merge extension.
 * Shows a unified merge view with syntax highlighting for the original and modified code.
 */

import { unifiedMergeView } from "@codemirror/merge";
import { oneDark } from "@codemirror/theme-one-dark";
import cn from "@neore/ui/utils/cn";
import type { Extension } from "@uiw/react-codemirror";
import CodeMirror from "@uiw/react-codemirror";
import { useTheme } from "next-themes";
import type { FC } from "react";
import { memo, useEffect, useMemo, useState } from "react";

import loadLanguageExtension from "../lib/codemirror-languages";

interface CanvasCodeDiffViewerProps {
    className?: string;
    language?: string;
    modifiedContent: string;
    originalContent: string;
}

const CanvasCodeDiffViewer: FC<CanvasCodeDiffViewerProps> = memo(({ className, language = "plaintext", modifiedContent, originalContent }) => {
    const { resolvedTheme } = useTheme();
    const isDark = resolvedTheme === "dark";
    const [langExtension, setLangExtension] = useState<Extension | null>(null);

    useEffect(() => {
        let isCancelled = false;

        loadLanguageExtension(language)
            .then((extension) => {
                if (!isCancelled && extension) {
                    setLangExtension(extension);
                }

                return extension;
            })
            .catch(() => {
                // Grammar failed to load — the diff stays unhighlighted.
            });

        return () => {
            isCancelled = true;
        };
    }, [language]);

    const extensions = useMemo(() => {
        const extensionList: Extension[] = [
            unifiedMergeView({
                original: originalContent,
            }),
        ];

        if (langExtension) {
            extensionList.push(langExtension);
        }

        if (isDark) {
            extensionList.push(oneDark);
        }

        return extensionList;
    }, [originalContent, langExtension, isDark]);

    return (
        <div className={cn("h-full overflow-auto", className)}>
            <CodeMirror
                basicSetup={{
                    foldGutter: false,
                    highlightActiveLine: false,
                    lineNumbers: true,
                }}
                className="h-full text-sm"
                editable={false}
                extensions={extensions}
                theme={isDark ? "dark" : "light"}
                value={modifiedContent}
            />
        </div>
    );
});

CanvasCodeDiffViewer.displayName = "CanvasCodeDiffViewer";
export default CanvasCodeDiffViewer;
