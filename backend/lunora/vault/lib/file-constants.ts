// Supported MIME types for images (used in UPLOAD_ALLOWED_MIME)
export const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/svg+xml", "image/webp", "image/bmp", "image/x-icon"] as const;

// Supported MIME types for text files
export const SUPPORTED_TEXT_MIME_TYPES = [
    "text/plain",
    "text/markdown",
    "text/html",
    "text/css",
    "text/javascript",
    "text/xml",
    "text/yaml",
    "application/json",
    "application/javascript",
    "application/typescript",
    "application/pdf",
] as const;

// All supported MIME types for uploads (combines images, text, and additional document types)
export const UPLOAD_ALLOWED_MIME = [
    // Images
    ...SUPPORTED_IMAGE_MIME_TYPES,
    "image/svg+xml", // SVG is not in SUPPORTED_IMAGE_MIME_TYPES but should be allowed

    // Documents
    ...SUPPORTED_TEXT_MIME_TYPES,

    // Microsoft Office
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",

    // Other common formats
    "application/json",
    "application/xml",
    "text/xml",
    "text/yaml",
] as const;

// File size limits
export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// Only these models currently support file inputs. Update as new ones roll out.
export const FILE_UPLOAD_MODELS = [
    // Anthropic models
    "claude-3-5-sonnet-20241022",
    "claude-3-7-sonnet-20250219",
    "claude-3-7-sonnet-reasoning",
    "claude-4-opus",
    "claude-4-sonnet",
    "claude-4-sonnet-reasoning",

    // OpenAI models
    "gpt-4o",
    "gpt-4o-mini",
    "o4-mini",
    "o3",
    "o3-pro",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4.5",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",

    "glm-4.5v",

    // Google models
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-flash-thinking",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash-lite-thinking",
    "gemini-2.5-pro",

    // Meta models
    "meta-llama/llama-4-maverick:free",
    "meta-llama/llama-4-scout:free",

    // Mistral models
    "pixtral-large-latest",

    // Grok models
    "grok-3",
    "grok-3-mini",
    "x-ai/grok-4-fast-thinking",
    "x-ai/grok-4-fast",
] as const;
