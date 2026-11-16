"use client";

import { MarkdownBlockCacheContext, parseMarkdownBlock } from "@ui/utils/markdown-block-cache";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { ReactElement } from "react";
import { memo, use, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import type { BlockProps } from "streamdown";
import { Block } from "streamdown";

/** Options Streamdown's renderer applies that this one does not; a block with any of them renders through `Block`. */
const UNSUPPORTED_OPTIONS = ["allowElement", "allowedElements", "disallowedElements", "skipHtml", "urlTransform", "remarkRehypeOptions"] as const;

const isCacheable = (props: BlockProps): boolean =>
    !props.isIncomplete &&
    !props.animatePlugin &&
    !props.dir &&
    !props.shouldNormalizeHtmlIndentation &&
    typeof props.content === "string" &&
    UNSUPPORTED_OPTIONS.every((option) => props[option] === undefined);

const CachedBlock = (props: BlockProps): ReactElement => {
    const { components, content, rehypePlugins, remarkPlugins } = props;
    const enabled = use(MarkdownBlockCacheContext);
    // Decided once: a block that mounted while its reply streamed stays on `Block`, so the reply ending does not
    // remount it (and re-highlight its code).
    const [cacheable] = useState(() => enabled && isCacheable(props));

    if (!cacheable || !isCacheable(props)) {
        return <Block {...props} />;
    }

    const tree = parseMarkdownBlock(content, remarkPlugins ?? [], rehypePlugins ?? []);

    return toJsxRuntime(tree, {
        components,
        Fragment,
        ignoreInvalidStyle: true,
        jsx,
        jsxs,
        passKeys: true,
        passNode: true,
    });
};

/** A Streamdown `BlockComponent` that reuses the parsed tree of a finished reply's blocks; see `utils/markdown-block-cache.ts`. */
const CachedMarkdownBlock = memo(CachedBlock);

CachedMarkdownBlock.displayName = "CachedMarkdownBlock";

export default CachedMarkdownBlock;
