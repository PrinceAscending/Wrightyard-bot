import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Optional native/peer packages are loaded lazily by discord.js and the
// MongoDB driver. Leaving them external keeps the bundle portable: the code
// paths that use them are feature-gated and fall back gracefully when absent.
const optionalExternals = [
  "@aws-sdk/credential-providers",
  "@azure/identity",
  "@google-cloud/kms",
  "@mongodb-js/zstd",
  "aws4",
  "bufferutil",
  "gcp-metadata",
  "kerberos",
  "mongodb-client-encryption",
  "snappy",
  "socks",
  "utf-8-validate",
  "zlib-sync",
];

await build({
  entryPoints: [join(root, "src", "index.ts")],
  outfile: join(root, "index.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  banner: { js: "#!/usr/bin/env node" },
  external: optionalExternals,
  legalComments: "none",
  logLevel: "info",
});

console.log(`bundle: index.js (${pkg.version})`);
