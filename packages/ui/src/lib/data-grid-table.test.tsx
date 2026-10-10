// @vitest-environment jsdom

/**
 * Contract tests for the v9 table the data grid builds.
 *
 * These deliberately run against a REAL `useTable` instance rather than a mock:
 * the v8 -> v9 migration was mostly renames (`getState()` -> `store.state`,
 * `left`/`right` -> `start`/`end`, `columnSizingInfo` -> `columnResizing`), and a
 * mock would happily answer to either spelling.
 */
import type { ColumnDef, Table } from "@tanstack/react-table";
import { useTable } from "@tanstack/react-table";
import { getCommonPinningStyles } from "@ui/lib/data-grid";
import type { DataGridFeatures } from "@ui/lib/data-grid-features";
import { dataGridFeatures } from "@ui/lib/data-grid-features";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it } from "vitest";

interface Row {
    id: string;
    name: string;
    score: number;
}

const DATA: Row[] = [
    { id: "1", name: "charlie", score: 30 },
    { id: "2", name: "alpha", score: 10 },
    { id: "3", name: "bravo", score: 20 },
];

const COLUMNS: ColumnDef<DataGridFeatures, Row, unknown>[] = [
    { accessorKey: "id", id: "id", size: 100 },
    { accessorKey: "name", id: "name", size: 100 },
    { accessorKey: "score", id: "score", size: 100 },
];

