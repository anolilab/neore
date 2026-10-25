"use client";

/**
 * Mermaid diagram preview — code-split, lazy-loaded.
 *
 * The source is rendered as a fenced block through Streamdown, so Mermaid is
 * reached only through `useStreamdownPlugins`, which loads it on demand. The
 * Mermaid config is the one the chat uses (`message-content.tsx`): the plugin's
 * default `securityLevel: "strict"` applies, which encodes HTML in labels and
 * disables click handlers. The raw source sits behind a disclosure.
 *
 * NOT exported from the barrel index. Import directly:
 *
 * ```tsx
 * const MermaidPreview = lazy(() => import("@neore/ui/components/file-renderers/mermaid-preview"));
 * ```
 */

import { useLingui } from "@lingui/react/macro";
import { useFetchedText } from "@ui/hooks/use-fetched-text";
import useStreamdownAppearance from "@ui/hooks/use-streamdown-appearance";
import useStreamdownPlugins from "@ui/hooks/use-streamdown-plugins";
import cn from "@ui/utils/cn";
import type { FC } from "react";
import { memo, useMemo } from "react";
import { Streamdown } from "streamdown";

import { toMermaidFence } from "./mermaid-fence";
import { TextFileLoading, TextFileUnavailable } from "./text-file-states";

export interface MermaidPreviewProps {
    className?: string;
    filename?: string;
    url: string;
}

const MermaidPreview: FC<MermaidPreviewProps> = memo(({ className, filename, url }) => {
    const { t } = useLingui();
    const fetched = useFetchedText(url);
    const source = fetched.status === "ready" ? fetched.text : undefined;
    const fenced = useMemo(() => (source === undefined ? "" : toMermaidFence(source)), [source]);
    const plugins = useStreamdownPlugins(fenced);
    // The same Mermaid config the chat passes (`message-content.tsx`), so a diagram looks the same in both places.
    const { mermaidTheme } = useStreamdownAppearance();
    const mermaid = useMemo(() => {
        return { config: { theme: mermaidTheme } };
    }, [mermaidTheme]);

    if (fetched.status === "error") {
        return <TextFileUnavailable className={className} filename={filename} url={url} />;
    }

    if (source === undefined) {
        return <TextFileLoading />;
    }

    return (
        <div className={cn("my-2 w-full max-w-2xl overflow-hidden rounded-lg border", className)}>
            <div className="bg-muted/50 border-b px-3 py-1.5 text-xs font-medium">{filename || t`Diagram`}</div>

            <div className="overflow-auto p-4">
                <Streamdown mermaid={mermaid} plugins={plugins}>
                    {fenced}
                </Streamdown>
            </div>

            <details className="border-t px-3 py-2 text-xs">
                <summary className="cursor-pointer select-none">{t`Show source`}</summary>
                <pre className="mt-2 max-h-96 overflow-auto font-mono whitespace-pre-wrap">
                    <code>{source}</code>
                </pre>
            </details>
        </div>
    );
});

MermaidPreview.displayName = "MermaidPreview";

export default MermaidPreview;
