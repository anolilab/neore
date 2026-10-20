import type { ComponentProps, FC } from "react";
import type { Components, ExtraProps } from "streamdown";
import { defaultComponents } from "streamdown";

import { ChatCode, ChatTable } from "./chat-markdown";

type BlockTag = "blockquote" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "ol" | "p" | "ul";
type BlockProps<Tag extends BlockTag> = ComponentProps<Tag> & ExtraProps;

/**
 * Wraps one of Streamdown's block renderers so the browser picks that block's
 * direction from its own first strong character (`dir="auto"`). A reply that
 * mixes Hebrew or Arabic with English then lays out each paragraph the right way
 * round, whatever the UI direction is. Code blocks and tables are left alone.
 */
export const autoDirection = <Tag extends BlockTag>(tag: Tag): FC<BlockProps<Tag>> => {
    // Every block renderer spreads its props onto its element, so `dir` passes through.
    const Default = defaultComponents[tag] as FC<ExtraProps & { dir?: string }>;
    const AutoDirection: FC<BlockProps<Tag>> = (props) => <Default {...props} dir="auto" />;

    AutoDirection.displayName = `AutoDirection(${tag})`;

    return AutoDirection;
};

/** Pass as `components` to a chat `Streamdown`. A stable module-level object, so memoised renderers are not disturbed. */
export const chatMarkdownComponents: Components = {
    blockquote: autoDirection("blockquote"),
    code: ChatCode,
    h1: autoDirection("h1"),
    h2: autoDirection("h2"),
    h3: autoDirection("h3"),
    h4: autoDirection("h4"),
    h5: autoDirection("h5"),
    h6: autoDirection("h6"),
    ol: autoDirection("ol"),
    p: autoDirection("p"),
    table: ChatTable,
    ul: autoDirection("ul"),
};
