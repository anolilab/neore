/**
 * Ends a turn that keeps making the same tool call: one tool with identical arguments {@link REPEATED_CALL_LIMIT} times in
 * a row, or two calls alternating A-B-A-B-A-B over {@link ALTERNATING_CALL_WINDOW} calls. The step cap alone lets such a
 * loop spend its whole budget before anything says why the turn ended.
 *
 * Calls are compared by tool name and by their input with object keys sorted, so the same arguments in another key order
 * are the same call. Only the names and this comparison are kept; the arguments never reach the notice.
 */

/** Identical calls in a row that end the turn. */
export const REPEATED_CALL_LIMIT = 3;

/** Calls in the latest window that end the turn when they alternate between two calls. */
export const ALTERNATING_CALL_WINDOW = 6;

export type LoopFinding = { count: number; kind: "repeat"; toolName: string } | { kind: "alternate"; toolNames: [string, string] };

type ToolCallLike = { input?: unknown; toolName: string };
type StepLike = { toolCalls?: ReadonlyArray<ToolCallLike> };

/** Code-unit order, the same in every runtime and locale. */
const byCodeUnit = (a: string, b: string): number => {
    if (a === b) {
        return 0;
    }

    return a < b ? -1 : 1;
};

/** The value with every object's keys in code-unit order, so the same input in another key order serialises the same. */
const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((item: unknown) => sortKeys(item));
    }

    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .toSorted(([left], [right]) => byCodeUnit(left, right))
                .map(([key, member]) => [key, sortKeys(member)]),
        );
    }

    return value;
};

const callKey = (call: ToolCallLike): string => `${call.toolName}\u{0}${JSON.stringify(sortKeys(call.input ?? null))}`;

/**
 * The loop the finished steps end with, or `undefined`. Looks only at the latest calls, so a turn that repeated a call
 * earlier and then moved on is not stopped. Calls in one step count in the order the model made them.
 */
export const findRepeatedCallLoop = (steps: ReadonlyArray<StepLike>): LoopFinding | undefined => {
    const calls = steps.flatMap((step) =>
        (step.toolCalls ?? []).map((call) => {
            return { key: callKey(call), toolName: call.toolName };
        }),
    );
    const latest = calls.at(-1);

    if (latest) {
        let count = 0;

        for (let index = calls.length - 1; index >= 0 && calls[index]?.key === latest.key; index -= 1) {
            count += 1;
        }

        if (count >= REPEATED_CALL_LIMIT) {
            return { count, kind: "repeat", toolName: latest.toolName };
        }
    }

    if (calls.length >= ALTERNATING_CALL_WINDOW) {
        const window = calls.slice(-ALTERNATING_CALL_WINDOW);
        const [first, second] = window;

        if (first && second && first.key !== second.key && window.every((call, index) => call.key === (index % 2 === 0 ? first.key : second.key))) {
            return { kind: "alternate", toolNames: [first.toolName, second.toolName] };
        }
    }

    return undefined;
};

/** The assistant text that ends a looping turn: it names the tool or the two tools, and nothing of their arguments. */
export const loopNoticeText = (finding: LoopFinding): string => {
    if (finding.kind === "repeat") {
        return `I stopped this reply: "${finding.toolName}" was called ${finding.count} times in a row with the same arguments and no progress. Tell me what to do differently and I will continue.`;
    }

    return `I stopped this reply: "${finding.toolNames[0]}" and "${finding.toolNames[1]}" kept alternating with no progress. Tell me what to do differently and I will continue.`;
};
