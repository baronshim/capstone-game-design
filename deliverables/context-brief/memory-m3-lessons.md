---
name: m3-execution-state
description: M3 (bots) finished and deployed 2026-09-16 — hard-won lessons for running M4 and for the deployed Worker
metadata: 
  node_type: memory
  type: project
  originSessionId: a344bb82-6b77-432f-bf7e-f86eb8998d0d
  modified: 2026-09-16T04:16:11.416Z
---

M3 finished 2026-09-16: merged to main (2363ce3), tagged `m3`, deployed live at https://imposter-turing.baronshim.workers.dev, worktree and branch removed. Nothing to resume.

Lessons worth keeping:
- **Gemma 4 on Workers AI defaults thinking mode ON.** Without `chat_template_kwargs: { enable_thinking: false }` in the `env.AI.run` request, it spends the whole `max_tokens` budget on `reasoning_content`, returns `message.content: ""` with `finish_reason: "length"`, and every bot call falls back to scripted. The fix is in `src/worker/backends/workersAi.ts` and the spec 5.6 note is corrected. Any new Workers AI model in M4 must be checked the same way with the RAWAI-logging trick (temporarily `console.log(JSON.stringify(res))` in the backend and read one live round via `wrangler tail` or local dev:live).
- **The response body is `choices[0].message.content` (OpenAI-shaped), not `res.response`,** for this Gemma build via `env.AI.run`. `parseAiResponse` handles both, but the model returns the chat-completion shape.
- **`env.AI` is remote-only.** The vitest pool cannot start with the binding declared, so it lives ONLY in `wrangler.jsonc`'s `env.production`; top level and `env.test` have no AI binding. `npm run dev` (fake bots) needs no login; `npm run dev:live` and `deploy` use `--env production` and need `wrangler login`.
- **A fresh Cloudflare account needs a workers.dev subdomain registered once** (dashboard: Workers > Subdomain) before `dev:live` or a resolvable deploy URL. Deploy again after registering so the route attaches.
- **Real Cloudflare alarms are exact; local `wrangler dev` alarms are NOT.** Local dev fired phase alarms minutes late with "SQLite alarm overdue / AlarmManager mismatch" under load; the deployed Worker fired chat->vote at 89.9s, vote->botcall and botcall->reveal at 20.0s. Do NOT chase alarm timing in local dev — verify it on the deploy with the alarm-only probe pattern (1 human + 5 bots, human never acts, measure phase-transition wall-clock). Keep the per-dispatch `setAlarm` re-arm (the M2 pattern); a "dedupe to setAlarm only when changed" made local dev worse and was reverted.
- **Review-model split held again:** sonnet task reviews + one opus whole-branch review. The opus final review caught nothing critical here; the real defects (Gemma thinking, the alarm red herring) surfaced only from the live deploy, which no review or unit test could reach.
- **In a worktree-isolated Bash session, compound/`$(...)`/for-loop git commands are refused;** run one plain command per call. To merge at the end, ExitWorktree (keep), merge on the main checkout, then `git worktree remove --force` (the git-ignored `.superpowers` scratch makes plain remove refuse; force is correct once the branch is merged).

**Why:** These cost real time this run; M4 adds another Workers AI action (bots answering menu questions) and will hit the same model/deploy surface.

**How to apply:** Reuse the fake/live backend split, the alarm-only deploy probe, and the thinking-mode flag. See [[project-status]] and [[stack-decisions]].
