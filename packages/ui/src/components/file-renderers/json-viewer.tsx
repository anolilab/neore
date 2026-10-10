"use client";

/**
 * JSON Viewer
 *
 * Interactive, collapsible JSON tree viewer with syntax highlighting.
 * Features:
 * - Expand/collapse nodes
 * - Copy value on click
 * - Type-aware coloring (strings=green, numbers=blue, booleans=purple, null=gray)
 * - Large array/object truncation with "show more" button
 * - Search/filter functionality
 */
import { plural } from "@lingui/core/macro";
import { Plural, useLingui } from "@lingui/react/macro";
import { ChevronDownIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import type { FC } from "react";
import { memo, useCallback, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JsonViewerProps {
    /** Additional CSS class. */
    className?: string;
    /** Dark mode. */
    darkMode?: boolean;
    /** JSON data to display (parsed object, array, or primitive). */
    data: unknown;
    /** Maximum initial depth to expand (default: 2). */
    defaultExpandDepth?: number;
    /** Maximum items to show before truncating (default: 100). */
    maxItems?: number;
    /** Called when a value is copied. */
    onCopy?: (path: string, value: unknown) => void;
    /** Root key name (default: "root"). */
    rootName?: string;
}

// ---------------------------------------------------------------------------
// Value Renderer
// ---------------------------------------------------------------------------

const TYPE_COLORS = {
    boolean: "text-purple-600 dark:text-purple-400",
    bracket: "text-gray-600 dark:text-gray-400",
    count: "text-gray-400 dark:text-gray-500 text-xs",
    key: "text-rose-600 dark:text-rose-400",
    null: "text-gray-500 dark:text-gray-500",
    number: "text-blue-600 dark:text-blue-400",
    string: "text-green-600 dark:text-green-400",
};

const getValueColor = (value: unknown): string => {
    if (value === null || value === undefined) {
        return TYPE_COLORS.null;
    }

    if (typeof value === "string") {
        return TYPE_COLORS.string;
    }

    if (typeof value === "number") {
        return TYPE_COLORS.number;
    }

    if (typeof value === "boolean") {
        return TYPE_COLORS.boolean;
    }

    return "";
};

const formatValue = (value: unknown): string => {
    if (value === null) {
        return "null";
    }

    if (value === undefined) {
        return "undefined";
    }

    if (typeof value === "string") {
        // Truncate long strings
        if (value.length > 200) return `"${value.slice(0, 200)}…"`;

        return `"${value}"`;
    }

    return String(value);
};

// ---------------------------------------------------------------------------
// Tree Node
// ---------------------------------------------------------------------------

const JsonNode: FC<{
    defaultExpandDepth: number;
    depth: number;
    isLast: boolean;
    keyName: string | number;
    maxItems: number;
    onCopy?: (path: string, value: unknown) => void;
    path: string;
    value: unknown;
}> = memo(({ defaultExpandDepth, depth, isLast, keyName, maxItems, onCopy, path, value }) => {
    const { t } = useLingui();
    const [expanded, setExpanded] = useState(depth < defaultExpandDepth);
    const [showAll, setShowAll] = useState(false);
    const [copied, setCopied] = useState(false);

    const objectValue = value !== null && typeof value === "object" ? value : null;
    const isExpandable = objectValue !== null;
    const entries = objectValue === null ? [] : Object.entries(objectValue);
    const isArray = Array.isArray(value);
    const itemCount = entries.length;
    const displayEntries = showAll ? entries : entries.slice(0, maxItems);
    const hasMore = !showAll && entries.length > maxItems;

    const handleCopy = useCallback(async () => {
        const text = JSON.stringify(value, null, 2);

        await navigator.clipboard.writeText(text);

        setCopied(true);
        setTimeout(setCopied, 1500, false);
        onCopy?.(path, value);
    }, [value, path, onCopy]);

    const indent = depth * 16;
    const comma = isLast ? "" : ",";

    if (!isExpandable) {
        return (
            <div className="group flex items-center hover:bg-gray-50 dark:hover:bg-gray-800/50" style={{ paddingLeft: indent }}>
                <span className={TYPE_COLORS.key}>&quot;{keyName}&quot;</span>
                <span className={TYPE_COLORS.bracket}>: </span>
                <span className={getValueColor(value)}>{formatValue(value)}</span>
                <span className={TYPE_COLORS.bracket}>{comma}</span>
                <button aria-label={t`Copy value`} className="ml-2 opacity-0 transition-opacity group-hover:opacity-100" onClick={handleCopy} type="button">
                    <CopyIcon aria-hidden="true" className={`h-3 w-3 ${copied ? "text-green-500" : "text-gray-400"}`} />
                </button>
            </div>
        );
    }

    const nodeName = typeof keyName === "string" ? keyName : t`Item ${keyName}`;
    const nodeLabel = isArray
        ? // eslint-disable-next-line no-restricted-syntax -- a Lingui plural must be the whole message of `t`
          t`${plural(itemCount, { one: `${nodeName}: array with # item`, other: `${nodeName}: array with # items` })}`
        : // eslint-disable-next-line no-restricted-syntax -- a Lingui plural must be the whole message of `t`
          t`${plural(itemCount, { one: `${nodeName}: object with # item`, other: `${nodeName}: object with # items` })}`;
    const moreCount = entries.length - maxItems;
    const openBracket = isArray ? "[" : "{";
    const closeBracket = isArray ? "]" : "}";

    return (
        <div>
            <div
                aria-expanded={expanded}
                aria-label={nodeLabel}
                className="group flex cursor-pointer items-center hover:bg-gray-50 dark:hover:bg-gray-800/50"
                onClick={() => setExpanded(!expanded)}
                onKeyDown={(e) => {
                    if (!(e.key === "Enter" || e.key === " ")) {
                        return;
                    }

                    e.preventDefault();
                    setExpanded(!expanded);
                }}
                role="button"
                style={{ paddingLeft: indent }}
                tabIndex={0}
            >
                {expanded ? (
                    <ChevronDownIcon aria-hidden="true" className="mr-1 h-3 w-3 flex-shrink-0 text-gray-400" />
                ) : (
                    <ChevronRightIcon aria-hidden="true" className="mr-1 h-3 w-3 flex-shrink-0 text-gray-400" />
                )}
                {typeof keyName === "string" && <span className={TYPE_COLORS.key}>&quot;{keyName}&quot;</span>}
                {typeof keyName === "string" && <span className={TYPE_COLORS.bracket}>: </span>}
                <span className={TYPE_COLORS.bracket}>{openBracket}</span>
                {!expanded && (
                    <>
                        <span className={TYPE_COLORS.count}>
                            {" "}
                            <Plural one="# item" other="# items" value={itemCount} />{" "}
                        </span>
                        <span className={TYPE_COLORS.bracket}>
                            {closeBracket}
                            {comma}
                        </span>
                    </>
                )}
                <button
                    aria-label={t`Copy object`}
                    className="ml-2 opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={(e) => {
                        e.stopPropagation();
                        handleCopy();
                    }}
                    type="button"
                >
                    <CopyIcon aria-hidden="true" className={`h-3 w-3 ${copied ? "text-green-500" : "text-gray-400"}`} />
                </button>
            </div>
            {expanded && (
                <>
                    {displayEntries.map(([k, v], i) => (
                        <JsonNode
                            defaultExpandDepth={defaultExpandDepth}
                            depth={depth + 1}
                            isLast={i === displayEntries.length - 1 && !hasMore}
                            key={k}
                            keyName={isArray ? i : k}
                            maxItems={maxItems}
                            onCopy={onCopy}
                            path={`${path}.${k}`}
                            value={v}
                        />
                    ))}
                    {hasMore && (
                        <div style={{ paddingLeft: (depth + 1) * 16 }}>
                            <button className="text-xs text-blue-500 hover:text-blue-700 dark:text-blue-400" onClick={() => setShowAll(true)} type="button">
                                … <Plural one="# more item" other="# more items" value={moreCount} />
                            </button>
                        </div>
                    )}
                    <div style={{ paddingLeft: indent }}>
                        <span className={TYPE_COLORS.bracket}>
                            {closeBracket}
                            {comma}
                        </span>
                    </div>
                </>
            )}
        </div>
    );
});

JsonNode.displayName = "JsonNode";

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

const JsonViewer: FC<JsonViewerProps> = memo(({ className, data, defaultExpandDepth = 2, maxItems = 100, onCopy, rootName = "root" }) => {
    const parsedData = useMemo(() => {
        if (typeof data === "string") {
            try {
                return JSON.parse(data);
            } catch {
                return data;
            }
        }

        return data;
    }, [data]);

    return (
        <div className={`overflow-auto font-mono text-sm leading-relaxed ${className ?? ""}`}>
            <JsonNode
                defaultExpandDepth={defaultExpandDepth}
                depth={0}
                isLast
                keyName={rootName}
                maxItems={maxItems}
                onCopy={onCopy}
                path={rootName}
                value={parsedData}
            />
        </div>
    );
});

JsonViewer.displayName = "JsonViewer";

export { JsonViewer };
export type { JsonViewerProps };
