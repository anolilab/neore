import type { Components } from "streamdown";

import { autoDirection, ChatCode, ChatTable } from "./chat-markdown";

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
