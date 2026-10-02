# PetCheck — Friction Log

A running log of friction encountered while building PetCheck for the Amazon Alexa+ track.
Entries are written at the moment the friction happens, not reconstructed afterward.

**Severity scale**
- **Blocker** — could not continue without outside help or a major workaround
- **High** — lost 30+ minutes or had to change approach
- **Medium** — confusing or slow, but figured it out
- **Low** — minor annoyance or docs polish

---

## Template

```
## FL-XXX — <short title>
- **Date:** YYYY-MM-DD
- **Tool / API / SDK:** <e.g. Alexa+ MCP Toolkit, MCP TypeScript SDK, AWS Lambda>
- **What I was trying to do:**
- **Steps taken:**
  1.
  2.
- **Expected result:**
- **Actual result:** (paste exact error text)
- **Severity:** Blocker / High / Medium / Low
- **Workaround:** (what got me unstuck, or "none yet")
- **Suggested improvement:** (one concrete, actionable change)
```

---

## FL-001 — Cloning a private repo over HTTPS says "Repository not found" instead of asking to sign in

- **Date:** 2026-09-29
- **Tool / API / SDK:** git (HTTPS) + GitHub, macOS Terminal
- **What I was trying to do:** Clone my newly created private `petcheck` repo to my Mac to start the project.
- **Steps taken:**
  1. Created a private repo `chen-jc123/petcheck` on GitHub.
  2. In Terminal, ran `git clone https://github.com/chen-jc123/petcheck`.
- **Expected result:** A sign-in prompt, or an error saying I lacked permission or wasn't authenticated.
- **Actual result:**
  ```
  remote: Repository not found.
  fatal: repository 'https://github.com/chen-jc123/petcheck/' not found
  ```
  The URL was correct. The message made me think I had mistyped the username or repo name.
- **Severity:** Medium
- **Workaround:** Used the "Set up in Desktop" button on the repo page and cloned with GitHub Desktop, which handles sign-in.
- **Suggested improvement:** When an unauthenticated HTTPS request hits a private repo, git/GitHub should add a hint such as "If this repository is private, make sure you are signed in (e.g. `gh auth login`)" rather than only "not found".

---

## FL-002 — MCP Inspector sent an optional boolean as `true` without making it obvious

- **Date:** 2026-09-29
- **Tool / API / SDK:** MCP Inspector (web UI), testing PetCheck MCP server over Streamable HTTP
- **What I was trying to do:** Test the duplicate check in `log_care`: logging the same pet + activity twice within 30 minutes should return `needs_confirmation` unless `confirm` is true.
- **Steps taken:**
  1. Ran `log_care` with `pet: Mochi`, `activity: feed`, `by: Dad` → logged.
  2. Changed `by` to `Emma` and ran it again, expecting the duplicate warning.
- **Expected result:** `"status": "needs_confirmation"`, "Dad already fed Mochi… Do you want me to log it again?"
- **Actual result:** `"status": "logged"`. The feeding was logged again. Calling the server directly with curl (without `confirm`) returned `needs_confirmation`, which showed the server was correct and Inspector had sent `confirm: true`.
- **Severity:** Medium (looked like a bug in my server; took ~15 min to rule out)
- **Workaround:** Explicitly cleared/unchecked the `confirm` field before running, then the duplicate check worked.
- **Suggested improvement:** For optional boolean parameters, Inspector should show three clear states (not sent / true / false) and display the exact JSON arguments it will send before "Run Tool".

---

## FL-003 — Unclear how to add a local Streamable HTTP server in MCP Inspector

- **Date:** 2026-09-29
- **Tool / API / SDK:** MCP Inspector (web UI)
- **What I was trying to do:** Connect Inspector to my local PetCheck server at `http://localhost:3000/mcp`.
- **Steps taken:**
  1. Ran `npm run dev` (server running) and `npx @modelcontextprotocol/inspector`.
  2. Inspector opened on a "Servers" page listing only built-in example servers (filesystem, everything, example-server), all disconnected.
