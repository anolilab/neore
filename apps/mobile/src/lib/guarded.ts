/**
 * `try … finally` and `try … catch` for components and hooks. The React Compiler skips (leaves unmemoised) a component
 * or hook that holds a `finally`, a `try` without `catch`, or a `throw` or a condition inside a `try`. These live
 * outside any component, where the compiler does not look, so a screen calls them instead (`react-compiler.test.ts`).
 */

/** Runs `task`, then `onSettled` however it ended. The task's result or failure passes through unchanged. */
export const withFinally = async <T>(task: () => Promise<T>, onSettled: () => void): Promise<T> => {
    try {
        return await task();
    } finally {
        onSettled();
    }
};

/** Runs `task`; a failure goes to `onError`, whose result is returned in its place. */
export const withCatch = async <T, F>(task: () => Promise<T>, onError: (error: unknown) => F): Promise<F | T> => {
    try {
        return await task();
    } catch (error) {
        return onError(error);
    }
};
