// Bundle the Lambda handler into one ESM file: dist/lambda/lambda.mjs
// The AWS SDK v3 is already included in the Lambda Node.js runtime, so it's left out.
import { build } from "esbuild";
import { copyFileSync, rmSync } from "node:fs";

rmSync("dist/lambda", { recursive: true, force: true });

await build({
  entryPoints: ["src/lambda.ts"],
  outfile: "dist/lambda/lambda.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: ["@aws-sdk/*"],
  // Express and some deps use require(); give ESM output a working require.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
});

// The pages are read from disk at runtime (see src/page.ts).
for (const f of ["household.html", "alexa.html", "demo.html"]) {
  copyFileSync(`src/${f}`, `dist/lambda/${f}`);
  console.log(`  dist/lambda/${f} (copied)`);
}
