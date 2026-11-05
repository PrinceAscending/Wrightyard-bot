import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

// Load .env.local first (local overrides), then .env. Values already present in
// the process environment always win, which is what hosting platforms provide.
// A host-managed file can be pointed at with WRIGHTYARD_ENV_FILE (useful for
// one-off command registration under systemd).
const envFile = process.env.WRIGHTYARD_ENV_FILE;
loadDotenv({
  path: [
    ...(envFile ? [envFile] : []),
    fileURLToPath(new URL("../.env.local", import.meta.url)),
    fileURLToPath(new URL("../.env", import.meta.url)),
  ],
  quiet: true,
});
