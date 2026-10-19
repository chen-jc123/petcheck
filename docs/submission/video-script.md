# Demo video: shot list (under 3 minutes)

The narration is the `SCENES` text in [`scripts/make-narration-polly.sh`](../../scripts/make-narration-polly.sh)
(one MP3 per scene from `npm run narration:polly`, Amazon Polly). Estimated narration: about 2 min 12 s,
which leaves about 45 s for pauses and transitions. Judges may stop at 3:00, so keep the order.

Every action below was rehearsed on 2026-10-20 against the real model (`qwen3.8-max`) at demo time
5:40 PM; the expected replies are what it actually said. Wording varies a little between runs, but the
tool calls and the data on the right do not.

## Setup

1. `.env` with the model settings (see `.env.example`), then `npm run demo:video`
   (household seeded as if it were 5:35 PM, both dinners still open, no real-time checks).
   For the deployed version instead: `npm run db:demo -- 17:35`.
2. Chrome, window about 1280×720, open `http://localhost:3000/demo?time=17:40`, enter any key in both panels.
3. Keep **Speak replies** on so Alexa's voice is in the video. Use the mic for at least scene 3 (the rules
   ask for the simulated experience to be shown working). Chrome's speech recognition needs a connection to
   Google's speech service; if it fails, Safari works too.
4. No third-party logos or music. The engine badge shows the model name; that's fine as a technical label,
   but don't add brand logos.

## Scenes

| # | Narration (short) | On screen | Expected result |
|---|---|---|---|
| 1 | "Has anyone fed the cat?" … | Title card or the household page | — |
| 2 | PetCheck fixes that with Alexa Plus … | Split screen `/demo`; point at left (Alexa) and right (household) | — |
| 3 | Dad feeds Mochi and tells Alexa … real MCP calls | Speaker **Dad**, mic: "I fed Mochi". Open the MCP traffic panel | "Thanks, Dad. I've logged that you fed Mochi at 5:40 PM." · `initialize → tools/list → tools/call log_care` · Mochi's dinner turns green on the right |
| 4 | Moments later, Emma … No double dinner | Speaker **Emma**: "I fed Mochi", then "No thanks" | "Dad already fed Mochi at 5:40 PM, just a minute ago. Do you want me to log it again?" → "No problem, I won't log it again." Nothing new on the right |
| 5 | A real language model is listening … if nobody says which pet, it asks | **New conversation**. Emma: "I just walked Biscuit. What else does he need today?" Then **New conversation**, Dad: "I fed him." | `log_care → get_status`: "…He still needs his dinner, which was due at 5:30 PM." Then "Which pet did you feed?" (don't answer; Biscuit's dinner must stay open for scene 6) |
| 6 | Now it's 7 PM, and nobody fed Biscuit … owner gets an email | Right: **Demo controls → 19:00 → Show → Run missed-task check**. Cut to `docs/screenshots/alert-email-biscuit.png` | Reminder: "Biscuit's dinner was due at 5:30 PM and hasn't been logged yet." Owner alert: "…1 hour 30 minutes ago." |
| 7 | Mom asks how Mochi's week went … reminds the house the day before | Speaker **Mom**: "How's Mochi doing this week?" then "Book Mochi's checkup next Tuesday at 10" | Weekly summary (13 of 14 feedings, missed Wednesday's litter and Friday's dinner, the Saturday note); visit booked, "I'll remind everyone the day before." Vet visits card appears on the right |
| 8 | PetCheck never plays vet | Mom: "Should I give Biscuit another dose?" | "I can't advise on medication doses, so please check with your vet…" No tool call |
| 9 | Under the hood … simulated Alexa Plus that calls the same live server | README architecture diagram; terminal running `npm run check:mcp` (MCP Inspector); briefly the AWS console (Lambda, EventBridge schedule) | "All MCP Inspector checks passed." |
| 10 | No app to install … PetCheck. | Household page, all green | — |

## Before uploading

- Length under 3:00; public on YouTube or Vimeo; English.
- What's said matches what's shown (the model really answers; pets and last week are sample data).
- Put the model name and the fact that Alexa+ is simulated in the Devpost description too.
