/**
 * An element that the converter has annotated while walking the tree. Rules
 * only ever receive elements; text nodes are annotated too but never reach a rule.
 * `Node` (see node.ts) adds these before any rule runs.
 */
export interface AnnotatedNode extends Element {
    flankingWhitespace: { leading: string; trailing: string };
    isBlank: boolean;
    isBlock: boolean;
    isCode: boolean;
}

export type ReplacementFunction = (content: string, node: AnnotatedNode, options: Options) => string;

export interface Options {
    blankReplacement: ReplacementFunction;
    br: string;
    bulletListMarker: string;
    codeBlockStyle: string;
    defaultReplacement: ReplacementFunction;
    emDelimiter: string;
    fence: string;
    headingStyle: string;
    hr: string;
    keepReplacement: ReplacementFunction;
    linkReferenceStyle: string;
    linkStyle: string;
    preformattedCode: boolean;
    rules?: Record<string, Rule>;
    strongDelimiter: string;
}

export type FilterFunction = (this: Rule, node: AnnotatedNode, options: Options) => boolean;

export interface Rule {
    append?: (options: Options) => string;
    filter?: string | string[] | FilterFunction;
    references?: string[];
    replacement: (this: Rule, content: string, node: AnnotatedNode, options: Options) => string;
}
