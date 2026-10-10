/**
 * `api` / `internal` whose references resolve to REGISTERED procedures, for
 * suites that dispatch an action which itself calls `ctx.runQuery(internal.…)`.
 *
 * Production resolves a reference by path; the `lunoraTest` harness only runs a
 * procedure object. So a suite registers the modules it exercises and mocks
 * both generated reference modules with this (the pattern
 * `lunora/lib/rls/rls.test.ts` uses):
 *
 * ```ts
 * const registry = vi.hoisted(() => new Map<string, unknown>());
 * vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
 * vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
 * beforeAll(async () => registerModule(registry, "pages_sharing", await import("./sharing")));
 * ```
 *
 * Registry keys are the references' dispatch keys (`pages_sharing:getPage`),
 * which stay flat while `api.pages.sharing.getPage` nests. An unregistered key
 * falls back to the plain generated reference.
 */
type Module = Record<string, unknown>;

interface Reference {
    __lunoraRef: string;
}

const isReference = (node: object): node is Reference => "__lunoraRef" in node;

/** A generated reference tree with every reference passed through `leaf` as it is read. */
const mapReferences = (tree: unknown, leaf: (reference: Reference) => unknown): unknown => {
    if (typeof tree !== "object" || tree === null) {
        return tree;
    }

    return isReference(tree) ? leaf(tree) : new Proxy(tree, { get: (target, key) => mapReferences(Reflect.get(target, key), leaf) });
};

/** A generated module (`_generated/api` or `_generated/internal`) with its `api` / `internal` mapped by `leaf`. */
export const mappedReferences = <M extends object>(module: M, leaf: (reference: Reference) => unknown): M => {
    return {
        ...module,
        ...("api" in module && { api: mapReferences(module.api, leaf) }),
        ...("internal" in module && { internal: mapReferences(module.internal, leaf) }),
    };
};

export const registeredApi = <M extends object>(module: M, registry: Map<string, unknown>): M =>
    mappedReferences(module, (reference) => registry.get(reference.__lunoraRef) ?? reference);

export const registerModule = (registry: Map<string, unknown>, module: string, exports: Module): void => {
    for (const [name, value] of Object.entries(exports)) {
        registry.set(`${module}:${name}`, value);
    }
};
