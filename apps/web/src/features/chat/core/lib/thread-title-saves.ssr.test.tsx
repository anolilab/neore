// @vitest-environment node

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { titleOnScreen, useTitleSaveRevision } from "./thread-title-saves";

/** A component that reads the save coordinator while it renders, as the header and the thread list do. */
const Reader = ({ threadId, serverTitle }: { serverTitle: string; threadId: string }) => {
    useTitleSaveRevision();

    return <span>{titleOnScreen(threadId, serverTitle)}</span>;
};

describe("the title coordinator on the server", () => {
    it("renders a component that reads it, with no browser APIs", () => {
        expect(renderToString(<Reader serverTitle="Server title" threadId="ssr-thread" />)).toContain("Server title");
    });
});
