/**
 * The run-webhooks module's write surface for OTHER modules. `run-webhooks/module.ts` owns `runWebhooks`, so the
 * `cross_module_table_write` advisor flags a write to it from anywhere else. The account merge (`lib/account-merge.ts`) is
 * the one caller: it copies a converting guest's webhook across through here.
 *
 * A plain function over `ctx.db`, not a procedure, so the write stays inside the caller's mutation and shard.
 */
type RawWebhookDb = {
    get: (table: string, id: string) => Promise<unknown>;
    insert: (table: string, document: Record<string, unknown>, options: { allowExplicitId: boolean }) => Promise<string>;
    patch: (table: string, id: string, fields: Record<string, unknown>) => Promise<void>;
    runWebhooks: { findMany: (options: { limit: number; where: { userId: string } }) => Promise<{ page: unknown[] }> };
};

/**
 * Copies the (already re-owned) webhook rows into the new account, unless it already has one: the settings page reads one
 * row, so a second would be unreachable. Checked per row, through the index, so a redelivered job stops at the row it wrote.
 *
 * On a shard that also holds the guest's row, that row's id is already taken: it is re-owned in place rather than inserted
 * again, so the same id is never written twice. A row under that id owned by anyone but the guest is a different user's
 * webhook: the merge stops before it is touched, and before the clear pass deletes the guest's copy.
 */
export const copyMergedRunWebhooks = async (ctx: { db: unknown }, rows: Record<string, unknown>[], from: string, to: string): Promise<number> => {
    const db = ctx.db as unknown as RawWebhookDb;
    let imported = 0;

    for (const row of rows) {
        const { page } = await db.runWebhooks.findMany({ limit: 1, where: { userId: to } });

        if (page.length > 0) {
            break;
        }

        const id = row._id as string;

        const existing = (await db.get("runWebhooks", id)) as { userId?: unknown } | null;

        if (existing === null) {
            await db.insert("runWebhooks", row, { allowExplicitId: true });
        } else if (existing.userId === from) {
            await db.patch("runWebhooks", id, { userId: to });
        } else {
            throw new Error(`runWebhooks row ${id} already exists on the new account's shard as another user's row; the merge into ${to} stops`);
        }

        imported += 1;
    }

    return imported;
};
