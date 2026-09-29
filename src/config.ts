/**
 * Configuration types and resolution for Residue plugin.
 *
 * Provides safe defaults, deep merging, and input validation.
 * Malformed input never throws — falls back to defaults with warnings.
 *
 * @module config
 */

/**
 * Embedding strategy configuration.
 *
 * - `"auto"`: Try local, then remote, fall back to none.
 * - `"local"`: Use local model (e.g., transformers.js). Fail if unavailable.
 * - `"remote"`: Use OpenAI API. Fail if API key missing.
 * - `"ollama"`: Use Ollama local server.
 * - `"none"`: Disable embeddings entirely (FTS5 only).
 */
export type EmbeddingMode = "auto" | "local" | "remote" | "ollama" | "none";

/**
 * Injection settings for context hook.
 */
export interface InjectionConfig {
  /** Enable/disable context injection. */
  enabled: boolean;
  /** Maximum characters to inject per call. */
  maxChars: number;
  /** Maximum number of facts to inject. */
  maxFacts: number;
  /** Minimum similarity score threshold (0.0–1.0). */
  minScore: number;
  /** Whether to share facts across worktrees of the same project. */
  shareAcrossWorktrees: boolean;
  /** Optional provider ID to scope the context hook to a specific provider. */
  providerID?: string;
}

/**
 * Report settings for periodic summaries.
 */
export interface ReportConfig {
  /** Enable periodic reports. */
  enabled: boolean;
  /** Max reports per session per 5-minute window. */
  maxPerSessionPer5min: number;
}

/**
 * Storage backend configuration.
 */
export type StoreMode = "sqlite";

/**
 * Where to store data files.
 *
 * - `"xdg"`: Use XDG_DATA_HOME or ~/.local/share/residue/
 * - `"project"`: Write into .opencode/residue/ inside the project directory.
 */
export type DataDirMode = "xdg" | "project";

/**
 * Complete Residue plugin options.
 */
export interface ResidueOptions {
  /** Automatically capture facts from conversations. */
  autoCapture: boolean;
  /** Embedding strategy. */
  embedding: EmbeddingMode;
  /** Environment variable name for the embedding API key. */
  embeddingKeyEnv: string;
  /** Timeout in milliseconds for each embedder probe during auto resolution. */
  embeddingProbeTimeout: number;
  /** Context injection settings. */
  inject: InjectionConfig;
  /** Storage backend (only sqlite supported currently). */
  store: StoreMode;
  /** Report settings. */
  report: ReportConfig;
  /** Where to store data files. */
  dataDir: DataDirMode;
  /** Enable debug logging. */
  debug: boolean;
}

/** Default plugin options. */
export const DEFAULT_OPTIONS: ResidueOptions = {
  autoCapture: true,
  embedding: "auto",
  embeddingKeyEnv: "OPENAI_API_KEY",
  embeddingProbeTimeout: 1500,
  inject: {
    enabled: true,
    maxChars: 2400,
    maxFacts: 6,
    minScore: 0.34,
    shareAcrossWorktrees: true,
  },
  store: "sqlite",
  report: {
    enabled: false,
    maxPerSessionPer5min: 1,
  },
  dataDir: "xdg",
  debug: false,
};

/**
 * Known top-level option keys for validation.
 * Unknown keys trigger a warning but don't throw.
 */
const KNOWN_KEYS = new Set([
  "autoCapture",
  "embedding",
  "embeddingKeyEnv",
  "embeddingProbeTimeout",
  "inject",
  "store",
  "report",
  "dataDir",
  "debug",
]);

/** Valid embedding mode values. */
const VALID_EMBEDDING_MODES: readonly EmbeddingMode[] = [
  "auto",
  "local",
  "remote",
  "ollama",
  "none",
];

/** Valid data directory modes. */
const VALID_DATA_DIR_MODES: readonly DataDirMode[] = ["xdg", "project"];

/** Valid store modes. */
const VALID_STORE_MODES: readonly StoreMode[] = ["sqlite"];

/**
 * Resolve and validate plugin options with safe defaults.
 *
 * Unknown keys are warned about but don't cause failures.
 * Malformed nested objects are replaced with defaults.
 *
 * @param raw - Raw options from plugin config (may be partial or malformed).
 * @param warn - Warning callback (defaults to console.warn).
 * @returns Fully resolved, validated options.
 */
