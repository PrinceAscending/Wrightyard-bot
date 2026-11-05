import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const source = readFileSync(new URL("../src/version.ts", import.meta.url), "utf8");
const match = source.match(/VERSION\s*=\s*"([^"]+)"/);

if (!match) {
  console.error("check-version: could not find VERSION in src/version.ts");
  process.exit(1);
}

if (match[1] !== pkg.version) {
  console.error(
    `check-version: package.json is ${pkg.version} but src/version.ts is ${match[1]}`,
  );
  process.exit(1);
}

console.log(`version: ${pkg.version}`);
