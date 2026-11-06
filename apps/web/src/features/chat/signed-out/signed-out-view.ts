/**
 * What a route under the chat layout shows a signed-out visitor while registration is invite-only:
 *
 * - `chat`: the chat itself (`/chat`, `/chat/<thread>`): the signed-out chat, where sending asks to sign in.
 * - `page`: a page that works signed out (`/workflow/shared/<token>`, read through a public action; only forking
 *   needs an account): the page itself.
 * - `sign-in`: anything else under the layout (the workflow editor, list, gallery): sign in first and come back.
 */
export type SignedOutView = "chat" | "page" | "sign-in";

const CHAT_PATH = /^\/chat(?:\/[^/]+)?\/?$/;
const SHARED_WORKFLOW_PATH = /^\/workflow\/shared\/[^/]+\/?$/;

export const signedOutViewFor = (pathname: string): SignedOutView => {
    if (CHAT_PATH.test(pathname)) {
        return "chat";
    }

    if (SHARED_WORKFLOW_PATH.test(pathname)) {
        return "page";
    }

    return "sign-in";
};
