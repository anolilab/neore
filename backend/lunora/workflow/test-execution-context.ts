import type { ExecutionContext } from "./core";

/** A bare execution context for tests: no outputs, the run id `run`, and the given overrides. */
export const executionContextOf = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => {
    return {
        graph: { edges: [], nodes: [] },
        nodeOutputs: {},
        runId: "run",
        variables: {},
        ...overrides,
    };
};
