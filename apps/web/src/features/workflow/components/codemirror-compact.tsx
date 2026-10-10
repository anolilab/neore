"use client";

/**
 * Compact CodeMirror editor for workflow nodes.
 * Lightweight code editing with syntax highlighting.
 */

import { oneDark } from "@codemirror/theme-one-dark";
import cn from "@neore/ui/utils/cn";
import type { Extension } from "@uiw/react-codemirror";
import CodeMirror from "@uiw/react-codemirror";
import { useTheme } from "next-themes";
import type { FC } from "react";
import { memo, useCallback, useEffect, useState } from "react";

import loadLanguageExtension from "../../canvas/lib/codemirror-languages";

interface CodemirrorCompactProps {
    className?: string;
    height?: string;
    language: string;
    onChange?: (value: string) => void;
    readOnly?: boolean;
    showLineNumbers?: boolean;
    value: string;
}

const CodemirrorCompact: FC<CodemirrorCompactProps> = memo(
    ({ className, height = "120px", language, onChange, readOnly = false, showLineNumbers = false, value }) => {
        const { resolvedTheme } = useTheme();
        const isDark = resolvedTheme === "dark";
        const [langExtension, setLangExtension] = useState<Extension | null>(null);

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

        const handleChange = useCallback(
            (value_: string) => {
                onChange?.(value_);
            },
            [onChange],
        );

        const extensions: Extension[] = [];

        if (langExtension) {
            extensions.push(langExtension);
        }

        if (isDark) {
            extensions.push(oneDark);
        }

        return (
            <div className={cn("overflow-hidden rounded-md border", isDark ? "bg-[#282c34]" : "bg-white", className)}>
                <CodeMirror
                    basicSetup={{
                        autocompletion: false,
                        bracketMatching: true,
                        closeBrackets: true,
                        foldGutter: false,
                        highlightActiveLine: !readOnly,
                        highlightSelectionMatches: false,
                        indentOnInput: true,
                        lineNumbers: showLineNumbers,
                        searchKeymap: false,
                    }}
                    className="text-xs"
                    editable={!readOnly}
                    extensions={extensions}
                    height={height}
                    onChange={handleChange}
                    theme={isDark ? "dark" : "light"}
                    value={value}
                />
            </div>
        );
    },
);

CodemirrorCompact.displayName = "CodemirrorCompact";
export default CodemirrorCompact;
