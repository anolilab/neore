import type { Components } from "streamdown";

import { ChatCode, ChatTable } from "./chat-markdown";

/** Pass as `components` to a chat `Streamdown`. A stable module-level object, so memoised renderers are not disturbed. */
export const chatMarkdownComponents: Components = {
    code: ChatCode,
    table: ChatTable,
};
