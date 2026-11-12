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

        // Lowercased once for the node, not once per rule.
        const nodeName = node.nodeName.toLowerCase();

        const fromRules = findRule(this.array, node, nodeName, this.options, this);

        if (fromRules) {
            return fromRules;
        }

        const fromKeep = findRule(this.keepList, node, nodeName, this.options, this);

        if (fromKeep) {
            return fromKeep;
        }

        const fromRemove = findRule(this.removeList, node, nodeName, this.options, this);

        return fromRemove ?? this.defaultRule;
    }

    /**
     * True when a rule of any kind, built-in, added, keep or remove, matches the node. A rule that must
     * decide whether to treat a node as transparent asks this first.
     */
    hasRuleFor(node: Node): boolean {
        const annotated = annotateNode(node, this.options);
        const nodeName = annotated.nodeName.toLowerCase();

        return [this.array, this.keepList, this.removeList].some((list) => findRule(list, annotated, nodeName, this.options, this) !== undefined);
    }

    forEach(visit: (rule: Rule, index: number) => void): void {
        this.array.forEach((rule, index) => {
            visit(rule, index);
        });
    }
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

function findRule(rules: Rule[], node: AnnotatedNode, nodeName: string, options: Options, lookup: RuleLookup): Rule | undefined {
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
