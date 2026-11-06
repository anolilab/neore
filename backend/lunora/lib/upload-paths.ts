/**
 * The upload route's path and CORS headers, apart from its handler: `http.ts`
 * reads them while the Worker starts, and the handler's import graph (the chat
 * upload limits, the agent client) is loaded on the first upload instead.
 */

/** Where browsers upload. The TUS upload URL of each file is `<UPLOAD_PATH>/<uploadId>`. */
export const UPLOAD_PATH = "/uploads";

/** Request headers the TUS client sends, for the CORS preflight. */
export const TUS_REQUEST_HEADERS = ["Tus-Resumable", "Upload-Length", "Upload-Metadata", "Upload-Offset"];

/** Response headers the TUS client reads, for CORS. */
export const TUS_RESPONSE_HEADERS = ["Location", "Tus-Resumable", "Upload-Length", "Upload-Offset", "Upload-Metadata"];
