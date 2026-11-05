import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

/**
 * The directory that contains the running entry point. For `node index.js`
 * this is the folder holding the standalone bundle; for `node dist/index.js`
 * it is the compiled directory.
 */
export function entryDir(): string {
  const entry = process.argv[1];
  return entry ? dirname(resolve(entry)) : process.cwd();
}

// Load .env.local first (local overrides), then .env. Values already present in
// the process environment always win, which is what hosting platforms provide.
// A host-managed file can be pointed at with WRIGHTYARD_ENV_FILE (useful for
// one-off command registration under systemd).
const envFile = process.env.WRIGHTYARD_ENV_FILE?.trim();
const candidates = [
  ...(envFile ? [resolve(envFile)] : []),
  resolve(process.cwd(), ".env.local"),
  resolve(process.cwd(), ".env"),
  resolve(entryDir(), ".env.local"),
  resolve(entryDir(), ".env"),
];

loadDotenv({
  path: [...new Set(candidates)],
  quiet: true,
});
