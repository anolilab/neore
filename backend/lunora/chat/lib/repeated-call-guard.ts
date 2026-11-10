/**
 * Ends a turn that keeps making the same tool call: one tool with identical arguments and an identical result
 * {@link REPEATED_CALL_LIMIT} times in a row, or two calls alternating A-B-A-B over {@link ALTERNATING_CALL_WINDOW} calls.
 * The step cap alone lets such a loop spend its whole budget before anything says why the turn ended.
 *
 * A call is the same call when its tool name, its input (object keys sorted, so another key order is the same call) and its
 * result all match: a stateful tool that returns something new each time, such as a browser scroll, is making progress. Only
 * the newest calls are walked, so a long turn costs no more per step than a short one. The arguments never reach the notice;
 * tool names are bounded and escaped before they are written.
 */

/** Identical calls in a row that end the turn. */
export const REPEATED_CALL_LIMIT = 3;

/** Calls in the latest window that end the turn when they alternate between two calls. A-B-A-B fits the default five-step cap. */
export const ALTERNATING_CALL_WINDOW = 4;

export type LoopFinding = { count: number; kind: "repeat"; toolName: string } | { kind: "alternate"; toolNames: [string, string] };

type ToolCallLike = { input?: unknown; toolCallId?: string; toolName: string };
type ToolResultLike = { output?: unknown; toolCallId: string };
type StepLike = { toolCalls?: ReadonlyArray<ToolCallLike>; toolResults?: ReadonlyArray<ToolResultLike> };

/** A call as the decision reads it: its comparison key and its name. */
type Walked = { key: string; toolName: string };

/** Code-unit order, the same in every runtime and locale. */
const byCodeUnit = (a: string, b: string): number => {
    if (a === b) {
        return 0;
    }

    return a < b ? -1 : 1;
};

/** The value with every object's keys in code-unit order, so the same value in another key order serialises the same. */
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

const callKey = (call: ToolCallLike, output: unknown): string =>
    `${call.toolName}\u{0}${JSON.stringify(sortKeys(call.input ?? null))}\u{0}${JSON.stringify(sortKeys(output ?? null))}`;

/** The calls of the finished steps, newest first, each keyed. Lazy: a call is keyed only when the decision reaches it. */
function* newestFirst(steps: ReadonlyArray<StepLike>): Generator<Walked> {
    for (let index = steps.length - 1; index >= 0; index -= 1) {
        const step = steps[index];
        const calls = step?.toolCalls ?? [];
        const outputs = new Map((step?.toolResults ?? []).map((result) => [result.toolCallId, result.output] as const));

        for (let position = calls.length - 1; position >= 0; position -= 1) {
            const call = calls[position];

            if (call) {
                const output = call.toolCallId === undefined ? undefined : outputs.get(call.toolCallId);

                yield { key: callKey(call, output), toolName: call.toolName };
            }
        }
    }
}

/**
 * The loop the finished steps end with, or `undefined`. Looks only at the latest calls, so a turn that repeated a call earlier and
 * then moved on is not stopped. Calls in one step count in the order the model made them.
 */
export const findRepeatedCallLoop = (steps: ReadonlyArray<StepLike>): LoopFinding | undefined => {
    // The newest calls, newest first: enough for the alternation window, and the whole run of the newest call for a repeat.
    const tail: Walked[] = [];
    let latest: Walked | undefined;
    let repeat = 0;
    let runOpen = true;

    for (const call of newestFirst(steps)) {
        latest ??= call;

        if (runOpen && call.key === latest.key) {
            repeat += 1;
        } else {
            runOpen = false;
        }

        if (tail.length < ALTERNATING_CALL_WINDOW) {
            tail.push(call);
        }

        if (!runOpen && tail.length >= ALTERNATING_CALL_WINDOW) {
            break;
        }
    }

    if (latest && repeat >= REPEATED_CALL_LIMIT) {
        return { count: repeat, kind: "repeat", toolName: latest.toolName };
    }

    if (tail.length === ALTERNATING_CALL_WINDOW) {
        const [newest, previous] = tail;

        if (newest && previous && newest.key !== previous.key && tail.every((call, index) => call.key === (index % 2 === 0 ? newest.key : previous.key))) {
            // Chronological order: the oldest of the window comes first.
            const oldest = tail[ALTERNATING_CALL_WINDOW - 1];
            const next = tail[ALTERNATING_CALL_WINDOW - 2];

            if (oldest && next) {
                return { kind: "alternate", toolNames: [oldest.toolName, next.toolName] };
            }
        }
    }

    return undefined;
};

/** A tool name as it reads in a notice: bounded, with control characters blanked and Markdown metacharacters escaped. */
const NAME_MAX = 50;
const CONTROL = /\p{Cc}/gu;
const MARKDOWN = /[\\`*_[\]()<>!#|~]/gu;

export const displayName = (name: string): string => {
    const bounded = name.length > NAME_MAX ? `${name.slice(0, NAME_MAX)}…` : name;

    return bounded.replaceAll(CONTROL, " ").replaceAll(MARKDOWN, String.raw`\$&`);
};

/** The assistant text that ends a looping turn: it names the tool or the two tools, and nothing of their arguments. */
export const loopNoticeText = (finding: LoopFinding): string => {
    if (finding.kind === "repeat") {
        return `I stopped this reply: "${displayName(finding.toolName)}" was called ${finding.count} times in a row with the same arguments and no progress. Tell me what to do differently and I will continue.`;
    }

    return `I stopped this reply: "${displayName(finding.toolNames[0])}" and "${displayName(finding.toolNames[1])}" kept alternating with no progress. Tell me what to do differently and I will continue.`;
};
