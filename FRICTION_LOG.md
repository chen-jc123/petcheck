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

<!-- Add new entries above this line, newest at the bottom. Focus on Amazon tooling:
     Alexa+ MCP Toolkit & QuickStart, Alexa developer console, AWS (Lambda, DynamoDB,
     EventBridge, Bedrock), Kiro, and the MCP SDK / Inspector. -->
