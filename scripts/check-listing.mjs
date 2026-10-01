// Checks alexa/listing.md against the Alexa+ MCP add-on limits, and the media sizes.
import { readFileSync } from "node:fs";
const md = readFileSync("alexa/listing.md", "utf8");
const section = (title) => md.split(`## ${title}`)[1].split("\n## ")[0].replace(/^[^\n]*\n/, "").trim();
const short = section("Short description");
const full = section("Full description");
const phrases = section("Example phrases").split("\n").map((l) => l.replace(/^\d+\.\s*/, "").trim()).filter(Boolean);
let ok = true;
const check = (label, cond, detail) => { console.log(`${cond ? "✔" : "✖"} ${label}: ${detail}`); ok &&= cond; };
check("short description", short.length <= 123, `${short.length}/123 chars`);
check("full description", full.length <= 4000, `${full.length}/4000 chars`);
check("example phrases", phrases.length >= 3 && phrases.length <= 4 && phrases.every((p) => p.length <= 200), `${phrases.length} phrases, longest ${Math.max(...phrases.map((p) => p.length))}/200 chars`);
const pngSize = (f) => { const b = readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
for (const s of [72, 64, 88, 126, 180, 241]) { const [w, h] = pngSize(`alexa/assets/icon-${s}.png`); check(`icon-${s}.png`, w === s && h === s, `${w}×${h}`); }
const [cw, ch] = pngSize("alexa/assets/carousel-600x900.png");
check("carousel-600x900.png", cw === 600 && ch === 900, `${cw}×${ch}`);
process.exit(ok ? 0 : 1);
