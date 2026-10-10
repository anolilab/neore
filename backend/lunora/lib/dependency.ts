import { LunoraError } from "lunorash/server";

/**
 * Runs one outbound call (a fetch, a mail send, a queue or storage write, a
 * model call). A failure there is rethrown as a coded `SERVICE_UNAVAILABLE`
 * that names the dependency, so the caller can tell which one broke. A coded
 * error from the call passes through unchanged.
 */
export const withDependency = async <T>(dependency: string, call: () => T): Promise<Awaited<T>> => {
    try {
        return await call();
    } catch (error) {
        if (error instanceof LunoraError) {
            throw error;
        }

        throw new LunoraError("SERVICE_UNAVAILABLE", `${dependency} failed`, { cause: error });
    }
};
