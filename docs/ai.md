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
on your server; devices still have to opt in individually.

> **Cost warning.** Server-mode AI calls are **not rate-limited**: every
> signed-in account spends the operator's key at will. With registration closed
> (the selfhost default) that means "trusted household members" — fine. Never
> combine an operator key with **open registration** (`ALLOW_SIGNUPS=1` left
> on, or `DEPLOYMENT=cloud`) on an internet-facing instance: anyone who signs
> up can run up an unmetered OpenAI bill. On shared instances, prefer BYOK.
