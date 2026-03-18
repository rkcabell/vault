import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const nextDir = path.resolve(__dirname, "..", ".next");

await rm(nextDir, { recursive: true, force: true });
console.log(`[clean-next] removed ${nextDir}`);
