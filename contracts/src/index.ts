// Shared schemas for threads (ADR 0010, ADR 0011). Backend modules import this
// file by relative path; the dashboard imports it through its own alias.
export { z } from "zod";
export const CONTRACTS_VERSION = 1;
