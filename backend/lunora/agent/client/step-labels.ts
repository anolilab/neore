/**
 * Applies a run's labelling to the rows of one step before they are saved, so a live tool call
 * carries the names the saved call will (`labelStepContent`). A row whose content is unchanged is
 * returned as it was, so the step's other rows are untouched.
 */
export const applyStepLabels = <Row extends { message?: { content?: unknown } }>(
    rows: ReadonlyArray<Row>,
    labelContent: (content: unknown) => unknown[] | undefined,
): Row[] =>
    rows.map((row) => {
        const content = labelContent(row.message?.content);

        return content ? ({ ...row, message: { ...row.message, content } } as Row) : (row as Row);
    });
