// Static pages served by both entry points (local server and Lambda):
//   /          household.html  live view of today's care, alerts and activity
//   /alexa     alexa.html      simulated Alexa+ (voice in/out, Bedrock, MCP traffic log)
//   /demo      demo.html       split screen: /alexa on the left, / on the right
//   /privacy   privacy.html    privacy policy (linked from the Alexa+ listing)
//   /terms     terms.html      terms of use (linked from the Alexa+ listing)
// In the Lambda bundle the build script copies the HTML next to lambda.mjs, so the
// same relative URL works in dev (src/) and on Lambda (dist/lambda/).
import { readFileSync } from "node:fs";

export const PAGES: Record<string, string> = {
  "/": "household.html",
  "/household": "household.html",
  "/alexa": "alexa.html",
  "/demo": "demo.html",
  "/privacy": "privacy.html",
  "/terms": "terms.html",
};

const cache = new Map<string, string>();

export function page(path: string): string | undefined {
  const file = PAGES[path];
  if (!file) return undefined;
  if (!cache.has(file)) cache.set(file, readFileSync(new URL(`./${file}`, import.meta.url), "utf8"));
  return cache.get(file);
}

/** Back-compat helper. */
export function householdPage(): string {
  return page("/")!;
}
