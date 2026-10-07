---
name: m2-execution-state
description: M2 is finished (merged and tagged m2 on 2026-09-15); what the run taught about running SDD milestones on this repo
metadata:
  type: project
---

M2 finished 2026-09-15: 9 tasks + 1 fix wave, merged fast-forward to main at a3c6b56, tagged `m2`, worktree and branch deleted. Nothing to resume.

Lessons for M3's run:
- Task reviews on sonnet were reliable; the final whole-branch review on opus found 4 real Important issues the task reviews missed (clue-word error code as a word oracle, uncancelled reconnect timer, untested DO parsing layer, alarm re-arm). Keep the final review on the most capable model.
- The controller's end-to-end browser check found a cross-task defect no unit test could (error message wiped by the next state broadcast). Pattern that works, no puppeteer needed: launch `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --remote-debugging-port=9222 --user-data-dir=<scratch>`, connect Node 24's WebSocket to `/json/version`'s debugger URL, `Target.createBrowserContext` per player, `Target.attachToTarget {flatten:true}`, `Runtime.evaluate` with `returnByValue`. Poll `#phase` text; use `form.requestSubmit()`. One run in five died with the DevTools socket closing mid-wait (Chrome hiccup, not the app); add ws.onclose logging and just re-run.
- Run `wrangler dev` with Bash run_in_background and poll with curl; kill with `pkill -f "wrangler dev"` before finishing.
- A worktree nested under the main checkout makes vitest in the main checkout glob both trees (doubled test count) until the worktree is removed.
- Subagent commit trailers follow the harness reminder of the session that runs them, not the plan text; don't fight it.
- Rulings made during M2 (all accepted by the final reviewer): imposter's clue skips the secret-word check; alarm handler trusts delivery (no Date.now guard) so tests can fire phases early; error text clears on the next send(), not on state arrival.

**Why:** The user wants milestone runs to be fast and hands-off.

**How to apply:** Reuse the browser-check pattern and the review-model split for M3. See [[project-status]].
