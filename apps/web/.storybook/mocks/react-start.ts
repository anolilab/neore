/**
 * `@tanstack/react-start` for Storybook, where there is no Start server. A server
 * function resolves to `undefined` (a story that needs an answer mocks the module that
 * defines it, as `server-functions.ts` here does); an isomorphic function runs its
 * client half, as it would in the browser.
 */

type AnyFunction = (...args: never[]) => unknown;

interface ServerFunctionBuilder {
    handler: (implementation: AnyFunction) => (...args: unknown[]) => Promise<undefined>;
    inputValidator: () => ServerFunctionBuilder;
    middleware: () => ServerFunctionBuilder;
    validator: () => ServerFunctionBuilder;
}

// eslint-disable-next-line unicorn/name-replacements -- the name of the export it stands in for
export const createServerFn = (): ServerFunctionBuilder => {
    const builder: ServerFunctionBuilder = {
        handler: () => async () => {
            console.warn("[storybook] a server function was called; it resolves to undefined here");

            return undefined;
        },
        inputValidator: () => builder,
        middleware: () => builder,
        validator: () => builder,
    };

    return builder;
};

interface IsomorphicFunctionBuilder {
    (): undefined;
    client: (implementation: AnyFunction) => AnyFunction & { server: () => AnyFunction };
    server: (implementation: AnyFunction) => IsomorphicFunctionBuilder;
}

// eslint-disable-next-line unicorn/name-replacements -- the name of the export it stands in for
export const createIsomorphicFn = (): IsomorphicFunctionBuilder => {
    const withClient = (implementation: AnyFunction) => Object.assign(implementation, { server: () => implementation });
    const builder = Object.assign(() => undefined, {
        client: withClient,
        server: () => builder,
    }) as IsomorphicFunctionBuilder;

    return builder;
};

export const getGlobalStartContext = (): undefined => undefined;
