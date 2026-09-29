/**
 * Re-export of the Embedder and ResolvedEmbedder interfaces.
 *
 * The canonical type definitions live in `core/ports.ts`. This module
 * provides a single import point for embed modules so they don't need
 * to reach into `core/` directly.
 *
 * @module embed/port
 */

export type { Embedder, ResolvedEmbedder } from "../core/ports.js";
