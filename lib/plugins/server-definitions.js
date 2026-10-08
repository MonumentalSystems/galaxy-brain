// Compatibility connector metadata is server-owned and never read from a
// plugin manifest or imported by browser-safe command discovery.
export const LEGACY_PROXY_DEFINITIONS = Object.freeze({
  ham: Object.freeze({
    id: "ham",
    displayName: "HAM",
    capabilities: Object.freeze(["source", "sink"]),
    baseUrlEnv: "HAM_API_INTERNAL",
    defaultBaseUrl: "http://localhost:8042",
    tokenEnv: "HAM_API_BEARER_TOKEN",
    methods: Object.freeze(["GET", "POST", "PATCH", "DELETE"]),
  }),
})

export const LEGACY_TRANSFORM_DEFINITIONS = Object.freeze({
  docling: Object.freeze({
    id: "docling",
    displayName: "Docling",
    capabilities: Object.freeze(["transform"]),
    transport: "service",
    baseUrlEnv: "DOCLING_API_INTERNAL",
    defaultBaseUrl: "",
    tokenEnv: "DOCLING_API_KEY",
    tokenHeader: "X-API-Key",
    endpoint: "v1/convert/file",
    maxFileBytes: 25 * 1024 * 1024,
    output: "document-structure",
    fidelity: "structured",
  }),
  markitdown: Object.freeze({
    id: "markitdown",
    displayName: "MarkItDown",
    capabilities: Object.freeze(["transform"]),
    transport: "service",
    baseUrlEnv: "MARKITDOWN_API_INTERNAL",
    defaultBaseUrl: "http://localhost:8043",
    tokenEnv: "MARKITDOWN_PROXY_TOKEN",
    tokenHeader: "X-GB-Proxy-Token",
    endpoint: "convert",
    output: "markdown",
    fidelity: "flat",
  }),
  "plain-text": Object.freeze({
    id: "plain-text",
    displayName: "Plain text",
    capabilities: Object.freeze(["transform"]),
    transport: "local",
    output: "markdown",
    fidelity: "verbatim",
  }),
})
