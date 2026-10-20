// Makes PetCheck's demo video (under 3 minutes) with AI, end to end:
//   1. Narration: each scene's text is spoken by a text-to-speech model (TTS_* settings) or, without
//      one, by macOS `say`. With VERIFY_MODEL set, every clip is transcribed back and re-made if the
//      words don't match.
//   2. Recording: Playwright drives the real app (`npm run demo:video`, with the model from .env)
//      through the scenes and records the screen, noting when each line is typed and when Alexa
//      answers. Lines are typed, not spoken: the mic needs a person.
//   3. Alexa's voice: what Alexa actually said, read by a second voice.
//   4. Editing: ffmpeg shortens the wait while the model thinks and lines the voices up with the picture.
//
//   petcheck$       npm run demo:video                  # the app on :3000, demo clock 5:35 PM
//   scripts/video$  npm run setup                       # once
//   scripts/video$  TTS_BASE_URL=… TTS_API_KEY=… VERIFY_MODEL=… npm run make
//   scripts/video$  … npm run make -- --edit         # re-cut the last recording (no app needed)
//
// Output: out/petcheck-demo.mp4, and out/frames.png (a frame from every scene) to check it.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const APP = process.env.APP_URL ?? "http://localhost:3000";
const OUT = process.env.OUT_DIR ?? "out";
const W = 1600;
const H = 900;
const TTS = {
  base: process.env.TTS_BASE_URL?.replace(/\/+$/, ""),
  key: process.env.TTS_API_KEY,
  model: process.env.TTS_MODEL ?? "google/gemini-3.8-flash-tts",
  narrator: process.env.NARRATOR_VOICE ?? "Charon",
  alexa: process.env.ALEXA_VOICE ?? "Kore",
};
const VERIFY_MODEL = process.env.VERIFY_MODEL; // a chat model that accepts input_audio, on the TTS endpoint
for (const d of [OUT, join(OUT, "audio"), join(OUT, "raw")]) mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------------------
// The story
// ---------------------------------------------------------------------------

/**
 * kind: slide (HTML card) | demo (the split screen) | missed (run the missed-task check at 7 PM).
 * A turn types one line as `speaker`; `voice` reads Alexa's answer aloud; `waitFor` is text the
 * household page should show afterwards (the shot holds until it does).
 */
