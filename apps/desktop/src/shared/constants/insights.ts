/** File paths are referenced, not uploaded, so file size is intentionally unrestricted. */
export const MAX_INSIGHTS_DOCUMENT_REFERENCES = 20;

/** Prevent malformed IPC payloads from carrying unbounded path strings. */
export const MAX_INSIGHTS_REFERENCE_PATH_LENGTH = 32_767;

/**
 * Bound the combined path text carried by one Insights message. Typical paths
 * are far shorter; this still permits two maximum-length Windows paths without
 * allowing a small reference list to inflate the model prompt indefinitely.
 */
export const MAX_INSIGHTS_DOCUMENT_PATH_CHARACTERS = 64 * 1024;

/** Bound opaque authorization data crossing the renderer-to-main IPC boundary. */
export const MAX_INSIGHTS_DOCUMENT_AUTHORIZATION_TOKEN_LENGTH = 256;
