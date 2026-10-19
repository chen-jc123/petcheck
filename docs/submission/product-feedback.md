# PetCheck: product feedback (draft)

> Draft for the Devpost "Product feedback" field, built from [FRICTION_LOG.md](../../FRICTION_LOG.md) and the
> code. The rules ask, for each tool, API or SDK: what we used it for, what worked, what needs work, how
> onboarding went, and whether we'd build with it again. **The team must review every answer and change it
> to match their own experience** (especially the "again?" answers, which are opinions).

## Tools, APIs and SDKs we used

| Tool / API / SDK | What we used it for |
|---|---|
| MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.31) | The PetCheck MCP server (6 tools, Streamable HTTP, stateless) and the MCP client inside the simulated Alexa+ |
| MCP Inspector (web UI and CLI) | Testing tools during development; `npm run check:mcp` protocol check |
| Alexa+ MCP Toolkit docs and `alexa-ai` CLI setup | Designing the add-on: transport, OAuth 2.1, listing limits; CLI install was blocked (private preview) |
| AWS Lambda (Function URL, Node.js 22, arm64) | Hosts the MCP endpoint, household API, pages and OAuth endpoints |
| Amazon DynamoDB | Single-table storage for pets, care logs, notes, vet visits and alerts |
| Amazon EventBridge Scheduler | Runs the missed-task check every 5 minutes |
| Amazon SNS | Emails the owner when a task is an hour late, and the day before a vet visit |
| AWS IAM | Least-privilege roles for Lambda and the scheduler |
| Amazon Bedrock (Converse API, Nova Lite) | Built in as a model engine; our account is still waiting for access |
| Amazon Polly (generative voice) | Narration for the demo video |
| Web Speech API (browser) | Speech in and out on the simulated Alexa+ page |
| An OpenAI-compatible model API (Qwen via Alibaba Cloud Model Studio) | The language model in the demo while Bedrock access is pending |

## AWS Builder: which AWS services and how

PetCheck runs entirely on AWS. One Lambda function behind a Function URL serves the MCP endpoint
(SDK web-standard Streamable HTTP transport), the household API, the pages and the OAuth 2.1 endpoints.
Each request loads the household from DynamoDB with one Query and batch-writes only new records, so the
server is stateless. EventBridge Scheduler invokes the same function every 5 minutes with
`{"petcheck": "check-missed"}`; alerts are stored in DynamoDB once, and owner alerts and vet reminders are
published to an SNS topic that emails the owner. IAM roles allow only the `petcheck` table, the alert topic
and Bedrock invoke. `npm run deploy` creates or updates all of it. Bedrock (Converse with tool use) is wired
in as a model engine, and Polly generated the video narration.

---

## MCP TypeScript SDK

- **What worked well:** `registerTool` with zod schemas, tool annotations and `structuredContent` made the
  tools easy to define and test. The web-standard `WebStandardStreamableHTTPServerTransport` mapped cleanly
  onto Lambda events, and the same SDK's client transport let our simulated Alexa+ talk to the server
  exactly as a real client would.
- **What needs work:** the Node `StreamableHTTPServerTransport` silently fails behind `serverless-http` on
  Lambda; nothing in the docs warns about it, and it took about 30 minutes to diagnose (FL-005). A "deploy to
  AWS Lambda" recipe using the web-standard transport would save people the detour.
- **Onboarding:** fast. The skeleton with all 6 tools was working the first evening.
- **Again?** Yes: one server works for Alexa+ and any other MCP client.

## MCP Inspector

- **What worked well:** seeing raw requests and responses made the duplicate check and errors easy to
  debug; the CLI mode is scriptable, which became our `npm run check:mcp`.
- **What needs work:** optional booleans were sent as `true` without it being obvious, which looked like a
  bug in our server (FL-002); connecting to a local Streamable HTTP server isn't obvious on first launch
  (FL-003).
