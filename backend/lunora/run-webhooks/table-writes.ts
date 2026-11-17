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
 * again, so the same id is never written twice.
 */
export const copyMergedRunWebhooks = async (ctx: { db: unknown }, rows: Record<string, unknown>[], to: string): Promise<number> => {
    const db = ctx.db as unknown as RawWebhookDb;
    let imported = 0;

    for (const row of rows) {
        const { page } = await db.runWebhooks.findMany({ limit: 1, where: { userId: to } });

        if (page.length > 0) {
            break;
        }

        const id = row._id as string;

        if ((await db.get("runWebhooks", id)) === null) {
            await db.insert("runWebhooks", row, { allowExplicitId: true });
        } else {
            await db.patch("runWebhooks", id, { userId: to });
        }

        imported += 1;
    }

    return imported;
};
