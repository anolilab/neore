import type { SystemTableName } from "lunorash/server";
import { v } from "lunorash/server";

import type { Id, TableName } from "../_generated/dataModel";

export const withoutSystemFields = <T extends { _creationTime: number; _id: Id<TableName | SystemTableName> }>(
    documentRow: T,
): Omit<T, "_creationTime" | "_id"> => {
    // Exclude _id and _creationTime from the returned object

    const { _creationTime, _id, ...rest } = documentRow;

    return rest;
};

export const systemFields = (tableName: TableName) => {
    return {
        _creationTime: v.number(),
        _id: v.id(tableName),
    };
};

export const softDeleteFields = {
    deleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
};
