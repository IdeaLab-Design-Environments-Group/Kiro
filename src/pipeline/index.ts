/**
 * Pipeline barrel (node-safe, mirrors `src/sim/index.ts`): no DOM and no
 * Three.js imports anywhere beneath this module, so the whole general
 * kirigamize pipeline runs and tests in plain Node.
 */

export * from "./types.js";
export * from "./mesh.js";
export * from "./import.js";
export * from "./conditioning.js";