const SCENES = [
  {
    id: "title",
    kind: "slide",
    slide: "title",
    narration:
      "Has anyone fed the cat? When several people share the pets, that question comes up every day, and the answer is usually a guess. So pets get fed twice, or miss dinner, or a dose of medicine.",
  },
  {
    id: "intro",
    kind: "demo",
    narration: "PetCheck fixes that with Alexa Plus. Anyone at home just says what they did. On the left is Alexa; on the right, the family's live page.",
  },
  {
    id: "dad",
    kind: "demo",
    narration: "Dad tells Alexa he fed Mochi. It's logged for the whole house, and here are the real MCP calls PetCheck makes.",
    turns: [{ speaker: "Dad", text: "I fed Mochi", voice: true, waitFor: "Dad · 5:40 PM" }],
  },
  {
    id: "duplicate",
    kind: "demo",
    narration: "Moments later, Emma doesn't know. PetCheck catches it: no double dinner.",
    turns: [
      { speaker: "Emma", text: "I fed Mochi", voice: true },
      { speaker: "Emma", text: "No thanks", voice: true },
    ],
  },
  {
    id: "natural",
    kind: "demo",
    narration: "A real AI model picks PetCheck's tools, so people can just talk. It logs the walk first, then answers from the updated log.",
    turns: [{ speaker: "Emma", text: "I just walked Biscuit. What else does he need today?", newConversation: true }],
  },
  {
    id: "missed",
    kind: "missed",
    narration:
      "Now it's seven, and nobody has fed Biscuit. Every five minutes, PetCheck checks each pet's routine. Thirty minutes late, the house gets a reminder. An hour late, the owner gets an email.",
  },
  { id: "email", kind: "slide", slide: "email", narration: null, seconds: 3 },
  {
    id: "post",
    kind: "demo",
    narration:
      "And when nobody at home can do it, Alexa asks the neighborhood. Mom just says what she needs. The AI fills in a request form, takes the location from the device, and reads it back before posting.",
    turns: [
      { speaker: "Mom", text: "We're away this Saturday and Sunday. Can you find someone to walk Biscuit twice a day?", newConversation: true },
      { speaker: "Mom", text: "Yes, post it.", voice: true, waitFor: "Waiting for a sitter" },
    ],
  },
  {
    id: "sitter",
    kind: "demo",
    narration:
      "Sam is a pet sitter a few streets away. He asks for jobs that suit him, and PetCheck filters by distance, pets, days and pay, skipping anything that clashes with his bookings.",
    turns: [{ speaker: "Sam", text: "Any dog walking jobs near me this weekend? At least $20 a visit." }],
  },
  {
    id: "take",
    kind: "demo",
    narration: "He takes it, and the family sees who's coming. Sam's visits go into the same log, and a missed visit raises the same alerts.",
    turns: [{ speaker: "Sam", text: "Great, I'll take the one for Biscuit.", waitFor: "Taken by Sam" }],
  },
  {
    id: "vet",
    kind: "demo",
    narration: "And PetCheck never plays vet.",
    turns: [{ speaker: "Mom", text: "Should I give Biscuit another dose?", voice: true, newConversation: true }],
  },
  {
    id: "architecture",
    kind: "slide",
    slide: "architecture",
    narration:
      "Under the hood, PetCheck is an MCP server over streamable HTTP, running statelessly on AWS Lambda with DynamoDB, EventBridge Scheduler and SNS. It works with any tool-calling model, and it's ready for real Alexa Plus: account linking and the listing are done.",
  },
  {
    id: "close",
    kind: "slide",
    slide: "close",
    narration: "Free for families, with a small fee on each visit booked through the care network. No app to install. You just say what you did. PetCheck.",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr?.slice(-2000)}`);
  return r.stdout;
}
const seconds = (file) => Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const words = (s) => s.toLowerCase().replace(/[^a-z0-9$ ]+/g, " ").split(/\s+/).filter(Boolean);

/** Text to a 24 kHz mono WAV, cached by voice + text. */
async function speak(text, voice) {
  const file = join(OUT, "audio", `${createHash("sha1").update(`${TTS.model}|${voice}|${text}`).digest("hex").slice(0, 16)}.wav`);
  if (existsSync(file)) return file;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await synthesize(text, voice, file);
    if (!VERIFY_MODEL || (await matches(file, text))) return file;
    console.warn(`  re-making a clip that didn't transcribe back (attempt ${attempt}): “${text.slice(0, 50)}…”`);
  }
  throw new Error(`speech for “${text.slice(0, 60)}…” never transcribed back correctly`);
}