/** Same ordering as a bare `Array#sort()` on strings, but stated explicitly. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : Number(a > b));

const Harness = ({ onRender }: { onRender: (table: Table<DataGridFeatures, Row>) => void }): null => {
    onRender(
        useTable<DataGridFeatures, Row>({
            columns: COLUMNS,
            data: DATA,
            features: dataGridFeatures,
            getRowId: (row) => row.id,
        }),
    );

    return null;
};

const renderTable = async (): Promise<{ getTable: () => Table<DataGridFeatures, Row>; unmount: () => Promise<void> }> => {
    let table: Table<DataGridFeatures, Row> | undefined;

    const root = createRoot(document.createElement("div"));

    await act(async () => {
        root.render(
            <Harness
                onRender={(rendered) => {
                    table = rendered;
                }}
            />,
        );
    });

    return {
        getTable: () => {
            if (!table) {
                throw new Error("table was not constructed");
            }

            return table;
        },
        unmount: async () => {
            await act(async () => {
                root.unmount();
            });
        },
    };
};

beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true, writable: true });
});

describe("dataGridFeatures", () => {
    it("puts one state slice per registered feature on the table", async () => {
        const { getTable, unmount } = await renderTable();
        const { state } = getTable().store;

        // Filtering, sorting, selection, visibility, ordering, pinning, sizing,
        // resizing -- every capability the grid drives.
        expect(Object.keys(state).toSorted(byCodeUnit)).toEqual(
            ["columnFilters", "columnOrder", "columnPinning", "columnResizing", "columnSizing", "columnVisibility", "rowSelection", "sorting"].toSorted(
                byCodeUnit,
            ),
        );

        // v9 renamed `columnSizingInfo` -> `columnResizing`; there is no alias.
        expect(state).not.toHaveProperty("columnSizingInfo");

        await unmount();
    });

    it("uses the v9 column-resizing setter, not the v8 spelling", async () => {
        // One deliberate tripwire on the rename that silently changes meaning.
        // Not a roll-call of every setter — that pins TanStack's API surface
        // rather than ours, and fires on their patch releases.
        const { getTable, unmount } = await renderTable();

        expect(typeof getTable().setColumnResizing).toBe("function");
        expect(getTable()).not.toHaveProperty("setColumnSizingInfo");

        await unmount();
    });

    it("wires the sorted row model slot", async () => {
        const { getTable, unmount } = await renderTable();

        await act(async () => {
            getTable().setSorting([{ desc: false, id: "score" }]);
        });

        expect(
            getTable()
                .getRowModel()
                .rows.map((row) => row.id),
        ).toEqual(["2", "3", "1"]);

        await unmount();
    });

    it("wires the filtered row model slot", async () => {
        const { getTable, unmount } = await renderTable();

        await act(async () => {
            getTable().setColumnFilters([{ id: "name", value: "brav" }]);
        });

        expect(
            getTable()
                .getRowModel()
                .rows.map((row) => row.id),
        ).toEqual(["3"]);

        await unmount();
    });
});

describe("table state access", () => {
    it("reads state from table.store.state and not table.getState()", async () => {
        const { getTable, unmount } = await renderTable();
        const table = getTable();

        // v8's accessor is gone; reaching for it silently yields `undefined`.
        expect(table).not.toHaveProperty("getState");
        expect(table.store.state.sorting).toEqual([]);

        await act(async () => {
            table.setSorting([{ desc: true, id: "name" }]);
        });

        expect(getTable().store.state.sorting).toEqual([{ desc: true, id: "name" }]);

        await unmount();
    });
});

describe("column pinning", () => {
    it("pins into logical start/end buckets", async () => {
        const { getTable, unmount } = await renderTable();

        await act(async () => {
            getTable().getColumn("id")?.pin("start");
            getTable().getColumn("score")?.pin("end");
        });

        const table = getTable();

        expect(table.store.state.columnPinning).toEqual({ end: ["score"], start: ["id"] });
        expect(table.store.state.columnPinning).not.toHaveProperty("left");
        expect(table.store.state.columnPinning).not.toHaveProperty("right");
        expect(table.getColumn("id")?.getIsPinned()).toBe("start");
        expect(table.getColumn("score")?.getIsPinned()).toBe("end");
        expect(table.getColumn("name")?.getIsPinned()).toBe(false);

        // `scrollCellIntoView` measures the pinned gutters through these.
        expect(table.getStartVisibleLeafColumns().map((column) => column.id)).toEqual(["id"]);
        expect(table.getEndVisibleLeafColumns().map((column) => column.id)).toEqual(["score"]);
        expect(table).not.toHaveProperty("getLeftVisibleLeafColumns");
        expect(table).not.toHaveProperty("getRightVisibleLeafColumns");

        await unmount();
    });

    it("sticks a start-pinned column to the left in ltr", async () => {
        const { getTable, unmount } = await renderTable();

        await act(async () => {
            getTable().getColumn("id")?.pin("start");
        });

        const column = getTable().getColumn("id");

        expect(column).toBeDefined();

        const styles = getCommonPinningStyles<Row>({ column: column!, withBorder: true });

        expect(styles.position).toBe("sticky");
        expect(styles.left).toBe("0px");
        expect(styles.right).toBeUndefined();
        expect(styles.zIndex).toBe(1);
        expect(styles.opacity).toBeCloseTo(0.97);
        expect(styles.width).toBe(100);
        expect(styles.boxShadow).toBe("-4px 0 4px -4px var(--border) inset");

        await unmount();
    });

    it("offsets the second start-pinned column by the width of the first", async () => {
        const { getTable, unmount } = await renderTable();

        await act(async () => {
            getTable().setColumnPinning({ end: [], start: ["id", "name"] });
        });

        const table = getTable();

        expect(getCommonPinningStyles<Row>({ column: table.getColumn("id")! }).left).toBe("0px");
        expect(getCommonPinningStyles<Row>({ column: table.getColumn("name")! }).left).toBe("100px");

        await unmount();
    });

    it("sticks an end-pinned column to the right in ltr", async () => {
        const { getTable, unmount } = await renderTable();

        await act(async () => {
            getTable().getColumn("score")?.pin("end");
        });

        const styles = getCommonPinningStyles<Row>({ column: getTable().getColumn("score")!, withBorder: true });

        expect(styles.position).toBe("sticky");
        expect(styles.right).toBe("0px");
        expect(styles.left).toBeUndefined();
        expect(styles.boxShadow).toBe("4px 0 4px -4px var(--border) inset");

        await unmount();
    });

    it("swaps the physical side for rtl while keeping the logical bucket", async () => {
        const { getTable, unmount } = await renderTable();

        await act(async () => {
            getTable().setColumnPinning({ end: ["score"], start: ["id"] });
        });

        const table = getTable();
        const start = getCommonPinningStyles<Row>({ column: table.getColumn("id")!, dir: "rtl", withBorder: true });
        const end = getCommonPinningStyles<Row>({ column: table.getColumn("score")!, dir: "rtl", withBorder: true });

        expect(start.right).toBe("0px");
        expect(start.left).toBeUndefined();
        expect(start.boxShadow).toBe("4px 0 4px -4px var(--border) inset");

        expect(end.left).toBe("0px");
        expect(end.right).toBeUndefined();
        expect(end.boxShadow).toBe("-4px 0 4px -4px var(--border) inset");

        await unmount();
    });

    it("leaves an unpinned column in flow", async () => {
        const { getTable, unmount } = await renderTable();

        const styles = getCommonPinningStyles<Row>({ column: getTable().getColumn("name")!, withBorder: true });

        expect(styles.position).toBe("relative");
        expect(styles.left).toBeUndefined();
        expect(styles.right).toBeUndefined();
        expect(styles.zIndex).toBeUndefined();
        expect(styles.opacity).toBe(1);
        expect(styles.boxShadow).toBeUndefined();

        await unmount();
    });
});
