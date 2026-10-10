/**
 * `@ungap/structured-clone` ships no type declarations and there is no
 * `@types/ungap__structured-clone` package, so the `structuredClone` polyfill import in
 * `src/lib/agent/use-streaming-uimessages.ts` has nothing to resolve against.
 *
 * Only the default export is used; it is the standard `structuredClone` signature.
 */
declare module "@ungap/structured-clone" {
    const structuredClone: <T>(value: T, options?: { lossy?: boolean; transfer?: Transferable[] }) => T;

    export default structuredClone;
}
