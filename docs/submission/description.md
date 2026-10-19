# PetCheck: Devpost project description (draft)

> Draft for the Devpost "About the project" field. The team should read it, change anything that doesn't
> match their own experience, and keep every claim true to what the demo shows.

**Tagline:** One shared pet care log for the whole household: tell Alexa what you did, and everyone knows
what's done and what's still due.

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

## How we built it

- **MCP server** (TypeScript, official `@modelcontextprotocol/sdk`), MCP spec **2025-11-25** over
  **Streamable HTTP**, stateless: a fresh server per request and no sessions, so it runs unchanged on Lambda.
  Six tools (`add_pet`, `log_care`, `get_status`, `add_note`, `add_vet_visit`, `weekly_summary`) with zod
  schemas, read-only annotations, and replies written to be spoken as-is plus structured content.
  Checked with the official MCP Inspector (`npm run check:mcp`).
- **AWS:** Lambda with a Function URL (MCP endpoint, API, pages, OAuth), DynamoDB single-table storage,
  EventBridge Scheduler for the 5-minute missed-task check, SNS for owner emails, IAM least privilege, and
  Amazon Polly for the video narration.
- **Alexa+ readiness:** OAuth 2.1 (client credentials, and authorization code with PKCE for account
  linking), listing text, icons and carousel image, privacy and terms pages.
- **Simulated Alexa+:** the Alexa+ add-on toolkit is in private preview and not open to hackathon
  participants, so, as the rules allow, the demo is a web page with browser speech in and out. Its backend
  is a real MCP client that calls the same server over HTTP; the page shows every MCP request.
- **The model:** a tool-calling language model decides which PetCheck tools to call. The adapter speaks the
  OpenAI Chat Completions, Anthropic Messages and Amazon Bedrock Converse protocols. Our AWS account is
  still waiting for Bedrock access, so the demo uses Qwen (`qwen3.8-max`) through Alibaba Cloud Model
  Studio's OpenAI-compatible endpoint. If the model can't be reached, a built-in rules engine answers
  through the same MCP tools, and the page labels which engine replied.

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

## Accomplishments that we're proud of

- An acceptance suite of 8 household scenarios (natural phrasing, log-and-ask in one sentence, follow-ups,
  ambiguous pets, duplicate confirm and cancel, unknown pets, a dose question, booking a vet visit) that
  passes against the real model on both the OpenAI- and Anthropic-compatible protocols.
- Offline tests for every layer, including OAuth flows and the Lambda handler with fake Function URL events.
- A safety boundary that is built into the tools, not just the prompt.

## What we learned

<!-- Team: write this in your own words. -->

## What's next for PetCheck

- Connect to real Alexa+ as soon as the add-on toolkit opens (the OAuth endpoints and listing are ready).
- Let an MCP add-on bias speech recognition toward the household's pet names.
- Multiple households and invitations, and reminders spoken by Alexa at home.
- Smart pet feeders and pill boxes that log automatically.

## Built during the hackathon

PetCheck is a new project: the first commit is 2026-09-29, inside the Submission Period that started on
2026-08-31. All code, tests and materials were created during the hackathon.

## Built with

typescript · node.js · model-context-protocol · aws-lambda · amazon-dynamodb · amazon-eventbridge ·
amazon-sns · amazon-polly · aws-iam · oauth2 · web-speech-api · large-language-models
