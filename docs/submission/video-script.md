# Demo video (under 3 minutes)

The video is made with AI by [`scripts/video/make-video.mjs`](../../scripts/video/make-video.mjs): a
text-to-speech model reads the narration (each clip is transcribed back and remade if the words don't
match); Playwright drives the real app, with the real model answering, and records the screen; a second
voice reads Alexa's actual answers; ffmpeg shortens the wait while the model thinks and lines everything up.
The narration lives in the `SCENES` list there (and, for an Amazon Polly voice, in
`scripts/make-narration-polly.sh`).

## Make it

```bash
# terminal 1, in petcheck/: the app with the model from .env, the day seeded as of 5:35 PM
npm run demo:video

# terminal 2
cd scripts/video
npm run setup                                    # once: Playwright + Chromium
TTS_BASE_URL=https://zenmux.ai/api/v1 TTS_API_KEY=… VERIFY_MODEL=google/gemini-3.5-flash npm run make
```

Without `TTS_BASE_URL` it falls back to macOS `say`. Output: `scripts/video/out/petcheck-demo.mp4`
(1920×1080, 30 fps, AAC, loudness-normalized), plus `out/frames.png`, one frame from every scene for a quick
check. Restart `npm run demo:video` before each run so the household starts fresh.

## The story

| # | Scene | On screen | Shows |
|---|---|---|---|
| 1 | Title | Title card | The problem: "Has anyone fed the cat?" |
| 2 | Intro | Split screen: Alexa left, household page right | The two sides |
| 3 | Dad | "I fed Mochi"; the MCP traffic panel | Shared log, real MCP calls |
| 4 | Duplicate | Emma: "I fed Mochi", "No thanks" | The duplicate check |
| 5 | Natural | "I just walked Biscuit. What else does he need today?" | A real model: log, then answer |
| 6 | Missed | Demo controls → 7 PM → missed-task check | Household reminder and owner alert |
| 7 | Email | The SNS email from the deployed PetCheck | Owner notification |
| 8 | Post | Mom asks for weekend walks, then "Yes, post it." | Care request: form, device location, read back, posted |
| 9 | Sitter | Sam: "Any dog walking jobs near me this weekend? At least $20 a visit." | Matching by distance, pets, days, pay |
| 10 | Take | Sam takes it; the household page shows "Taken by Sam" | Booking and the household alert |
| 11 | Vet | "Should I give Biscuit another dose?" | The safety boundary |
| 12 | Architecture | Diagram card | MCP on AWS, any model, Alexa+ readiness |
| 13 | Close | Title card | Business model and the closing line |

## Rules this follows

- Under 3 minutes; English; shows the simulated Alexa+ working against the live MCP server.
- **No third-party trademarks:** the recording uses `/demo?video=1`, which shows the model as "AI model" and
  leaves vendor names out of the page footer. The Devpost description names the model.
- No music. Every voice is AI-generated, and the closing card says so (and that the data is sample data).
- Lines are typed, not spoken, because the mic needs a person. The narration doesn't claim otherwise.

## Before uploading

- Watch it once from start to finish, and listen for any mispronunciation (the transcription check catches
  missing words, not tone).
- Upload as public on YouTube or Vimeo, and put the link in the Devpost form.
