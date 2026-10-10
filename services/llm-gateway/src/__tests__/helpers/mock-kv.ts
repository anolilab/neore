/**
 * In-memory KVNamespace double shared by the gateway tests.
 */
export class MockKVNamespace {
    private store = new Map<string, string>();

    async get(key: string, type?: string): Promise<unknown> {
        const value = this.store.get(key) ?? null;

        if (value === null) return null;

        if (type === "json") {
            try {
                return JSON.parse(value);
            } catch {
                return null;
            }
        }

        return value;
    }

    async put(key: string, value: string, _options?: unknown): Promise<void> {
        this.store.set(key, value);
    }

    async delete(key: string): Promise<void> {
        this.store.delete(key);
    }

    async list(options?: { limit?: number; prefix?: string }): Promise<{ cursor: string; keys: { name: string }[]; list_complete: boolean }> {
        // Returned empty unconditionally, so anything counting keys by prefix —
        // `countActiveSessions` in the realtime route — always saw zero.
        const prefix = options?.prefix ?? "";
        const names = this.store
            .keys()
            .filter((k) => k.startsWith(prefix))
            .toArray();
        const keys = (options?.limit ? names.slice(0, options.limit) : names).map((name) => {
            return { name };
        });

        return { cursor: "", keys, list_complete: keys.length === names.length };
    }

    async getWithMetadata(key: string): Promise<{ metadata: null; value: string | null }> {
        return { metadata: null, value: this.store.get(key) ?? null };
    }

    /** Direct access for test setup and inspection. */
    getRaw(key: string): string | undefined {
        return this.store.get(key);
    }

    setRaw(key: string, value: string): void {
        this.store.set(key, value);
    }

    size(): number {
        return this.store.size;
    }
}
