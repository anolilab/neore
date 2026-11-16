/**
 * Runs `task`, then `settle` however it ended: `try { await task() } finally { settle() }`.
 *
 * Components call this instead of writing the `finally` themselves: the React Compiler cannot lower a `try` with a
 * `finally` clause and skips the whole component that has one (it then re-renders unmemoized on every parent render).
 */
const settle = async <T>(task: () => Promise<T>, onSettled: () => void): Promise<T> => {
    try {
        return await task();
    } finally {
        onSettled();
    }
};

export default settle;
