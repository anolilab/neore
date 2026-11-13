/**
 * The React Compiler options of the web build: `vite.config.ts` hands them to `react({ compiler })` (the compiler's
 * native port), and `scripts/react-compiler-bailouts.test.ts` compiles with them too, so the test checks what ships.
 *
 * `validateExhaustiveMemoizationDependencies` is off, as in the Babel compiler the build used before, which does not
 * run that check: with it on, the port skips hand-memoized hooks such as `useThreadGroups` and `DataGridRow`.
 */
const reactCompilerOptions = {
    environment: { validateExhaustiveMemoizationDependencies: false },
    target: "19",
} as const;

export default reactCompilerOptions;
