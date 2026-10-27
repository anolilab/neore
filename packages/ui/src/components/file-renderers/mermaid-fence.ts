/**
 * Wraps a Mermaid source as a fenced markdown block for Streamdown, which renders
 * it through the lazily loaded Mermaid plugin.
 *
 * The fence is one backtick longer than the longest run in the source, so a
 * source that itself contains a fence cannot close the block early. The fence
 * stays a backtick fence, because the heavy-plugin check looks for a backtick mermaid fence.
 */
export const toMermaidFence = (source: string): string => {
    const runs = source.match(/`+/g) ?? [];
    const longest = runs.reduce((max, run) => Math.max(max, run.length), 2);

    const fence = "`".repeat(longest + 1);

    return `${fence}mermaid\n${source}\n${fence}`;
};
