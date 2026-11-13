import annotateNode from "./node";
import type { AnnotatedNode, Options, ReplacementFunction, Rule, RuleLookup } from "./types";

/**
 * Manages the rules used to convert HTML to Markdown: the built-in rules, then
 * the ones added with `addRule`, then keep/remove filters.
 */
export default class Rules implements RuleLookup {
    private readonly array: Rule[] = [];

    private readonly keepList: Rule[] = [];

    private readonly removeList: Rule[] = [];

    // The rule each node was given, or undefined when none matched. Keyed by node, so it lives with the parsed document.
    private readonly decided = new WeakMap<Node, Rule | undefined>();

    // The lists a node is searched in, in order: added and built-in rules, then keep, then remove.
    private readonly searchOrder: ReadonlyArray<ReadonlyArray<Rule>> = [this.array, this.keepList, this.removeList];

    private readonly options: Options;

    private readonly blankRule: Rule;

    private readonly keepReplacement: ReplacementFunction;

    private readonly defaultRule: Rule;

    constructor(options: Options) {
        this.options = options;
        this.blankRule = { replacement: options.blankReplacement };
        this.keepReplacement = options.keepReplacement;
        this.defaultRule = { replacement: options.defaultReplacement };

        const ruleTable: Record<string, Rule> = options.rules ?? {};

        for (const rule of Object.values(ruleTable)) {
            this.array.push(rule);
        }
    }

    add(_key: string, rule: Rule): void {
        this.array.unshift(rule);
    }

    keep(filter: Rule["filter"]): void {
        this.keepList.unshift({
            filter,
            replacement: this.keepReplacement,
        });
    }

    remove(filter: Rule["filter"]): void {
        this.removeList.unshift({
            filter,
            replacement: () => "",
        });
    }

    forNode(node: AnnotatedNode): Rule {
        if (node.isBlank) {
            return this.blankRule;
        }

        return decideRule(this.decided, this.searchOrder, node, this.options, this) ?? this.defaultRule;
    }

    /**
     * True when a rule of any kind, built-in, added, keep or remove, matches the node. A rule that must
     * decide whether to treat a node as transparent asks this first.
     */
    hasRuleFor(node: Node): boolean {
        // Only an element has a rule. A filter written for elements must not be handed a text node.
        if (node.nodeType !== 1) {
            return false;
        }

        return decideRule(this.decided, this.searchOrder, annotateNode(node, this.options), this.options, this) !== undefined;
    }

    forEach(visit: (rule: Rule, index: number) => void): void {
        this.array.forEach((rule, index) => {
            visit(rule, index);
        });
    }
}

/**
 * The first rule of any kind that matches the node, asked once per node. A filter can
 * be asked twice for one node (code-block detection, then traversal), and a second
 * answer that differs from the first would split the two. The first answer is kept.
 */
function decideRule(
    decided: WeakMap<Node, Rule | undefined>,
    searchOrder: ReadonlyArray<ReadonlyArray<Rule>>,
    node: AnnotatedNode,
    options: Options,
    lookup: RuleLookup,
): Rule | undefined {
    if (decided.has(node)) {
        return decided.get(node);
    }

    // Lowercased once for the node, not once per rule.
    const nodeName = node.nodeName.toLowerCase();

    for (const list of searchOrder) {
        const rule = findRule(list, node, nodeName, options, lookup);

        if (rule) {
            decided.set(node, rule);

            return rule;
        }
    }

    decided.set(node, undefined);

    return undefined;
}

function isFilterMatch(rule: Rule, node: AnnotatedNode, nodeName: string, options: Options, lookup: RuleLookup): boolean {
    const { filter } = rule;

    if (typeof filter === "string") {
        return filter === nodeName;
    }

    if (Array.isArray(filter)) {
        return filter.includes(nodeName);
    }

    if (typeof filter === "function") {
        return filter.call(rule, node, options, lookup);
    }

    throw new TypeError("`filter` needs to be a string, array, or function");
}

function findRule(rules: ReadonlyArray<Rule>, node: AnnotatedNode, nodeName: string, options: Options, lookup: RuleLookup): Rule | undefined {
    // A filter may add rules to this same list. Bounding the search by the length
    // at the start keeps it to the rules that existed, as Array.find did.
    const { length } = rules;

    for (let index = 0; index < length; index += 1) {
        const rule = rules[index];

        if (rule && isFilterMatch(rule, node, nodeName, options, lookup)) {
            return rule;
        }
    }

    return undefined;
}
