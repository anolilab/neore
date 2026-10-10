"use client";

/**
 * Canvas CodeMirror Editor - Full-featured code editor with syntax highlighting.
 * Uses CodeMirror 6 via `@uiw/react-codemirror` for interactive editing.
 */

import { oneDark } from "@codemirror/theme-one-dark";
import cn from "@neore/ui/utils/cn";
import type { Extension } from "@uiw/react-codemirror";
import CodeMirror from "@uiw/react-codemirror";
import { useTheme } from "next-themes";
import type { FC } from "react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import loadLanguageExtension from "../lib/codemirror-languages";

interface CanvasCodemirrorEditorProps {
    className?: string;
    content: string;
    language: string;
    onSave?: (content: string) => void;
    readOnly?: boolean;
}

const AUTOSAVE_DEBOUNCE_MS = 1500;

const CanvasCodemirrorEditor: FC<CanvasCodemirrorEditorProps> = memo(({ className, content, language, onSave, readOnly = false }) => {
    const { resolvedTheme } = useTheme();
    const isDark = resolvedTheme === "dark";
    const [langExtension, setLangExtension] = useState<Extension | null>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
    const latestContentRef = useRef(content);

    // Load language extension dynamically
    useEffect(() => {
        let isCancelled = false;

        loadLanguageExtension(language)
            .then((extension) => {
                if (!isCancelled) {
                    setLangExtension(extension);
                }

                return extension;
            })
            .catch(() => {
                // Grammar failed to load — the editor stays unhighlighted.
            });

        return () => {
            isCancelled = true;
        };
    }, [language]);

    // Clean up debounce on unmount
    useEffect(
        () => () => {
            if (debounceRef.current) {
                clearTimeout(debounceRef.current);
            }
        },
        [],
    );

    const handleChange = useCallback(
        (value: string) => {
            latestContentRef.current = value;

            if (!onSave) {
                return;
            }

            if (debounceRef.current) {
                clearTimeout(debounceRef.current);
            }

            debounceRef.current = setTimeout(() => {
                onSave(value);
            }, AUTOSAVE_DEBOUNCE_MS);
        },
        [onSave],
    );

    const extensions: Extension[] = [];

    if (langExtension) {
        extensions.push(langExtension);
    }

    if (isDark) {
        extensions.push(oneDark);
    }

    return (
        <div className={cn("flex h-full w-full flex-col", className)}>
            <CodeMirror
                basicSetup={{
                    foldGutter: !readOnly,
                    highlightActiveLine: !readOnly,
                    highlightSelectionMatches: !readOnly,
                    lineNumbers: true,
                    searchKeymap: true,
                }}
                className="flex-1 text-sm"
                editable={!readOnly}
                extensions={extensions}
                height="100%"
                onChange={handleChange}
                theme={isDark ? "dark" : "light"}
                value={content}
                width="100%"
            />
        </div>
    );
});

CanvasCodemirrorEditor.displayName = "CanvasCodemirrorEditor";

export default CanvasCodemirrorEditor;
