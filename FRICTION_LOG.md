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

<!-- Add new entries above this line, newest at the bottom. Focus on Amazon tooling:
     Alexa+ MCP Toolkit & QuickStart, Alexa developer console, AWS (Lambda, DynamoDB,
     EventBridge, Bedrock), Kiro, and the MCP SDK / Inspector. -->
