/** `@tanstack/react-start/server` for Storybook: only reached from the server half of an isomorphic function. */

const serverOnly = (name: string) => (): never => {
    throw new Error(`[storybook] ${name} is server-only`);
};

export const getRequest = serverOnly("getRequest");
export const getRequestHeaders = serverOnly("getRequestHeaders");
export const setResponseHeader = serverOnly("setResponseHeader");
