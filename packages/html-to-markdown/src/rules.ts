import type { AnnotatedNode, Options, ReplacementFunction, Rule } from "./types";

/**
 * Manages the rules used to convert HTML to Markdown: the built-in rules, then
 * the ones added with `addRule`, then keep/remove filters.
 */
export default class Rules {
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

        for (const rules of [this.array, this.keepList, this.removeList]) {
            const rule = findRule(rules, node, this.options);

            if (rule) {
                return rule;
            }
        }

        return this.defaultRule;
    }

    forEach(visit: (rule: Rule, index: number) => void): void {
        this.array.forEach((rule, index) => {
            visit(rule, index);
        });
    }
}

function isFilterMatch(rule: Rule, node: AnnotatedNode, options: Options): boolean {
    const { filter } = rule;
    const nodeName = node.nodeName.toLowerCase();

    if (typeof filter === "string") {
        return filter === nodeName;
    }

    if (Array.isArray(filter)) {
        return filter.includes(nodeName);
    }

    if (typeof filter === "function") {
        return filter.call(rule, node, options);
    }

    throw new TypeError("`filter` needs to be a string, array, or function");
}

function findRule(rules: Rule[], node: AnnotatedNode, options: Options): Rule | undefined {
    return rules.find((rule) => isFilterMatch(rule, node, options));
}