export function resolveOptions(
  raw: unknown,
  warn: (msg: string) => void = console.warn,
): ResidueOptions {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return { ...DEFAULT_OPTIONS };
  }

  const input = raw as Record<string, unknown>;
  const result: ResidueOptions = { ...DEFAULT_OPTIONS };

  // Warn about unknown top-level keys
  for (const key of Object.keys(input)) {
    if (!KNOWN_KEYS.has(key)) {
      warn(`[residue] Unknown option key "${key}" — ignored`);
    }
  }

  // autoCapture
  if (typeof input["autoCapture"] === "boolean") {
    result.autoCapture = input["autoCapture"];
  } else if (input["autoCapture"] !== undefined) {
    warn(`[residue] Invalid autoCapture value — using default (${DEFAULT_OPTIONS.autoCapture})`);
  }

  // embedding
  if (typeof input["embedding"] === "string") {
    const val = input["embedding"] as string;
    if ((VALID_EMBEDDING_MODES as readonly string[]).includes(val)) {
      result.embedding = val as EmbeddingMode;
    } else {
      warn(`[residue] Invalid embedding mode "${val}" — using default (${DEFAULT_OPTIONS.embedding})`);
    }
  }

  // embeddingKeyEnv
  if (typeof input["embeddingKeyEnv"] === "string" && input["embeddingKeyEnv"].length > 0) {
    result.embeddingKeyEnv = input["embeddingKeyEnv"] as string;
  }

  // embeddingProbeTimeout
  if (typeof input["embeddingProbeTimeout"] === "number" && input["embeddingProbeTimeout"] > 0) {
    result.embeddingProbeTimeout = Math.floor(input["embeddingProbeTimeout"]);
  }

  // inject (nested object)
  if (isRecord(input["inject"])) {
    const inj = input["inject"] as Record<string, unknown>;
    const injResult = { ...DEFAULT_OPTIONS.inject };

    if (typeof inj["enabled"] === "boolean") injResult.enabled = inj["enabled"];
    if (typeof inj["maxChars"] === "number" && inj["maxChars"] > 0) {
      injResult.maxChars = Math.floor(inj["maxChars"]);
    }
    if (typeof inj["maxFacts"] === "number" && inj["maxFacts"] > 0) {
      injResult.maxFacts = Math.floor(inj["maxFacts"]);
    }
    if (typeof inj["minScore"] === "number" && inj["minScore"] >= 0 && inj["minScore"] <= 1) {
      injResult.minScore = inj["minScore"];
    }
    if (typeof inj["shareAcrossWorktrees"] === "boolean") {
      injResult.shareAcrossWorktrees = inj["shareAcrossWorktrees"];
    }
    if (typeof inj["providerID"] === "string" && inj["providerID"].length > 0) {
      injResult.providerID = inj["providerID"] as string;
    }

    result.inject = injResult;
  } else if (input["inject"] !== undefined) {
    warn(`[residue] Invalid inject config — using defaults`);
  }

  // store
  if (typeof input["store"] === "string") {
    const val = input["store"] as string;
    if ((VALID_STORE_MODES as readonly string[]).includes(val)) {
      result.store = val as StoreMode;
    } else {
      warn(`[residue] Invalid store mode "${val}" — using default (${DEFAULT_OPTIONS.store})`);
    }
  }

  // report (nested object)
  if (isRecord(input["report"])) {
    const rep = input["report"] as Record<string, unknown>;
    const repResult = { ...DEFAULT_OPTIONS.report };

    if (typeof rep["enabled"] === "boolean") repResult.enabled = rep["enabled"];
    if (typeof rep["maxPerSessionPer5min"] === "number" && rep["maxPerSessionPer5min"] >= 0) {
      repResult.maxPerSessionPer5min = Math.floor(rep["maxPerSessionPer5min"]);
    }

    result.report = repResult;
  } else if (input["report"] !== undefined) {
    warn(`[residue] Invalid report config — using defaults`);
  }

  // dataDir
  if (typeof input["dataDir"] === "string") {
    const val = input["dataDir"] as string;
    if ((VALID_DATA_DIR_MODES as readonly string[]).includes(val)) {
      result.dataDir = val as DataDirMode;
    } else {
      warn(`[residue] Invalid dataDir mode "${val}" — using default (${DEFAULT_OPTIONS.dataDir})`);
    }
  }

  // debug
  if (typeof input["debug"] === "boolean") {
    result.debug = input["debug"];
  }

  return result;
}

/**
 * Redact secrets from a string for safe logging.
 * Masks API keys, tokens, and other credential patterns.
 *
 * @param str - String potentially containing secrets.
 * @returns String with secrets masked as `[REDACTED]`.
 */
export function redactSecrets(str: string): string {
  return str
    // API keys (sk-..., key-..., etc.)
    .replace(/\b(sk-[a-zA-Z0-9_-]{20,})\b/g, "[REDACTED]")
    .replace(/\b(key-[a-zA-Z0-9_-]{20,})\b/g, "[REDACTED]")
    // Bearer tokens
    .replace(/\b(Bearer\s+[a-zA-Z0-9._-]{20,})\b/gi, "Bearer [REDACTED]")
    // Generic API key patterns
    .replace(/(api[_-]?key\s*[=:]\s*['"]?)[a-zA-Z0-9._-]{16,}(['"]?)/gi, "$1[REDACTED]$2")
    // Token patterns
    .replace(/(token\s*[=:]\s*['"]?)[a-zA-Z0-9._-]{16,}(['"]?)/gi, "$1[REDACTED]$2")
    // Secret patterns
    .replace(/(secret\s*[=:]\s*['"]?)[a-zA-Z0-9._-]{16,}(['"]?)/gi, "$1[REDACTED]$2")
    // Password patterns
    .replace(/(password\s*[=:]\s*['"]?)[a-zA-Z0-9._-]{8,}(['"]?)/gi, "$1[REDACTED]$2");
}

/** Type guard: check if value is a plain object (not null, not array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
