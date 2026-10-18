"use client";

/**
 * Compact CodeMirror editor for workflow nodes.
 * Lightweight code editing with syntax highlighting.
 */

import { oneDark } from "@codemirror/theme-one-dark";
import cn from "@neore/ui/utils/cn";
import type { Extension } from "@uiw/react-codemirror";
import CodeMirror, { EditorView, keymap, Prec } from "@uiw/react-codemirror";
import { useTheme } from "next-themes";
import type { FC } from "react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import loadLanguageExtension from "../../canvas/lib/codemirror-languages";
import { mentionExtensions } from "../utils/mention-editor";

interface CodemirrorCompactProps {
    /** Accessible name of the editor's content, when no visible label names it. */
    ariaLabel?: string;
    /** Id of the visible label that names the editor's content. */
    ariaLabelledBy?: string;
    className?: string;
    height?: string;
    language: string;
    /** Wrap long lines. Off for code, where a wrapped line reads as two. */
    lineWrapping?: boolean;
    /** Labels offered after `@`, and highlighted in the text. Leave unset for plain code. */
    mentionLabels?: ReadonlyArray<string>;
    onChange?: (value: string) => void;
    placeholder?: string;

    /**
     * A prose prompt: Tab moves focus out of the editor, as the form requires (WCAG 2.1.2), and
     * Mod+Enter runs the workflow instead of inserting a blank line.
     */
    prose?: boolean;
    readOnly?: boolean;
    showLineNumbers?: boolean;
    value: string;
}

const NO_LABELS: ReadonlyArray<string> = [];

// Handled (returns true) so CodeMirror's insertBlankLine does not run; the document shortcut still runs the workflow.
const PROSE_KEYMAP = Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => true }]));

const CodemirrorCompact: FC<CodemirrorCompactProps> = memo(
    ({
        ariaLabel,
        ariaLabelledBy,
        className,
        height = "120px",
        language,
        lineWrapping = false,
        mentionLabels,
        onChange,
        placeholder,
        prose = false,
        readOnly = false,
        showLineNumbers = false,
        value,
    }) => {
        const { resolvedTheme } = useTheme();
        const isDark = resolvedTheme === "dark";
        const [langExtension, setLangExtension] = useState<Extension | null>(null);
        const labels = mentionLabels ?? NO_LABELS;

        // One stable list: @uiw/react-codemirror reconfigures the editor whenever this array changes identity.
        const extensions = useMemo(() => {
            const list: Extension[] = [];

            if (langExtension) {
                list.push(langExtension);
            }

            if (isDark) {
                list.push(oneDark);
            }

            if (ariaLabel) {
                list.push(EditorView.contentAttributes.of({ "aria-label": ariaLabel }));
            }

            if (ariaLabelledBy) {
                list.push(EditorView.contentAttributes.of({ "aria-labelledby": ariaLabelledBy }));
            }

            if (lineWrapping) {
                list.push(EditorView.lineWrapping);
            }

            if (prose) {
                list.push(PROSE_KEYMAP);
            }

            list.push(...mentionExtensions(labels));

            return list;
        }, [ariaLabel, ariaLabelledBy, isDark, labels, langExtension, lineWrapping, prose]);

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

        return (
            <div className={cn("overflow-hidden rounded-md border", isDark ? "bg-[#282c34]" : "bg-white", className)}>
                <CodeMirror
                    basicSetup={{
                        autocompletion: labels.length > 0,
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
                    indentWithTab={!prose}
                    onChange={handleChange}
                    placeholder={placeholder}
                    theme={isDark ? "dark" : "light"}
                    value={value}
                />
            </div>
        );
    },
);

CodemirrorCompact.displayName = "CodemirrorCompact";
export default CodemirrorCompact;
