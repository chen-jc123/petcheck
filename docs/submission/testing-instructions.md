# PetCheck: testing instructions for judges (draft)

> For the Devpost "Testing instructions" field. Fill in the two placeholders after the final deploy, and keep
> the deployment and the model key working until the Judging Period ends (2026-11-20, 12:00 PM PT).

## Live demo (no install)

- Split screen, simulated Alexa+ and household page: `https://<FUNCTION-URL>/demo`
- Household key (enter it in both panels): `<HOUSEHOLD-KEY>`
- Browser: Chrome or Safari for the mic; typing works in any browser.
- The household uses sample data (two pets, Mochi the cat and Biscuit the dog, and a seeded past week).
  Times are in the household's time zone (America/Detroit).

Try, in order:

1. Pick **Dad**, say or type "I fed Mochi". The household page on the right updates within seconds; the
   MCP traffic panel shows `initialize → tools/list → tools/call log_care`.
2. Pick **Emma**, "I fed Mochi" again: "Dad already fed Mochi… log it again?" Answer "no thanks" (nothing
   is logged) or "yes" (logged for Emma).
3. "I just walked Biscuit. What else does he need today?" logs the walk, then answers what's still due.
4. **New conversation**, then "I fed him." Alexa asks which pet before logging anything.
5. "How's Mochi doing this week?" and "Book Mochi's checkup next Tuesday at 10".
6. "Should I give Biscuit another dose?" PetCheck refers you to a vet and logs nothing.
7. Missed tasks: on the right, **Demo controls → 19:00 → Show → Run missed-task check**. The reminder and
   the owner alert appear (on AWS, EventBridge Scheduler runs this check every 5 minutes on its own).
8. The care network, as **Mom**: "We're away this Saturday and Sunday. Can someone walk Biscuit twice a
   day?" Alexa reads back the request (location from the device, the household's address here); say "yes"
   and it appears under **Care requests** on the right.
9. Switch to **Sam · sitter** (his phone is set a few streets away): "Any dog walking jobs near me this
   weekend? At least $20 a visit." then "I'll take the one for Biscuit." The household page shows
   "Taken by Sam" and a Care network alert. Other households' requests in the list are sample data.

Follow-ups work because each device's conversation is remembered for 30 minutes; **New conversation**
starts over.

The badge at the top of the Alexa panel shows which engine answered (the model name, or "rules" if the
model can't be reached).

## The MCP server directly

- Endpoint: `https://<FUNCTION-URL>/mcp` (Streamable HTTP, MCP spec 2025-11-25)
- Auth: header `Authorization: Bearer <HOUSEHOLD-KEY>` (or `x-api-key`), or OAuth 2.1 (metadata at
  `/.well-known/oauth-authorization-server`)
- With the official MCP Inspector, from a clone of the repo:
  `API_KEY=<HOUSEHOLD-KEY> npm run check:mcp -- https://<FUNCTION-URL>/mcp`
  (lists the 10 tools, calls a read tool, a write tool and an invalid one).

## Run it locally (about 2 minutes)

Requires Node 20+.

```bash
npm install
npm test            # offline checks, no keys needed
npm run demo        # http://localhost:3000/demo, built-in rules engine, no keys
```

With a language model: copy `.env.example` to `.env`, add an API key for any OpenAI-compatible or
Anthropic-compatible endpoint, then `npm run demo:ai`. `npm run test:live` replays the acceptance scenarios
against that model.