async function synthesize(text, voice, file) {
  if (!TTS.base) {
    const aiff = file.replace(/\.wav$/, ".aiff");
    sh("say", ["-v", "Samantha", "-o", aiff, text]);
    sh("ffmpeg", ["-loglevel", "error", "-y", "-i", aiff, "-ar", "24000", "-ac", "1", file]);
    return;
  }
  const res = await fetch(`${TTS.base}/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TTS.key}` },
    body: JSON.stringify({ model: TTS.model, input: text, voice, response_format: "pcm" }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = Buffer.from(await res.arrayBuffer());
  // Some relays wrap a base64 WAV in JSON ({"audio": "UklGR…"}); others send WAV or raw 16-bit PCM.
  const wav = body[0] === 0x7b ? Buffer.from(JSON.parse(body.toString("utf8")).audio, "base64") : body;
  if (wav.subarray(0, 4).toString() === "RIFF") writeFileSync(file, wav);
  else {
    writeFileSync(`${file}.pcm`, wav);
    sh("ffmpeg", ["-loglevel", "error", "-y", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", `${file}.pcm`, file]);
  }
}

/** Transcribe a clip back and compare words (≥ 85% of the script's words heard). */
async function matches(file, text) {
  const res = await fetch(`${TTS.base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TTS.key}` },
    body: JSON.stringify({
      model: VERIFY_MODEL,
      max_tokens: 600,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Transcribe this audio exactly, word for word. Reply with the transcript only." },
            { type: "input_audio", input_audio: { data: readFileSync(file).toString("base64"), format: "wav" } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`transcription HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const heard = new Set(words((await res.json()).choices[0].message.content));
  const said = words(text);
  const score = said.filter((w) => heard.has(w)).length / said.length;
  return score >= 0.85;
}

// ---------------------------------------------------------------------------
// Slides (rendered in the same recorded page)
// ---------------------------------------------------------------------------

const LOGO = `<svg viewBox="0 0 512 512" width="96" height="96"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3d5afe"/><stop offset="1" stop-color="#2ec4f3"/></linearGradient></defs><rect width="512" height="512" rx="112" fill="url(#lg)"/><g fill="#fff"><ellipse cx="146" cy="214" rx="42" ry="54" transform="rotate(-18 146 214)"/><ellipse cx="216" cy="140" rx="44" ry="58" transform="rotate(-6 216 140)"/><ellipse cx="304" cy="140" rx="44" ry="58" transform="rotate(6 304 140)"/><ellipse cx="374" cy="214" rx="42" ry="54" transform="rotate(18 374 214)"/><path d="M260 236c-62 0-128 66-128 128 0 42 32 64 68 64 26 0 40-14 60-14s34 14 60 14c36 0 68-22 68-64 0-62-66-128-128-128z"/></g><circle cx="392" cy="392" r="86" fill="#1f8a4c" stroke="#fff" stroke-width="18"/><path d="M350 394l30 30 56-62" fill="none" stroke="#fff" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function slide(name) {
  const base = `<style>
    html,body{margin:0;height:100%;background:#0d1320;color:#eef2f8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
    .wrap{height:100%;box-sizing:border-box;padding:70px 90px;display:flex;flex-direction:column;justify-content:center;gap:28px}
    h1{font-size:76px;margin:0;letter-spacing:-.02em} h2{font-size:40px;margin:0;font-weight:650}
    p{font-size:30px;margin:0;color:#b8c3d6;line-height:1.35} .muted{color:#7f8aa0;font-size:22px}
    .row{display:flex;align-items:center;gap:28px}
    .box{background:#162036;border:2px solid #2a3a5c;border-radius:18px;padding:16px 20px;font-size:22px;line-height:1.35}
    .box b{display:block;font-size:24px;color:#fff;margin-bottom:4px} .hl{border-color:#2ec4f3}
    .arrow{color:#2ec4f3;font-size:34px;text-align:center}
    .grid{display:grid;grid-template-columns:1fr 60px 1fr 60px 1fr;align-items:center;gap:10px}
  </style>`;
  if (name === "title") {
    return `${base}<div class="wrap"><div class="row">${LOGO}<h1>PetCheck</h1></div>
      <h2>One shared pet care log for the whole household, on Alexa+</h2>
      <p>Log care by voice · catch double feedings · reminders when something's missed · help from sitters nearby</p>
      <div class="muted">Alexa+ track · demo of a simulated Alexa+ talking to the live PetCheck MCP server · sample household data</div></div>`;
  }
  if (name === "email") {
    const img = readFileSync(new URL("../../docs/screenshots/alert-email-biscuit.png", import.meta.url)).toString("base64");
    return `${base}<div class="wrap" style="align-items:center"><div class="muted">The owner's email, sent by Amazon SNS from the deployed PetCheck</div>
      <img src="data:image/png;base64,${img}" style="width:1300px;border-radius:14px;background:#fff;padding:18px"></div>`;
  }
  if (name === "architecture") {
    return `${base}<div class="wrap" style="gap:22px"><h2>How it works</h2>
      <div class="grid">
        <div class="box"><b>Simulated Alexa+</b>speech in and out in the browser · household members and pet sitters</div><div class="arrow">→</div>
        <div class="box"><b>Assistant</b>any tool-calling AI model (standard chat APIs, or Amazon Bedrock) · rules fallback · conversation memory</div><div class="arrow">→</div>
        <div class="box hl"><b>PetCheck MCP server</b>Streamable HTTP · MCP 2025-11-25 · 10 tools · stateless on AWS Lambda</div>
      </div>
      <div class="grid">
        <div class="box"><b>Real Alexa+</b>OAuth 2.1 account linking · listing ready (toolkit in private preview)</div><div class="arrow">↗</div>
        <div class="box"><b>Care network</b>requests with device location · matching by distance, pets, days, pay · no double booking</div><div class="arrow">↔</div>
        <div class="box"><b>AWS</b>DynamoDB · EventBridge Scheduler every 5 min · SNS email · IAM least privilege</div>
      </div>
      <div class="muted">Checked with the official MCP Inspector and an acceptance suite run against the real model</div></div>`;
  }
  return `${base}<div class="wrap"><div class="row">${LOGO}<h1>PetCheck</h1></div>
    <h2>Just say what you did.</h2>
    <p>Free for families. The care network earns a small fee on each booked visit.</p>
    <div class="muted">Built for the Amazon Alexa+ track · MCP server on AWS · open source (MIT)<br>Narration and Alexa's voice are AI-generated; the household and other requests are sample data.</div></div>`;
}

// ---------------------------------------------------------------------------
// 1. Narration
// ---------------------------------------------------------------------------

console.log(`1/4 Narration (${TTS.base ? `${TTS.model}, voice ${TTS.narrator}` : "macOS say"}${VERIFY_MODEL ? `, checked by ${VERIFY_MODEL}` : ""})`);
for (const s of SCENES) {
  if (!s.narration) continue;
  s.narrationFile = await speak(s.narration, TTS.narrator);
  s.narrationSec = seconds(s.narrationFile);
  console.log(`  ${s.id.padEnd(13)} ${s.narrationSec.toFixed(1)} s`);
}

// ---------------------------------------------------------------------------
// 2. Recording
// ---------------------------------------------------------------------------

const EDIT_ONLY = process.argv.includes("--edit");
let videoPath;
let events = [];
if (EDIT_ONLY) {
  ({ video: videoPath, events } = JSON.parse(readFileSync(join(OUT, "events.json"), "utf8")));
  console.log("2/4 Re-using the last recording:", videoPath);
} else {
console.log("2/4 Recording the app at", APP);
const health = await fetch(`${APP}/health`).catch(() => undefined);
if (!health?.ok) throw new Error(`The app isn't running at ${APP}. In petcheck/: npm run demo:video`);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: join(OUT, "raw"), size: { width: W, height: H } } });
const page = await context.newPage();
const t0 = Date.now();
const at = () => (Date.now() - t0) / 1000;
const alexa = page.frameLocator('iframe[title="Simulated Alexa+"]');
const house = page.frameLocator('iframe[title="Household page"]');
let onDemo = false;

async function openDemo() {
  await page.goto(`${APP}/demo?time=17:40&video=1`);
  for (const f of [alexa, house]) {
    const key = f.getByRole("textbox", { name: "Household key" });
    if (await key.isVisible().catch(() => false)) {
      await key.fill("demo");
      await key.press("Enter");
    }
  }
  await alexa.getByRole("checkbox", { name: "Speak replies" }).uncheck(); // Alexa's voice is added in editing
  await house.locator("#hero-big").filter({ hasNotText: "Loading" }).waitFor();
  await sleep(800);
  onDemo = true;
}

for (const s of SCENES) {
  const hold = (s.narrationSec ?? s.seconds ?? 2) + 1.5;
  if (s.kind === "slide") {
    await page.setContent(slide(s.slide));
    onDemo = false;
    await sleep(400);
    const start = at();
    await sleep(hold * 1000);
    events.push({ scene: s.id, start, end: at() });
    console.log(`  ${s.id}`);
    continue;
  }
  if (!onDemo) await openDemo();
  if (s.kind === "missed") {
    const demo = house.locator("#demo");
    await demo.locator("summary").click();
    await house.locator("#demo-time").fill("19:00");
    await house.locator("#demo-apply").click();
    await sleep(1200);
    const start = at();
    await house.locator("#run-check").click();
    await house.locator("#alerts").getByText("Owner alert").first().waitFor({ timeout: 15_000 });
    await sleep(hold * 1000);
    events.push({ scene: s.id, start, end: at() });
    // Back to 5:40 PM for the next scenes (not in the cut).
    await house.locator("#demo-time").fill("17:40");
    await house.locator("#demo-apply").click();
    await demo.locator("summary").click();
    await sleep(1500);
    console.log(`  ${s.id}`);
    continue;
  }
  const ev = { scene: s.id, start: at(), turns: [] };
  for (const turn of s.turns ?? []) {
    if (turn.newConversation) await alexa.locator("#clear").click();
    await alexa.getByRole("radio", { name: new RegExp(`^(🗣 )?${turn.speaker}\\b`) }).click();
    await sleep(300);
    const before = await alexa.locator(".bubble.alexa").count();
    const box = alexa.getByRole("textbox", { name: /type what you'd say/ });
    const typeStart = at();
    await box.pressSequentially(turn.text, { delay: 28 });
    await sleep(250);
    await box.press("Enter");
    const send = at();
    const bubble = alexa.locator(".bubble.alexa").nth(before);
    await bubble.waitFor({ timeout: 90_000 });
    const reply = at();
    const replyText = (await bubble.innerText()).replace(/^alexa\s*/i, "").trim();
    let update;
    if (turn.waitFor) {
      await house.getByText(turn.waitFor).first().waitFor({ timeout: 15_000 });
      update = at();
    }
    // Footage to hold on: Alexa's answer, the page catching up, and the rest of the narration.
    await sleep(Math.max(12, s.narrationSec ?? 0) * 1000);
    ev.turns.push({ ...turn, typeStart, send, reply, update, replyText });
    console.log(`  ${s.id}: ${turn.speaker}: “${turn.text}” → “${replyText.slice(0, 70)}…” (${(reply - send).toFixed(1)} s)`);
  }
  if (!s.turns) await sleep(hold * 1000);
  ev.end = at();
  events.push(ev);
}
videoPath = await page.video().path();
await context.close();
await browser.close();
writeFileSync(join(OUT, "events.json"), JSON.stringify({ video: videoPath, events }, null, 2));
}

// ---------------------------------------------------------------------------
// 3. Alexa's voice
// ---------------------------------------------------------------------------

console.log(`3/4 Alexa's voice (${TTS.base ? `voice ${TTS.alexa}` : "macOS say"})`);
for (const ev of events) {
  for (const t of ev.turns ?? []) {
    if (!t.voice) continue;
    t.voiceFile = await speak(t.replyText, TTS.alexa);
    t.voiceSec = seconds(t.voiceFile);
  }
}

// ---------------------------------------------------------------------------
// 4. Editing
// ---------------------------------------------------------------------------

console.log("4/4 Editing");
const segments = []; // { from, to, outLen } in source seconds → output seconds
const audio = []; // { file, at } in output seconds
let now = 0;
const add = (from, to, outLen = to - from) => {
  if (to - from < 0.04) return;
  segments.push({ from, to, outLen, start: now });
  now += outLen;
};
const sceneStarts = [];
for (const ev of events) {
  const s = SCENES.find((x) => x.id === ev.scene);
  sceneStarts.push({ id: s.id, at: now });
  const narrationAt = now + 0.25;
  if (s.narrationFile) audio.push({ file: s.narrationFile, at: narrationAt });
  const narrationEnd = narrationAt + (s.narrationSec ?? 0);
  if (!ev.turns?.length) {
    add(ev.start, Math.min(ev.end, ev.start + (s.narrationSec ?? s.seconds ?? 2) + 0.8));
    continue;
  }
  ev.turns.forEach((t, i) => {
    add(t.typeStart, t.send); // typing, real speed
    // The model's thinking time, shortened. Alexa answers aloud only after the narrator is done.
    const wait = t.voice ? Math.max(0.7, narrationEnd + 0.2 - now) : 0.7;
    add(t.send, t.reply, wait);
    let hold = t.voice ? t.voiceSec + 0.9 : 1.6;
    if (t.update) hold = Math.max(hold, t.update - t.reply + 1.4);
    const last = i === ev.turns.length - 1;
    if (last) hold = Math.max(hold, narrationEnd + 0.5 - now);
    if (t.voice) audio.push({ file: t.voiceFile, at: now + 0.2 });
    add(t.reply, t.reply + Math.min(hold, ev.end - t.reply - 0.05));
  });
}
const total = now;
console.log(`  ${segments.length} cuts, ${audio.length} voice clips, ${total.toFixed(1)} s`);
if (total >= 180) console.warn("  ⚠ over 3 minutes: shorten the narration");

// Picture: each segment cut, retimed and encoded on its own (1920×1080, 30 fps), then joined.
mkdirSync(join(OUT, "seg"), { recursive: true });
const list = segments.map((g, i) => {
  const f = join(OUT, "seg", `${String(i).padStart(3, "0")}.mp4`);
  const stretch = (g.outLen / (g.to - g.from)).toFixed(5);
  sh("ffmpeg", [
    "-loglevel", "error", "-y", "-ss", g.from.toFixed(3), "-to", g.to.toFixed(3), "-i", videoPath,
    "-vf", `setpts=PTS*${stretch},fps=30,scale=1920:1080:flags=lanczos,format=yuv420p`,
    "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", f,
  ]);
  g.actual = seconds(f);
  return `file '${f.split("/").pop()}'`;
});
writeFileSync(join(OUT, "seg", "list.txt"), list.join("\n") + "\n");
const picture = join(OUT, "picture.mp4");
sh("ffmpeg", ["-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(OUT, "seg", "list.txt"), "-c", "copy", picture]);

// Whole frames make each segment a little longer or shorter than planned: map planned times to real ones.
let acc = 0;
for (const g of segments) {
  g.actualStart = acc;
  acc += g.actual;
}
const real = (t) => {
  const g = [...segments].reverse().find((x) => x.start <= t) ?? segments[0];
  return g.actualStart + Math.min(t - g.start, g.outLen) * (g.actual / g.outLen);
};
const length = seconds(picture);

// Sound: every clip at its moment, mixed, then loudness-normalized for YouTube.
const a =
  audio.map((c, i) => `[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(real(c.at) * 1000)}:all=1[a${i}]`).join(";") +
  `;${audio.map((_, i) => `[a${i}]`).join("")}amix=inputs=${audio.length}:normalize=0:duration=longest,apad,atrim=0:${length.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;
const final = join(OUT, "petcheck-demo.mp4");
sh("ffmpeg", [
  "-loglevel", "error", "-y", "-i", picture, ...audio.flatMap((c) => ["-i", c.file]),
  "-filter_complex", a, "-map", "0:v", "-map", "[aout]",
  "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-t", length.toFixed(3), final,
]);
for (const s of sceneStarts) s.at = real(s.at);

// A frame from the middle of every scene, tiled, to check the cut at a glance.
const marks = sceneStarts.map((s, i) => (s.at + (sceneStarts[i + 1]?.at ?? length)) / 2);
const frames = marks.map((t, i) => {
  const f = join(OUT, `frame-${String(i).padStart(2, "0")}.png`);
  sh("ffmpeg", ["-loglevel", "error", "-y", "-ss", t.toFixed(2), "-i", final, "-frames:v", "1", "-vf", "scale=640:-1", f]);
  return f;
});
sh("ffmpeg", ["-loglevel", "error", "-y", ...frames.flatMap((f) => ["-i", f]), "-filter_complex", `${frames.map((_, i) => `[${i}:v]`).join("")}xstack=inputs=${frames.length}:layout=${frames.map((_, i) => `${(i % 4) * 640}_${Math.floor(i / 4) * 360}`).join("|")}:fill=black`, join(OUT, "frames.png")]);

writeFileSync(join(OUT, "timeline.json"), JSON.stringify({ length, scenes: sceneStarts, audio: audio.map((c) => ({ ...c, real: real(c.at) })) }, null, 2));
console.log(`✔ ${final} · ${seconds(final).toFixed(1)} s`);
for (const s of sceneStarts) console.log(`  ${new Date(s.at * 1000).toISOString().slice(14, 19)}  ${s.id}`);
