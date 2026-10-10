import {
    columnFilteringFeature,
    columnOrderingFeature,
    columnPinningFeature,
    columnResizingFeature,
    columnSizingFeature,
    columnVisibilityFeature,
    createFilteredRowModel,
    createSortedRowModel,
    filterFn_includesString,
    rowSelectionFeature,
    rowSortingFeature,
    tableFeatures,
} from "@tanstack/react-table";

/**
 * The table features the data grid uses.
 *
 * v9 no longer bundles every feature into the table: each one has to be
 * registered, and the registration is what puts the matching state slice,
 * options and instance methods on the type. Registering explicitly rather than
 * reaching for `stockFeatures` keeps the list to what the grid actually uses.
 *
 * Note what is deliberately NOT here: `cellSelectionFeature`. The grid does have
 * cell selection — it is hand-rolled in `useDataGrid`'s own store
 * (`selectionState.selectedCells`), because it needs range semantics the table
 * feature does not model. Look there, not here.
 *
 * Grouping, row expanding and global filtering were registered here at first and
 * are gone: nothing in the grid calls them. They survived only because the
 * virtualizer's dependency array read their state slices, which is circular —
 * the slices existed because the features were registered.
 *
 * Row models are slots now, not `getXRowModel()` options. The core row model is
 * automatic and must NOT be passed.
 *
 * Adding a capability here is the first step of adding it to the grid; the types
 * will not admit its state or methods until it is listed.
 */
export const dataGridFeatures = tableFeatures({
    columnFilteringFeature,
    columnOrderingFeature,
    columnPinningFeature,
    columnResizingFeature,
    columnSizingFeature,
    columnVisibilityFeature,
    filteredRowModel: createFilteredRowModel(),
    // A registered feature that cannot actually filter is a trap. v9 resolves a
    // column's filter through the `filterFns` registry, so without an entry here
    // `columnFilteringFeature` + `filteredRowModel` are inert: setting
    // `columnFilters` changes state and the row model comes back unfiltered, with
    // no error. Nothing populates `columnFilters` today — the grid's own search is
    // separate — so this was silent.
    filterFns: { includesString: filterFn_includesString },
    rowSelectionFeature,
    rowSortingFeature,
    sortedRowModel: createSortedRowModel(),
});

/**
 * The feature set as a type, for the `TFeatures` parameter every v9 table type
 * now takes first: `Table<DataGridFeatures, TData>`, `ColumnDef<DataGridFeatures,
 * TData, TValue>`, and so on.
 */
export type DataGridFeatures = typeof dataGridFeatures;
