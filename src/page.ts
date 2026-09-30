// The household page (src/household.html), served at "/" by both entry points.
// In the Lambda bundle the build script copies the HTML next to lambda.mjs,
// so the same relative URL works in dev (src/) and on Lambda (dist/lambda/).
import { readFileSync } from "node:fs";

let cached: string | undefined;

export function householdPage(): string {
  cached ??= readFileSync(new URL("./household.html", import.meta.url), "utf8");
  return cached;
}
