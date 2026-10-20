# PetCheck: Devpost project description (draft)

> Draft for the Devpost "About the project" field. The team should read it, change anything that doesn't
> match their own experience, and keep every claim true to what the demo shows.

**Tagline:** One shared pet care log for the whole household: tell Alexa what you did, and everyone knows
what's done and what's still due. When nobody at home can do it, Alexa finds a sitter nearby.

## Inspiration

"Has anyone fed the cat?" gets asked in homes with pets every day, and the answer is usually a guess.
When several people share the care, pets get fed twice, or miss dinner or a dose of medication, because
everyone assumes someone else did it. The moment you'd record it is the worst moment to open an app: your
hands are full with a food bowl, a leash or a pill pocket. Saying it out loud is the natural interface.

## What it does

- **Log by voice.** Anyone says "I fed Mochi" or "just walked the dog", and it's in the household's shared log.
- **Catches double feedings.** If Emma logs Mochi's dinner a few minutes after Dad did, Alexa says "Dad
  already fed Mochi at 5:40 PM. Do you want me to log it again?" and only logs it if she says yes.
- **Answers in plain speech.** "Has anyone walked Biscuit?", "What's left for Mochi today?", "How's Mochi
  doing this week?" (meals, walks, medication, missed tasks, notes, who helped most).
- **Talk naturally.** "I just walked Biscuit. What else does he need today?" logs the walk, then answers
  from the updated log. "I fed him" with no pet named gets "Which pet?" instead of a guess.
- **Nothing slips through.** Every 5 minutes PetCheck checks each pet's routine. 30 minutes late: a
  reminder for the household. 60 minutes late: an email to the owner. A vet visit is announced the day before.
- **Notes, never diagnoses.** "Mochi threw up this morning" is recorded and counted in the weekly summary.
  Questions about symptoms, doses or food safety get "please check with your vet."
- **A live household page** shows today's timeline, each pet's 7-day history, alerts, and one-tap logging.
- **Help from sitters nearby (the care network).** "We're away this Saturday and Sunday. Can someone walk
  Biscuit twice a day?" The assistant fills in a fixed-format request (pets, service, dates, times, typical
  local pay), takes the location from the device, reads it back and posts it after a yes. A pet sitter asks
  "Any dog walking jobs near me this weekend? At least $20 a visit." and gets the requests that fit: within
  the distance, for the right pets and days, paying enough, not clashing with jobs they already have. When
  they take one, the family is told who's coming, the sitter's visits go into the same shared log, and a
  missed visit raises the same alerts. Sitters see the area, never the exact address.
- **It remembers the conversation.** Follow-ups like "How about Biscuit?" or "I just gave her dinner" work,
  because each device's last turns, tool results included, are kept server-side for 30 minutes.

## How we built it

- **MCP server** (TypeScript, official `@modelcontextprotocol/sdk`), MCP spec **2025-11-25** over
  **Streamable HTTP**, stateless: a fresh server per request and no sessions, so it runs unchanged on Lambda.
  Ten tools (the care log: `add_pet`, `log_care`, `get_status`, `add_note`, `add_vet_visit`, `weekly_summary`;
  the care network: `post_care_request`, `find_care_requests`, `accept_care_request`, `care_request_status`) with zod
  schemas, read-only annotations, and replies written to be spoken as-is plus structured content.
  Checked with the official MCP Inspector (`npm run check:mcp`).
- **AWS:** Lambda with a Function URL (MCP endpoint, API, pages, OAuth), DynamoDB single-table storage,
  EventBridge Scheduler for the 5-minute missed-task check, SNS for owner emails, IAM least privilege, and
  Amazon Polly for the narration of our first demo cut.
- **Alexa+ readiness:** OAuth 2.1 (client credentials, and authorization code with PKCE for account
  linking), listing text, icons and carousel image, privacy and terms pages.
- **Simulated Alexa+:** the Alexa+ add-on toolkit is in private preview and not open to hackathon
  participants, so, as the rules allow, the demo is a web page with browser speech in and out. Its backend
  is a real MCP client that calls the same server over HTTP; the page shows every MCP request.
- **The model:** a tool-calling language model decides which PetCheck tools to call. The adapter speaks the
  OpenAI Chat Completions, Anthropic Messages and Amazon Bedrock Converse protocols, against any compatible
  endpoint. Our AWS account is still waiting for Bedrock access, so during development we used relays
  and Alibaba Cloud Model Studio; the demo video runs Claude Opus 5.5 through a relay's
  Anthropic-compatible endpoint. Claude Opus 5.5, Opus 5, Sonnet 5, Haiku 5.5 and Haiku 4.5, GPT-4.1 mini and
  Qwen 3.8 Max all pass our acceptance suite. A confirmation (a duplicate feeding, a care request draft) has
  to come from the person's next line: the assistant won't let a model confirm its own question. If the model can't be reached, a built-in rules engine answers through the same MCP
  tools, and the page labels which engine replied (the video shows it generically as "AI model").
- **Storage:** records are only ever added, never updated, in memory, an append-only file locally, or
  DynamoDB, so devices can't overwrite each other. The care network lives in a partition shared by every
  household; a sitter taking a job is its own record, and the first one wins.

## Challenges we ran into

- The SDK's Node transport doesn't work behind `serverless-http` on Lambda; we switched to the SDK's
  web-standard transport and map Function URL events to standard Requests (friction log FL-005).
- Bedrock refused our new account with a `ValidationException` asking for corporate verification (FL-006),
  which is why the model layer became protocol-agnostic with a rules fallback.
- Browser speech recognition hears "Mochi" as "Monkey" or "Machi" (FL-007); the server matches names
  within a small edit distance and asks rather than logging the wrong pet.
- The Alexa+ developer tools turned out to be private preview (FL-008).
- With a real model, the first acceptance run showed it answering follow-ups from conversation history
  instead of calling a tool, and inventing that the household had no pets. We added explicit grounding rules
  and an acceptance suite that checks tool calls and stored data, not just the wording.
- Speed: by default these models think before answering, which tripled the time of a spoken turn. Every model
  family turns that off differently (and some refuse to), so it's a per-model setting.

## Accomplishments that we're proud of

- An acceptance suite of 12 scenarios, from "I fed him" with no pet named to a sitter taking a job and
  logging the visit, that passes against real models over both protocols and checks the stored data.
- The demo video itself was produced by a script: AI narration checked by transcription, a recorded run of
  the real app, and an automated cut.
- Offline tests for every layer, including OAuth flows and the Lambda handler with fake Function URL events.
- A safety boundary that is built into the tools, not just the prompt.

## What we learned

<!-- Team: write this in your own words. -->

## What's next for PetCheck

- Connect to real Alexa+ as soon as the add-on toolkit opens (the OAuth endpoints and listing are ready).
- Let an MCP add-on bias speech recognition toward the household's pet names.
- Sitter profiles, reviews and payments for the care network; multiple households and invitations.
- Smart pet feeders and pill boxes that log automatically.

## Built during the hackathon

PetCheck is a new project: the first commit is 2026-09-29, inside the Submission Period that started on
2026-08-31. All code, tests and materials were created during the hackathon.

## Built with

typescript · node.js · model-context-protocol · aws-lambda · amazon-dynamodb · amazon-eventbridge ·
amazon-sns · amazon-polly · aws-iam · oauth2 · web-speech-api · large-language-models · playwright · ffmpeg
