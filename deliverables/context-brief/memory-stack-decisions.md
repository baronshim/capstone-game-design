---
name: stack-decisions
description: "Tech and hosting decisions for the capstone game; bots run on Workers AI, no API key"
metadata: 
  node_type: memory
  type: project
  originSessionId: 20dfa039-15d5-416b-a0de-ee57cb74b29b
  modified: 2026-09-04T18:35:02.009Z
---

Decided 2026-09-04: TypeScript end to end. Cloudflare Worker + one Durable Object per room (SQLite-backed, free plan) over WebSockets; static client bundled by esbuild to `public/app.js`; vitest for `src/game`; Node 24 smoke script. Local via `wrangler dev --ip 0.0.0.0`, deploy free to `*.workers.dev`.

Bots (DECIDED 2026-09-09, spec updated): Cloudflare Workers AI via `env.AI` binding, no API key anywhere. Default model Gemma 4 26B (`BOT_MODEL` env var), JSON schema output, max_tokens 80. `BOT_MODE=fake|live|scripted` (default fake) selects a `BotBackend` implementation in `src/worker/backends/`; live falls back to scripted per action on failure, validation failure, or daily-quota exhaustion. Spec section 5.7 defines server-side output validation and the secret-word leak filter as the prompt-injection guard. Claude stays a possible later swap (one file + a Worker secret) but is NOT the plan; the user has no Anthropic key and does not need one.

Budget math (verified 2026-09-09 on developers.cloudflare.com): 10k neurons/day on Workers Free, hard stop, no card. Gemma 4 26B is 9,091 in / 27,273 out neurons per M tokens, ~15 neurons per bot call, ~650 calls or 20-30 rounds/day. Qwen3 30B is cheaper but a thinking model. Llama 3.3 70B ~48 neurons/call, too tight. Frontier models (Kimi, GLM) need prepaid credits. LoRA on Workers AI noted in spec as a post-m4 stretch goal.

**Why:** User wanted "whatever is easiest," free hosting so classmates can join from phones, and asked whether their Claude account key could be used. Their subscription OAuth token must not be used as an app credential.

**How to apply:** Do not propose other stacks. Do not assume or propose Claude for bots; the M3 plan should target Workers AI per spec sections 3, 5.6, 5.7. Verify the exact Workers AI catalog id for Gemma 4 26B at M3 implementation time. See [[project-status]].
