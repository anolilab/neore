"use client";

/**
 * Mermaid diagram preview — code-split, lazy-loaded.
 *
 * The source is rendered as a fenced block through Streamdown, so Mermaid is
 * reached only through `useStreamdownPlugins`, which loads it on demand. The
 * Mermaid config is the chat's (`useStreamdownAppearance`): the plugin's
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
import useStreamdownAppearance from "@ui/hooks/use-streamdown-appearance";
import useStreamdownPlugins from "@ui/hooks/use-streamdown-plugins";
import type { FC } from "react";
import { memo, useMemo } from "react";
import { Streamdown } from "streamdown";

import { FetchedTextPreview } from "./fetched-text-preview";
import { toMermaidFence } from "./mermaid-fence";

export interface MermaidPreviewProps {
    className?: string;
    filename?: string;
    url: string;
}

const MermaidDiagram: FC<{ source: string }> = ({ source }) => {
    const { t } = useLingui();
    const fenced = useMemo(() => toMermaidFence(source), [source]);
    const plugins = useStreamdownPlugins(fenced);
    const { mermaid } = useStreamdownAppearance();

    return (
        <>
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
        </>
    );
};

const MermaidPreview: FC<MermaidPreviewProps> = memo(({ className, filename, url }) => {
    const { t } = useLingui();

    return (
        <FetchedTextPreview className={className} fallbackName={t`Diagram`} filename={filename} url={url}>
            {(text) => <MermaidDiagram source={text} />}
        </FetchedTextPreview>
    );
});

MermaidPreview.displayName = "MermaidPreview";

export default MermaidPreview;