- **Expected result:** An obvious "connect to URL" field for a local server.
- **Actual result:** Had to find the right option under "Add Servers" (or edit an example server's URL) and pick the Streamable HTTP transport myself. Not obvious on first use.
- **Severity:** Low
- **Workaround:** Added a server manually with transport Streamable HTTP and URL `http://localhost:3000/mcp`, then toggled it on.
- **Suggested improvement:** Show a "Connect to a server URL" box at the top of the Servers page, prefilled with `http://localhost:3000/mcp`, and auto-detect the transport.

---

## FL-004 — AWS sign-up: unclear "Complete your account setup" page, then Free plan ineligibility surfaced late

- **Date:** 2026-09-30
- **Tool / API / SDK:** AWS account sign-up and AWS Management Console (Free plan / paid plan)
- **What I was trying to do:** Create an AWS account for PetCheck and start setting up IAM and the CLI.
- **Steps taken:**
  1. Signed up for a new AWS account; the console home showed the Free plan with credits.
  2. Navigated from the console and landed on a "Complete your account setup" page ("either not finished registering, or your account is currently on free plan").
  3. Clicked "Complete your AWS registration" and was then told "You are not eligible for the free plan" because my information matched a previously registered account, and that I would be moved to a paid plan without the $200 credit.
- **Expected result:** Either a clear statement of which setup step was incomplete, or the Free plan eligibility decision shown up front during sign-up (before the console showed a Free plan with credits).
- **Actual result:** The first page didn't say *which* of the two cases applied. Eligibility was only revealed after sign-up appeared complete, which forced a billing decision mid-setup.
- **Severity:** Medium (no technical block, but a surprise billing decision and ~15 min of confusion)
- **Workaround:** Accepted the paid plan, created a $5 monthly budget alert before creating any resources, and kept all services within always-free limits.
- **Suggested improvement:** Check Free plan eligibility during sign-up and show the result before the account is created; on the "Complete your account setup" page, show a per-item checklist status (e.g. "Payment verified ✓ / Support plan ✗") instead of listing every possible cause.

---

## FL-005 — MCP SDK's Node Streamable HTTP transport fails behind serverless-http on AWS Lambda

- **Date:** 2026-09-30
- **Tool / API / SDK:** `@modelcontextprotocol/sdk` 1.31 (`StreamableHTTPServerTransport`), `serverless-http` 3.2, AWS Lambda (Node.js 22, Function URL)
- **What I was trying to do:** Deploy the PetCheck MCP server (Express app, stateless Streamable HTTP) to AWS Lambda behind a Function URL.
- **Steps taken:**
  1. Wrapped the working Express app with `serverless-http` and deployed it to Lambda with a Function URL.
  2. Called `GET /health` and `POST /mcp` (`tools/list`) against the Function URL.
- **Expected result:** Both endpoints work, as they do locally.
- **Actual result:** `/health` (plain Express) worked, but `POST /mcp` returned no tool list. The SDK's Node transport internally converts Node `req`/`res` to Web Requests via `@hono/node-server`, which doesn't work with `serverless-http`'s emulated request/response objects. Nothing in the SDK docs warns about this.
- **Severity:** High (the core MCP endpoint didn't work on Lambda; ~30 min to diagnose)
- **Workaround:** In the Lambda handler, skipped Express and used the SDK's `WebStandardStreamableHTTPServerTransport`: converted the Function URL event into a standard `Request`, called `transport.handleRequest(request, { parsedBody })`, and mapped the returned `Response` back to the Lambda result (with `enableJsonResponse: true`). Added a test that calls the handler with fake Function URL events.
- **Suggested improvement:** Document a "Deploying to AWS Lambda" recipe for the MCP TypeScript SDK that uses the web-standard transport, and note that the Node transport requires a real Node HTTP server (not serverless adapters). An official Lambda example in the Alexa+ MCP Toolkit docs would help, since Lambda is the natural host for Alexa+ add-ons.

---

## FL-006 — New account blocked from Amazon Bedrock ("verify you are a corporate customer"), discovered only at the first API call

- **Date:** 2026-10-01
- **Tool / API / SDK:** Amazon Bedrock Runtime (Converse API, `us.amazon.nova-lite-v1:0`, us-east-1), AWS Support Center
- **What I was trying to do:** Power the simulated Alexa+ page with Bedrock: the model picks PetCheck tools, which are then called through the MCP server.
- **Steps taken:**
  1. Added `bedrock:InvokeModel` permissions to the Lambda role and deployed.
  2. Sent "I fed Mochi" from the simulated Alexa+ page.
  3. Opened AWS Support → "How can we help?" assistant, pasted the error; it replied "unable to offer a recommendation".
  4. Created a case: Account and billing → Account Activation → Bedrock Allowlisting.
- **Expected result:** An AWS account with valid IAM permissions can call a first-party Amazon model (Nova), or the console warns up front that Bedrock needs extra verification for this account.
- **Actual result:**
  ```
  ValidationException: To access Amazon Bedrock, you must provide further information so we can verify you are
  a corporate customer and that we can grant you access given applicable law and internal policy.
  ```
  Nothing in IAM, the Bedrock console or the account setup flow indicated this restriction beforehand. The exception type (`ValidationException`) suggests a malformed request rather than an account-level block. The Support assistant couldn't route the issue; I had to find the "Bedrock Allowlisting" category manually.
- **Severity:** High (blocks the LLM part of the project; wait time for approval during a 3-week hackathon)
- **Workaround:** Built a fallback: the assistant tries Bedrock and, on this specific access error, switches to a rule-based intent engine that still calls the MCP server, so the demo works. It retries Bedrock every 10 minutes and switches back automatically once access is granted. Submitted the allowlisting case.
- **Suggested improvement:** (1) Show Bedrock eligibility status on the Bedrock console home page for new accounts, with a one-click request; (2) return a distinct error such as `AccountNotVerifiedException` instead of `ValidationException`; (3) let the Support assistant recognize this exact error message and pre-fill the Bedrock Allowlisting case.

---

## FL-007 — Browser speech recognition turns pet names into common words ("Mochi" → "Monkey")

- **Date:** 2026-10-01
- **Tool / API / SDK:** Web Speech API (`webkitSpeechRecognition`) in the simulated Alexa+ page
- **What I was trying to do:** Log "I fed Mochi" by voice.
- **Steps taken:** Pressed the mic and said "I fed Mochi" several times.
- **Expected result:** The transcript contains "Mochi".
- **Actual result:** Transcripts came back as "I fed Monkey" and "I fed Machi". There's no way to give the recognizer a list of expected names (the `SpeechGrammarList` API is not supported in practice).
- **Severity:** Medium (wrong or failed logs in a voice-first product)
- **Workaround:** Server-side fuzzy name matching (edit distance ≤ 2, prefix match, and "the cat"/"the dog" → the household's only cat/dog), so "Machi"/"Mochie"/"mocha" resolve to Mochi; anything further off gets "I don't know a pet called Monkey. I know Mochi and Biscuit." instead of a wrong log.
- **Suggested improvement:** For Alexa+ MCP add-ons: let a server declare custom vocabulary or entity values (e.g. pet names from the household's data) so Alexa's speech recognition is biased toward them, similar to custom slot values in classic Alexa skills.

---

## FL-008 — Alexa+ MCP Toolkit setup: AccessDenied assuming Amazon's developer-tools role, with no documented way to get access

- **Date:** 2026-10-01
- **Tool / API / SDK:** Alexa+ MCP Toolkit setup ("Set Up Your Development Environment"), AWS STS, `alexa-ai` CLI installation
- **What I was trying to do:** Install the `alexa-ai` CLI to connect the PetCheck MCP server (already live on Lambda with OAuth 2.1) to real Alexa+.
- **Steps taken:**
  1. Completed the Amazon developer registration (developer.amazon.com).
  2. Followed the docs: created profile `alexa-ai-user`, then `alexa-ai` with `role_arn arn:aws:iam::372468808636:role/AddOn3PDeveloperToolsRead`, `region us-west-2`.
  3. Ran `aws sts get-caller-identity --profile alexa-ai`.
  4. Following the troubleshooting page, explicitly attached an inline policy allowing `sts:AssumeRole` on that exact role ARN (the user already had AdministratorAccess) and retried.
- **Expected result:** The role is assumed, so CodeArtifact login and `npm install -g @alexa-ai/cli` can proceed.
- **Actual result:**
  ```
  An error occurred (AccessDenied) when calling the AssumeRole operation: User: arn:aws:iam::<my-account>:user/petcheck-dev
  is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::372468808636:role/AddOn3PDeveloperToolsRead
  ```
  Because my side grants the permission, the denial must come from the role's trust policy on Amazon's account, i.e. my AWS account isn't trusted/enabled. The setup docs never mention that an account must be enabled or how to request it, and the troubleshooting page only says to check the user's own policy, which doesn't help here.
- **Severity:** High (blocks installing the CLI, so no way to deploy an MCP add-on to real Alexa+)
- **Workaround:** Asked in the hackathon Discord. **Resolution (2026-10-01):** Amazon's Chief Alexa Evangelist replied that "the addon developer tools are in private preview and are not available to hackathon participants." The project therefore uses the officially allowed simulated Alexa+ web experience, which calls the same deployed MCP server; OAuth 2.1 account linking and listing materials are ready for when access opens.
- **Suggested improvement:** (1) State "private preview: invitation only" at the top of the setup page (and in hackathon materials, so participants don't spend time on it), with a request form; (2) let `alexa-ai` be installed from public npm and check entitlement at `alexa-ai configure` with a clear "your account isn't enabled yet, request access here" message; (3) add this exact AccessDenied message to the troubleshooting page.

---

<!-- Add new entries above this line, newest at the bottom. Focus on Amazon tooling:
     Alexa+ MCP Toolkit & QuickStart, Alexa developer console, AWS (Lambda, DynamoDB,
     EventBridge, Bedrock), Kiro, and the MCP SDK / Inspector. -->