- **Onboarding:** a few minutes once we found "Add server".
- **Again?** Yes.

## Alexa+ MCP Toolkit and `alexa-ai` CLI

- **What worked well:** the docs are clear about what an add-on needs (Streamable HTTP, OAuth 2.1 grants
  and scopes, token lifetimes, listing character limits), so we could build all of it ahead of access.
- **What needs work:** setup fails with `AccessDenied` assuming Amazon's developer-tools role, and the docs
  never say an account must be enabled; we learned on Discord that the tools are private preview and not
  available to hackathon participants (FL-008).
- **Onboarding:** blocked at the CLI install step, so we used the officially allowed simulated Alexa+.
- **Again?** Yes, as soon as access opens; the OAuth endpoints and listing are ready.

## AWS Lambda

- **What worked well:** a Function URL gives HTTPS without API Gateway; warm tool calls take roughly
  100–200 ms; one function serves every route plus the scheduled check.
- **What needs work:** see the MCP SDK transport issue above (FL-005). Account sign-up was confusing: Free
  plan ineligibility only appeared after sign-up seemed complete (FL-004).
- **Onboarding:** after the account issue, quick with the AWS CLI.
- **Again?** Yes.

## Amazon DynamoDB

- **What worked well:** a single table with one Query per request fits a stateless MCP server, and it stays
  in the free tier.
- **What needs work:** <!-- team: anything you hit? Otherwise say nothing blocked you. -->
- **Onboarding:** quick.
- **Again?** Yes.

## Amazon EventBridge Scheduler and IAM

- **What worked well:** a `rate(5 minutes)` schedule with a JSON payload invoking Lambda directly, no
  extra glue.
- **What needs work:** right after creating the roles, both `lambda create-function` and
  `scheduler create-schedule` fail until IAM propagates ("cannot be assumed"), so our deploy script retries
  every 10 seconds. A "role not propagated yet, retry" hint in the error, or a waiter, would help.
- **Onboarding:** straightforward.
- **Again?** Yes.

## Amazon SNS

- **What worked well:** email delivery for owner alerts with a few lines of code.
- **What needs work:** the subscriber must click a confirmation email before anything arrives, which is
  easy to miss when testing.
- **Again?** Yes.

## Amazon Bedrock

- **What worked well:** the Converse API's tool-use format is clean, and our tool loop is built around it.
- **What needs work:** our new account got `ValidationException: … verify you are a corporate customer` at
  the first call, with no warning in the console, and the support assistant couldn't route it (FL-006). A
  distinct error type and an eligibility status on the Bedrock console home page would help.
- **Onboarding:** blocked so far; we submitted the allowlisting case.
- **Again?** Yes, once access is granted; switching back is one setting.

## Amazon Polly

- **What worked well:** the generative voices sound natural enough to narrate the video.
- **What needs work:** not every voice supports the generative engine in every region, so our script falls
  back to neural.
- **Again?** Yes.

## Web Speech API

- **What needs work:** pet names come back as common words ("Mochi" → "Monkey", FL-007), and there's no
  way to bias recognition toward expected names.

---

## Feature requests (optional field)

| Request | Why it matters to PetCheck | Priority |
|---|---|---|
| Let an Alexa+ MCP add-on declare custom vocabulary (e.g. the household's pet names) to bias speech recognition | Wrong names mean wrong or failed logs in a voice-first product (FL-007) | Important |
| Public access, or a clear request form, for the Alexa+ add-on developer tools, with an entitlement check in the CLI | We couldn't test on real Alexa+ at all (FL-008) | Critical |
| Show Bedrock eligibility on the console home page and return a distinct error for unverified accounts | We lost the LLM path for the whole hackathon without warning (FL-006) | Important |
| An official "MCP server on AWS Lambda" example in the Alexa+ toolkit docs | Lambda is the natural host for add-ons, and the obvious setup doesn't work (FL-005) | Nice-to-have |
