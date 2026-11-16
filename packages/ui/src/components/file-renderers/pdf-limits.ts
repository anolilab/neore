/**
 * How long a PDF may go without any load progress before it is shown as failed. A stalled signed-URL request must not
 * leave the spinner up forever. The thumbnail and the viewer share it.
 */
export const PDF_LOAD_TIMEOUT_MS = 30_000;
