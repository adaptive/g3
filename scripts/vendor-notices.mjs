import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "node_modules/heic-to");
const clientOutput = join(root, "dist/client");
const target = join(clientOutput, "third-party/heic-to-1.6.7");
try {
  await readFile(join(clientOutput, "index.html"));
} catch {
  throw new Error("Run the Vite production build before copying HEIC notices into dist/client.");
}
const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
if (pkg.version !== "1.6.7" || pkg.license !== "LGPL-3.0") {
  throw new Error(
    `Update the HEIC source bundle and notice for ${pkg.version} (${pkg.license}) before building.`,
  );
}

// Publish the replaceable CSP build and its corresponding sources with the app.
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const relative of [
  "LICENSE",
  "README.md",
  "package.json",
  "esbuild.mjs",
  "src",
  "dist/csp/heic-to.js",
  "dist/csp/heic-to.d.ts",
]) {
  const destination = join(target, relative);
  await mkdir(join(destination, ".."), { recursive: true });
  await cp(join(source, relative), destination, { recursive: true });
}
await writeFile(
  join(target, "NOTICE.txt"),
  `heic-to 1.6.7 is used for in-browser HEIC and HEIF conversion.
License: GNU Lesser General Public License, version 3 or later (see LICENSE).

heic-to 1.6.7 bundles libheif 1.23.7. See README.md and upstream licensing
and source materials for component details.

Replaceable, unminified CSP bundle: dist/csp/heic-to.js
Corresponding sources: src/ and the unminified CSP bundle above.
Application code and build inputs are available at:
https://github.com/adaptive/adaptive-gallery
`,
);
