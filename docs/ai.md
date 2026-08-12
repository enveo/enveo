# AI features

AI is **off by default** (zero egress), gated behind an explicit in-app
consent. Every device chooses its own mode in Settings.

## What works without AI

With AI off, the **budget assistant** still distributes "To Be Budgeted"
**rule-based, with zero dependencies** — no key, no network. **Screenshot
import** is LLM-only: it needs a real model to read the picture, so there is no
rule-based fallback for it. With AI off, import asks you to enable AI first —
manual entry (pad + calculator) is untouched.

## The three modes

| Mode | Where requests go | Whose key |
|---|---|---|
| **Off** (default) | nowhere — local rules only | — |
| **BYOK** | the device talks to OpenAI directly | the user's, stored on their device |
| **Server** | the app server proxies to OpenAI | the operator's (`OPENAI_API_KEY` in `.env`) |

Server and BYOK build **identical requests from the same shared code** — the
prompts live in one place (`packages/shared/src/aiPrompts.ts`) and the model
answers in the UI language.

## Server mode setup

Set `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`) in `.env` — the key stays
on your server; devices still have to opt in individually. The default model
is `gpt-5.6-luna`.

> **Cost warning (selfhost).** On a selfhost deployment, server-mode AI calls
> are **not limited by Enveo**: every signed-in account spends the operator's
> key at will. With registration closed (the selfhost default) that means
> "trusted household members" — fine. Never combine an operator key with
> `ALLOW_SIGNUPS=1` on an internet-facing selfhost instance: anyone who signs
> up can run up an unmetered OpenAI bill. On shared instances, prefer BYOK.

## The cloud per-user AI budget

On `DEPLOYMENT=cloud` (open registration) each account gets an independent,
**approximate USD 5.00 allowance per UTC calendar month** for server-mode AI,
enforced against the operator's key:

- A request is admitted whenever the **already-recorded** spend is below the
  threshold; the actual cost (from OpenAI's returned token usage, priced by a
  server-side registry) is added **after** a successful answer. A request that
  starts under the limit is allowed to finish even if it crosses it, and two
  concurrent requests may both be admitted — modest overshoot is accepted by
  design. User comfort wins over strict accounting.
- When the allowance is used up, operator-key AI routes answer
  `429 {"error":"ai_budget_exhausted","retryAfterSeconds":<int>}` with a
  matching `Retry-After` header (seconds until the next UTC month). Budget
  suggestions fall back to local rules; an import already past its first cycle
  returns the raw extracted items. BYOK is never limited.
- Accounting is **fail-open**: a counter failure never blocks or degrades an
  AI answer. Failed/timed-out calls, malformed usage and unknown models are
  never charged. Recorded spend is never revealed to the client.
- There is **no instance-wide cap**: aggregate operator cost management (e.g.
  an OpenAI-side budget) is the operator's own responsibility, outside Enveo.

A cloud boot also requires the configured `OPENAI_MODEL` to have a registered
price entry, and `AI_SAFETY_IDENTIFIER_SECRET` (optional; a dedicated secret,
never `BETTER_AUTH_SECRET`) enables a privacy-preserving `safety_identifier`
on operator calls — a keyed hash, never the raw user id or email.
