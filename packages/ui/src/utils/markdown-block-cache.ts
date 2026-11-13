import type { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { createContext } from "react";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { defaultRehypePlugins } from "streamdown";
import type { PluggableList } from "unified";
import { unified } from "unified";

/**
 * Streamdown parses every markdown block again each time a reply mounts: on a thread switch, when the virtualizer
 * brings a row back, when the saved message replaces the streaming one, when a translation opens. A finished reply's
 * text never changes, so this keeps the parsed tree of its blocks in a small LRU and only turns it into React
 * elements on a later mount.
 *
 * The pipeline is Streamdown's own (its `Markdown` renderer is not exported): remark-parse, the remark plugins,
 * remark-rehype with raw HTML allowed, the rehype plugins, then `toJsxRuntime` with the same options. Raw HTML
 * becomes text when the rehype plugins have no `rehype-raw`, as Streamdown does. `CachedMarkdownBlock`
 * (`components/cached-markdown-block.tsx`) renders the tree.
 */

/** The rendered (HTML) tree of a block. */
export type HastRoot = Parameters<typeof toJsxRuntime>[0];

/** The parts of a markdown tree node `htmlAsText` reads. */
type MarkdownNode = { children?: MarkdownNode[]; type: string; value?: string };

/** Whether the blocks under it belong to a finished reply. Off by default: a streaming reply is never cached. */
export const MarkdownBlockCacheContext = createContext(false);

const MAX_ENTRIES = 400;
/** Characters of markdown across all cached blocks; a parsed tree is some tens of times the size of its source. */
const MAX_CHARS = 1_000_000;

const cache = new Map<string, HastRoot>();
const cacheSize = { chars: 0 };

const cacheGet = (key: string): HastRoot | undefined => {
    const tree = cache.get(key);

    if (tree) {
        // Most recently used goes last; eviction takes from the front.
        cache.delete(key);
        cache.set(key, tree);
    }

    return tree;
};

const cacheSet = (key: string, tree: HastRoot): void => {
    if (key.length > MAX_CHARS) {
        return;
    }

    cache.set(key, tree);
    cacheSize.chars += key.length;

    for (const oldest of cache.keys()) {
        if (cache.size <= MAX_ENTRIES && cacheSize.chars <= MAX_CHARS) {
            break;
        }

        cache.delete(oldest);
        cacheSize.chars -= oldest.length;
    }
};

/** Empties the cache. For tests. */
export const clearMarkdownBlockCache = (): void => {
    cache.clear();
    cacheSize.chars = 0;
};

/** Stable ids for plugin functions and their option objects, so a cache key never matches a different plugin set. */
const ids = new WeakMap<WeakKey, number>();
const nextId = { value: 0 };

const idOf = (value: unknown): string => {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        return JSON.stringify(value) ?? "u";
    }

    let id = ids.get(value);

    if (id === undefined) {
        nextId.value += 1;
        id = nextId.value;
        ids.set(value, id);
    }

    return `#${id}`;
};

const pluginListKeys = new WeakMap<PluggableList, string>();

const pluginListKey = (list: PluggableList | null | undefined): string => {
    if (!list) {
        return "";
    }

    let key = pluginListKeys.get(list);

    if (key === undefined) {
        key = list.map((entry) => (Array.isArray(entry) ? `[${entry.map((part) => idOf(part)).join(",")}]` : idOf(entry))).join(",");
        pluginListKeys.set(list, key);
    }

    return key;
};

const hasRawHtml = (rehypePlugins: PluggableList): boolean =>
    rehypePlugins.some((entry) => (Array.isArray(entry) ? entry[0] : entry) === defaultRehypePlugins.raw);

/** Without `rehype-raw`, HTML in the source is shown as text rather than dropped. */
const htmlAsText = () => (tree: MarkdownNode) => {
    const walk = (node: MarkdownNode): void => {
        if (!node.children) {
            return;
        }

        for (const [index, child] of node.children.entries()) {
            if (child.type === "html") {
                node.children[index] = { type: "text", value: child.value };
            } else {
                walk(child);
            }
        }
    };

    walk(tree);
};

/** What the pipeline is used for; unified's own generics do not follow a plugin list built at runtime. */
type MarkdownProcessor = { parse: (content: string) => unknown; runSync: (tree: never, file: string) => unknown };

const MAX_PROCESSORS = 20;
const processors = new Map<string, MarkdownProcessor>();

const processorFor = (pluginsKey: string, remarkPlugins: PluggableList, rehypePlugins: PluggableList): MarkdownProcessor => {
    let processor = processors.get(pluginsKey);

    if (!processor) {
        const remark = hasRawHtml(rehypePlugins) ? remarkPlugins : [...remarkPlugins, htmlAsText];

        processor = unified().use(remarkParse).use(remark).use(remarkRehype, { allowDangerousHtml: true }).use(rehypePlugins) as unknown as MarkdownProcessor;

        if (processors.size >= MAX_PROCESSORS) {
            processors.delete(processors.keys().next().value as string);
        }

        processors.set(pluginsKey, processor);
    }

    return processor;
};

/** The parsed tree of one finished block, from the cache when this block was parsed before with the same plugins. */
export const parseMarkdownBlock = (content: string, remarkPlugins: PluggableList, rehypePlugins: PluggableList): HastRoot => {
    const pluginsKey = `${pluginListKey(remarkPlugins)}::${pluginListKey(rehypePlugins)}`;
    const key = `${pluginsKey}\n${content}`;
    const cached = cacheGet(key);

    if (cached) {
        return cached;
    }

    const processor = processorFor(pluginsKey, remarkPlugins, rehypePlugins);
    const tree = processor.runSync(processor.parse(content) as never, content) as HastRoot;

    cacheSet(key, tree);

    return tree;
};
