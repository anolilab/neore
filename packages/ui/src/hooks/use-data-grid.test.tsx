// @vitest-environment jsdom

/**
 * Row-selection contract for the data grid.
 *
 * v9 narrowed `RowSelectionState` to `Record<string, true>`: a row is selected by
 * the PRESENCE of its key. Deselecting therefore has to DELETE the entry -- an
 * entry left behind as `false` still counts towards
 * `Object.keys(rowSelection).length`, which is how the grid decides whether any
 * row is selected. These tests run against a real `useTable` instance so the
 * assertions go through the library's own state, not a stand-in for it.
 */
import type { ColumnDef } from "@tanstack/react-table";
import { useDataGrid } from "@ui/hooks/use-data-grid";
import type { DataGridFeatures } from "@ui/lib/data-grid-features";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The unit-test transform does not compile Lingui macros, so the hook's `useLingui`/`plural` imports are
// stand-ins here (vi.mock is hoisted). The toasts they build are not asserted.
// eslint-disable-next-line no-restricted-syntax -- no macro transform in this package's vitest; nothing to inject into
vi.mock("@lingui/core/macro", () => {
    return { plural: (value: number, forms: { other: string }) => forms.other.split("#").join(String(value)) };
});

// eslint-disable-next-line no-restricted-syntax -- see above
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

interface Row {
    id: string;
    name: string;
}

const DATA: Row[] = [
    { id: "r1", name: "one" },
    { id: "r2", name: "two" },
    { id: "r3", name: "three" },
    { id: "r4", name: "four" },
    { id: "r5", name: "five" },
];

const COLUMNS: ColumnDef<DataGridFeatures, Row, unknown>[] = [{ accessorKey: "name", id: "name" }];

type Grid = ReturnType<typeof useDataGrid<Row>>;

const Harness = ({ onRender }: { onRender: (grid: Grid) => void }): null => {
    onRender(
        useDataGrid<Row>({
            columns: COLUMNS,
            data: DATA,
            getRowId: (row) => row.id,
        }),
    );

    return null;
};

const renderGrid = async () => {
    let grid: Grid | undefined;

    const root = createRoot(document.createElement("div"));

    await act(async () => {
        root.render(
            <Harness
                onRender={(rendered) => {
                    grid = rendered;
                }}
            />,
        );
    });

    const current = (): Grid => {
        if (!grid) {
            throw new Error("grid was not rendered");
        }

        return grid;
    };

    return {
        /** `(rowIndex, selected, shiftKey)` -- exactly what the row checkbox calls. */
        click: async (rowIndex: number, selected: boolean, shiftKey = false): Promise<void> => {
            const { onRowSelect } = current().tableMeta;

            if (!onRowSelect) {
                throw new Error("tableMeta.onRowSelect is missing");
            }

            await act(async () => {
                onRowSelect(rowIndex, selected, shiftKey);
            });
        },
        current,
        selectedIds: (): string[] => {
            const { rows } = current().table.getSelectedRowModel();

            return rows.map((row) => row.id);
        },
        selection: () => current().table.store.state.rowSelection,
        unmount: async (): Promise<void> => {
            await act(async () => {
                root.unmount();
            });
        },
    };
};

beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true, writable: true });
});

describe("onRowSelect", () => {
    it("selects a row by writing `true` under its row id", async () => {
        const grid = await renderGrid();

        await grid.click(1, true);

        expect(grid.selection()).toEqual({ r2: true });
        expect(grid.selectedIds()).toEqual(["r2"]);
        expect(grid.current().table.getRow("r2").getIsSelected()).toBe(true);

        await grid.unmount();
    });

    it("deselects by deleting the entry, never by writing `false`", async () => {
        const grid = await renderGrid();

        await grid.click(1, true);
        await grid.click(1, false);

        // `toEqual({})` is the assertion that matters: a leftover `{ r2: false }`
        // keeps `Object.keys(...).length > 0`, which the grid reads as "rows are
        // selected" when deciding delete/clear behaviour.
        expect(grid.selection()).toEqual({});
        expect(Object.keys(grid.selection())).toHaveLength(0);
        expect(grid.selectedIds()).toEqual([]);
        expect(grid.current().table.getRow("r2").getIsSelected()).toBe(false);

        await grid.unmount();
    });

    it("leaves other rows untouched when deselecting one", async () => {
        const grid = await renderGrid();

        await grid.click(0, true);
        await grid.click(2, true);
        await grid.click(0, false);

        expect(grid.selection()).toEqual({ r3: true });

        await grid.unmount();
    });

    it("shift-clicking downwards selects the inclusive range from the anchor", async () => {
        const grid = await renderGrid();

        await grid.click(1, true);
        await grid.click(3, true, true);

        expect(grid.selection()).toEqual({ r2: true, r3: true, r4: true });
        expect(grid.selectedIds()).toEqual(["r2", "r3", "r4"]);

        await grid.unmount();
    });

    it("shift-clicking upwards selects the same inclusive range", async () => {
        const grid = await renderGrid();

        await grid.click(3, true);
        await grid.click(1, true, true);

        expect(grid.selection()).toEqual({ r2: true, r3: true, r4: true });
        expect(grid.selectedIds()).toEqual(["r2", "r3", "r4"]);

        await grid.unmount();
    });

    it("shift-clicking merges the range into an existing selection", async () => {
        const grid = await renderGrid();

        await grid.click(4, true);
        await grid.click(0, true);
        await grid.click(2, true, true);

        expect(grid.selection()).toEqual({ r1: true, r2: true, r3: true, r5: true });

        await grid.unmount();
    });

    it("shift-clicking with `selected: false` deletes the whole range and keeps the rest", async () => {
        const grid = await renderGrid();

        await grid.click(0, true);
        await grid.click(4, true, true);
        expect(Object.keys(grid.selection())).toHaveLength(5);

        await grid.click(1, false);
        await grid.click(3, false, true);

        expect(grid.selection()).toEqual({ r1: true, r5: true });
        expect(grid.selectedIds()).toEqual(["r1", "r5"]);

        await grid.unmount();
    });

    it("treats a shift-click with no prior anchor as a plain click", async () => {
        const grid = await renderGrid();

        await grid.click(3, true, true);

        expect(grid.selection()).toEqual({ r4: true });

        await grid.unmount();
    });

    it("moves the anchor to the row that was just clicked, including after a shift-click", async () => {
        const grid = await renderGrid();

        await grid.click(0, true);
        await grid.click(2, true, true);
        // Anchor is now row 2, not row 0: the next shift-click ranges from there.
        await grid.click(4, true, true);

        expect(grid.selection()).toEqual({ r1: true, r2: true, r3: true, r4: true, r5: true });

        await grid.click(3, true);
        await grid.click(4, true, true);

        expect(grid.current().table.getRow("r4").getIsSelected()).toBe(true);

        await grid.unmount();
    });

    it("ignores a click on a row index that does not exist and keeps the anchor", async () => {
        const grid = await renderGrid();

        await grid.click(1, true);
        await grid.click(99, true);

        expect(grid.selection()).toEqual({ r2: true });

        // The anchor must still be row 1; if the out-of-range click had moved it,
        // this shift-click would select a different range.
        await grid.click(3, true, true);

        expect(grid.selection()).toEqual({ r2: true, r3: true, r4: true });

        await grid.unmount();
    });
});
