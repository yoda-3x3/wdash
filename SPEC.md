# wdash — Spec

Remote control for Claude agent teams, usable from a locked-down school computer or a phone.
Browser-only on the client; agents run on the home PC when it's online and on GitHub Actions when it isn't.

Status: draft v1 (2026-10-20). Decisions below came out of the grill session; open items are marked **TBD**.

---

## 1. Goals & non-goals

### Goals
- Use Claude agents from a browser that can reach only `github.com` and `*.vercel.app` (no installs, no claude.ai).
- Chat with an agent live, kick off long jobs, review diffs, answer permission prompts — from desktop or phone.
- Jobs keep running when the home PC is off; results sync back into local checkouts when it comes online.
- A job is a **team**: Opus orchestrator + Sonnet workers that coordinate through a shared board and never edit the same files.
- Run on the user's Claude subscription (not pay-per-token API) and free tiers wherever possible.

### Non-goals (v1)
- Multi-user / sharing. Exactly one allowlisted GitHub account.
- Arbitrary filesystem access. Only allowlisted projects.
- Non-git projects. Every project must be a GitHub repo.
- Wake-on-LAN.

---

## 2. Architecture

```
School / phone browser
        │  HTTPS
        ▼
┌──────────────────────────────┐
│ wdash-web  (Vercel, Next.js) │  GitHub OAuth (allowlist: 1 user)
│  - job board, job view, PWA  │  Web Push (VAPID)
│  - API routes                │  triggers workflow_dispatch
└──────────────┬───────────────┘
               │ REST
               ▼
┌──────────────────────────────┐
│ Relay  (Upstash Redis)       │  jobs, event streams, approvals,
│                              │  board, claims, heartbeats, usage
└──────▲────────────────▲──────┘
       │ TCP (outbound) │ TCP (outbound)
┌──────┴───────┐  ┌─────┴──────────────────────┐
│ Home daemon  │  │ Cloud daemon               │
│ (Windows PC) │  │ (GitHub Actions ubuntu VM) │
│ same code ───┼──┼─ same code, --cloud mode   │
└──────┬───────┘  └─────┬──────────────────────┘
       │                │ git push remote/<job>, checkpoints
       └──── git fetch + merge on wake ◄──┘
```

### Components
| Component | Tech | Responsibility |
|---|---|---|
| `web/` | Next.js (App Router), TypeScript, Tailwind, Auth.js (GitHub) | UI, auth, API routes that read/write the relay, dispatches cloud runs, sends push |
| `daemon/` | Node 20+, TypeScript, `@anthropic-ai/claude-agent-sdk`, `ioredis`, `simple-git` | Runs orchestrator/workers, enforces permissions & file ownership, streams events, checkpoints, sync-on-wake |
| `shared/` | TypeScript package | Relay key names, event/command schemas (zod), shared types |
| `.github/workflows/wdash-run.yml` | Reusable workflow (in the wdash repo) | Boots the daemon in cloud mode for one job |
| Per-project caller workflow | `.github/workflows/wdash.yml` in each project repo | Calls the reusable workflow with `secrets: inherit` so project secrets stay in that repo |

Monorepo: `wdash/` with `web/`, `daemon/`, `shared/` (npm workspaces).

---

## 3. Execution placement

Decision rule when a job is created, or when a job needs a runner:

1. If `daemon:home:heartbeat` is fresh (< 30 s) → run on **home PC**.
2. Otherwise → `workflow_dispatch` the project's `wdash.yml` with `job_id` → run on **cloud**.
3. User can override per job ("Run on: Auto / PC / Cloud") in Advanced.

### Home daemon
- Runs at login as a Windows Scheduled Task (restart on failure).
- Heartbeat every 10 s: `SET daemon:home:heartbeat <ts> EX 30`.
- Projects allowlisted in `daemon/config/projects.json` (name → local path, repo, build/test/screenshot commands).

### Cloud daemon (GitHub Actions)
- Job limit 6 h; one VM per job; orchestrator + all workers are processes on that VM.
- Auth to Claude: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) as a repo secret — subscription, not API billing.
- Relay creds `WDASH_REDIS_URL` as a repo secret.
- Clones project repo, checks out `remote/<job>` if a checkpoint exists, else the base branch.
- Pushes `remote/<job>` on every checkpoint and at the end.

---

## 4. Job model

### Lifecycle
```
draft → planning → awaiting_plan_approval* → running ⇄ waiting_on_user
      → reviewing → merging → done | failed | cancelled | over_budget
(* only for big jobs — see §6.3)
```
Orthogonal field `location: home | cloud | migrating | queued`.

### Job creation (hybrid form)
Visible: **Project** dropdown (required) + **Task** text box + Start.
Collapsed under **Advanced** (with defaults):
| Field | Default |
|---|---|
| Workers | Auto (orchestrator decides, 1–4) |
| Models | Opus orchestrator + Sonnet workers |
| Run on | Auto (PC if online) |
| Budget | per-project default (see §9) |
| Review rounds cap | 3 |

### Team
- **Orchestrator** (Opus): reads the task, explores the repo, writes a plan, assigns file ownership, launches workers, reviews, merges, writes the final report.
- **Workers** (Sonnet): each has its own git worktree on branch `job/<job>/<worker>` and an owned path set.
- Subagents (Explore, Plan, …) spawned by any agent are recorded with `parent_agent_id` → shown as a nested tree.

---

## 5. Relay data model (Upstash Redis)

All keys prefixed `wd:`. Jobs and their sub-keys get a 90-day TTL, refreshed on activity, removed when archived (§10).

| Key | Type | Contents |
|---|---|---|
| `wd:jobs` | ZSET | job_id scored by updated_at |
| `wd:job:<id>` | HASH | project, task, status, location, models, budget, created_at, updated_at, branch, base_sha, last_checkpoint_sha |
| `wd:job:<id>:events` | STREAM | all events (§7), append-only |
| `wd:job:<id>:cmd` | STREAM | commands from UI → daemon (user message, approve, deny, cancel, approve_plan, resolve_merge) |
| `wd:job:<id>:agents` | HASH | agent_id → JSON {role, model, parent_agent_id, status, worktree, session_id} |
| `wd:job:<id>:board` | STREAM | inter-agent messages (§6.2) |
| `wd:job:<id>:claims` | HASH | path/glob → agent_id (file ownership) |
| `wd:job:<id>:approvals` | HASH | request_id → JSON {agent_id, tool, input, status, decided_at} |
| `wd:job:<id>:usage` | HASH | per-agent input/output/cache tokens, est_cost_usd |
| `wd:daemon:home:heartbeat` | STRING (EX 30) | last heartbeat ts |
| `wd:daemon:cloud:<job>:heartbeat` | STRING (EX 30) | cloud runner heartbeat |
| `wd:job:<id>:lease` | STRING (EX 30) | which daemon currently owns the job (`home` / `cloud:<run_id>`) — prevents two runners |
| `wd:push:subs` | SET | Web Push subscriptions |
| `wd:merge_queue` | ZSET | jobs whose `remote/<job>` branches await sync on the home PC |

### Browser transport
Vercel functions are short-lived, so the browser **polls** `GET /api/jobs/<id>/events?after=<stream_id>` every 1.5 s while a job view is open (5 s on the board, paused when the tab is hidden).
Daemons use a persistent TCP connection with `XREAD BLOCK` on `:cmd`.
**Risk:** Upstash free tier command quota — see §13.

---

## 6. Multi-agent coordination

### 6.1 Ownership
- The orchestrator's plan assigns each worker a set of path globs. Written to `:claims`.
- **Hard enforcement** in the daemon's `canUseTool`: `Edit`/`Write`/`NotebookEdit` on a path not owned by that agent → deny with the message "path owned by <agent>; request it via board.request_files".
- Read access is unrestricted inside the project.

### 6.2 Board (custom MCP tools injected into every agent)
| Tool | Who | Effect |
|---|---|---|
| `board.post(to, text)` | all | message another agent or `all` |
| `board.read()` | all | unread messages for this agent |
| `board.request_files(globs, reason)` | worker | ask orchestrator for extra ownership |
| `board.grant_files(agent, globs)` / `deny` | orchestrator | update `:claims` |
| `board.report_done(summary)` | worker | marks task ready for review |
| `board.request_changes(agent, notes)` | orchestrator | sends work back (counts a review round) |
| `board.approve(agent)` | orchestrator | allowed only if required checks passed (§6.4) |
| `team.spawn_worker(name, model, globs, task)` | orchestrator | starts a worker in a new worktree |
| `team.merge(agent)` | orchestrator | merges worker branch into `job/<id>` |

New board messages are injected into a recipient's next turn as a user message, so idle agents get woken up.

### 6.3 Plan gate
- The plan is posted as a `plan` event (tasks, owners, globs, models).
- **3+ workers → `awaiting_plan_approval`**; the user can edit or approve it on the board. ≤ 2 workers → auto-start.

### 6.4 Review loop
1. Worker `report_done` → orchestrator (Opus) reviews the diff of `job/<id>/<worker>` vs. the merge base.
2. Required evidence before `approve` (per-project config; skip what the project doesn't define):
   - build command passes
   - test command passes
   - screenshot for UI projects (headless Chromium via Playwright; attached as an event artifact)
   - Opus diff review
3. Not satisfied → `request_changes`. **Max 3 rounds per worker**; on the 4th the job → `waiting_on_user` with the review history.
4. After all workers merge → **final review** of `job/<id>` as a whole (same evidence), then push/merge.

---

## 7. Event protocol

Every event: `{ id, ts, job_id, agent_id, parent_agent_id?, type, payload }`, validated with zod in `shared/`.

| type | payload |
|---|---|
| `message` | role (assistant/user), text (streamed deltas coalesced ~250 ms) |
| `tool_call` | tool, input (truncated), call_id |
| `tool_result` | call_id, ok, output (truncated, full output on request) |
| `permission_request` | request_id, tool, input, reason |
| `permission_decision` | request_id, allow, by (user/policy) |
| `attention` | reason, title, body, actions[], ref (request_id / agent_id) — see §11.1 |
| `attention_cleared` | attention_id |
| `plan` | tasks[], owners, globs |
| `board` | from, to, text |
| `review` | worker, round, verdict, notes, checks{build,test,screenshot} |
| `artifact` | kind (screenshot/log/diff), url or inline |
| `diff` | branch, files[], unified diff (chunked) |
| `status` | job/agent status change, location change |
| `usage` | agent, tokens in/out/cache, est_cost_usd |
| `checkpoint` | sha, branch, session_ids |
| `error` | message, fatal |

Commands (`:cmd`): `user_message`, `approve`, `deny`, `approve_plan`, `edit_plan`, `cancel`, `pause`, `resume`, `raise_budget`, `resolve_merge`.

---

## 8. Permissions policy

Implemented in `canUseTool` in the daemon (never trusted to the client):

| Tool | Policy |
|---|---|
| Read, Glob, Grep, LS | auto-allow inside the project/worktree |
| Edit, Write, NotebookEdit | auto-allow **if** the path is inside the agent's worktree **and** owned by the agent |
| Bash: commands matching the project's configured `build`/`test`/`screenshot` | auto-allow |
| Bash: anything else | **ask user** → `permission_request` + push notification |
| `git push`, network tools (WebFetch, WebSearch, curl…) | **ask user** |
| Anything touching paths outside the project | deny |

Pending approvals block only the requesting agent; other agents keep working.

---

## 9. Usage tracking & kill switch

- Each SDK `result` message's token usage is recorded into `:usage` per agent and emitted as a `usage` event.
- UI: per-job and per-agent token bars; a "today / this week" rollup on the board.
- **Budget** is set per job in **tokens** (UI also shows an estimated $ equivalent).
  The subscription's real remaining limit isn't exposed to us, so a percentage of the limit can only be estimated (**TBD**: calibrate after the pilot).
- At 80 % of budget → notification. At 100 % → job `over_budget`: all agents are interrupted after their current tool call, a checkpoint is taken, and the user can `raise_budget` or cancel.
- Global kill switch on the board: pause all jobs.

---

## 10. Sync, checkpoints, migration

### Checkpoints
After every agent turn (and at least every 5 min while running):
1. Commit WIP in each worktree (`wdash: checkpoint <n>`), merge nothing.
2. Push `job/<id>/*` branches and `remote/<job>`.
3. Upload each agent's SDK session transcript (`.jsonl`) to the relay, or to a `wdash-state` branch if it's large, so another machine can `resume`.
4. Emit a `checkpoint` event.

### Auto-migrate (home → cloud)
- The home daemon holds `wd:job:<id>:lease`. If the lease expires (PC asleep/off/offline > 30 s), the web app (on the next poll, or from a Vercel cron every minute) dispatches the cloud workflow.
- The cloud daemon takes the lease, checks out the last checkpoint, restores transcripts, and resumes each agent with `resume: <session_id>`.
- Work after the last checkpoint is lost; agents are told "resumed from checkpoint <sha>".
- **Risk:** transcripts embed Windows paths; the cloud side rewrites cwd paths when restoring (**spike in M4**).

### Sync on wake (cloud → home)
On daemon start and every 5 min:
1. `git fetch` each allowlisted project; collect `remote/*` branches for finished jobs in `wd:merge_queue`.
2. Local checkout clean and the merge is clean → fast-forward/merge, then mark synced.
3. Dirty tree or conflict → leave untouched, emit a `needs_merge` card + push notification; the user resolves it in the UI (merge / discard / leave as branch).

---

## 11. UI

### Screens
1. **Job board (home)** — cards: project, task title, status chip (running / waiting on you / done / failed / over budget), location badge (PC / Cloud / Migrating), last activity, token bar. Top: PC online indicator, global pause, New job.
2. **New job** — hybrid form (§4).
3. **Job view** — tabs:
   - **Timeline**: chat + tool calls, nested tree per agent/subagent (collapsible), inline permission cards (Allow / Deny / Allow for this job).
   - **Team**: agents, roles, models, owned globs, review rounds, board messages.
   - **Diff**: per-worker and combined diffs, file tree, checks status, screenshots.
   - **Usage**.
   - Chat input at the bottom (sends `user_message` to the orchestrator, or to a selected agent).
4. **Wall** (`/wall`): every agent across every live job (plus jobs finished in the last 15 min) as a terminal-style tile streaming its output: messages, `$ shell` and `● tool` calls, failures in red, checks, plan, board messages, checkpoints, with subagent lines marked `[Explore]`. A tile with an open stop glows amber and carries that stop's buttons inline (Allow / Deny / Retry …; text replies link to the job). It has a project filter, hide-finished, S/M/L tile sizes and fullscreen, and is one column on phones. It's fed by `GET /api/wall?c=<cursors>`: one poll every 2 s returns new events for all live jobs, with a 150-event backfill on first load.
5. **Inbox badge** — count of things waiting on you (approvals, plan gates, merges).
6. **Settings** — projects (read-only mirror of daemon config), push subscription, default budgets.

### Mobile / PWA
- Responsive, installable (manifest + service worker).
- Web Push for every actionable stop (§11.1).

### 11.1 Stop notifications (rule)
**Whenever any agent — or the job as a whole — stops for any reason and the user can do something about it, wdash notifies them.**
Each notification is a push + an inbox item with the action buttons inline. It's emitted as an `attention` event, so nothing is missed if push fails.

| Stop reason | User can… |
|---|---|
| Permission request (tool needs approval) | Allow / Deny / Allow for job |
| Plan awaiting approval (3+ workers) | Approve / Edit / Cancel |
| Review cap reached (3 rounds, Opus still unsatisfied) | Accept anyway / Give guidance / Cancel worker |
| Agent asked the user a question / ended its turn waiting for input | Reply |
| Budget 80 % warning, 100 % stop | Raise budget / Cancel |
| Usage/rate limit hit (subscription limit, 429/overloaded) | Retry now / Resume later / Cancel |
| Agent error or crash (SDK error, max turns, process died) | Retry agent / Resume job / Cancel |
| Build/test check failing repeatedly | Give guidance / Accept / Cancel |
| Agent stalled (no events for 10 min while "running") | Nudge / Restart agent / Cancel |
| PC went offline mid-job → migrating | Info + Cancel migration / Keep waiting for PC |
| Cloud run failed to start (dispatch error, Actions minutes exhausted) | Retry / Run on PC when online / Cancel |
| Merge conflict on wake / dirty local tree | Merge / Leave as branch / Discard |
| Job finished | Review diff / Merge / Archive |
| Job failed | Retry / Resume from checkpoint / Archive |

Not notified: stops with nothing to do (a worker finishing its own task while the job continues, a user-initiated cancel, normal checkpoints).
De-dupe: at most one push per (job, reason) per 2 min; the inbox always has the latest state.

---

## 12. Security

- Auth.js GitHub provider; `signIn` callback rejects any GitHub login not in `ALLOWED_GITHUB_LOGIN` (comma-separated; every listed account has full control). All API routes check the session; no anonymous endpoints except push service-worker assets.
- The relay token lives only in Vercel env, the home daemon, and repo secrets — never sent to the browser.
- The daemon treats every relay command as untrusted input: zod-validated, and it can only act on allowlisted projects with the §8 policy. The worst case from a compromised web login is bounded by that policy (shell still needs approval, but that approval also comes through the web — so web auth is the real boundary).
- The workflow dispatch token is a fine-grained PAT (Actions: write) scoped to allowlisted repos only. Repos owned by another account use that account's own PAT (`GITHUB_TOKEN_FOR_<OWNER>`).
- Secrets for project builds live in each project repo's Actions secrets; the daemon never logs env vars, and tool output is scrubbed of known secret values before being emitted.
- CSRF: same-site cookies + origin check on mutating routes.

---

## 13. Free-tier budget & limits

| Service | Free limit (verify at setup) | Our usage |
|---|---|---|
| Vercel Hobby | function time limits, cron | UI + short API routes + 1/min cron |
| Upstash Redis free | daily/monthly command cap, ~256 MB | polling is the main cost → adaptive intervals, pause when the tab is hidden, batch reads |
| GitHub Actions | 2,000 min/mo private (unlimited public) | ~33 h cloud runtime/month; the test repo can be public |
| Claude subscription | shared with interactive use | Opus review loops are the biggest drain → budgets + round cap |

If Upstash polling gets too expensive → switch the browser transport to Supabase Realtime or Ably (free tiers with websockets) behind the same `shared/` interface.

---

## 14. Retention

- Jobs and all sub-keys: 90-day TTL from last activity.
- **Archive** button: exports events + transcripts as gzipped JSONL to a `wdash-archive` branch of the wdash repo (or Vercel Blob, **TBD**), then deletes the Redis keys. Archived jobs stay viewable read-only by loading from the archive.

---

## 15. Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 | Setup | wdash repo, Vercel project, Upstash DB, GitHub OAuth app, public throwaway repo `wdash-sandbox`, `claude setup-token` stored |
| M1 | Single agent, home PC, end-to-end | From the school browser: create a job on wdash-sandbox → one Sonnet agent runs on the PC → timeline streams → a Bash permission prompt can be approved from the browser |
| M2 | Board + diffs + PWA | Job board, diff tab, install to phone, push notifications for permission/finished |
| M3 | Cloud runner | PC off → job runs on Actions with the same UX → pushes `remote/<job>` → PC wakes → clean auto-merge; conflict → needs_merge card |
| M4 | Checkpoint + auto-migrate | Kill the PC mid-job → cloud resumes from the last checkpoint with the same session |
| M5 | Orchestrator + workers | Opus plans, assigns globs, spawns 2–3 Sonnet workers in worktrees; ownership enforced; board messaging; plan gate for 3+ |
| M6 | Review loop + checks | Build/test/screenshot evidence, 3-round cap, final combined review |
| M7 | Usage, budgets, retention | Token tracking, 80 %/100 % budget behavior, global pause, 90-day TTL, archive |

---

## 16. Risks

1. **School acceptable-use policy** — routing around a block may break it; the user's call. `*.vercel.app` may get blocked later → a custom domain is the mitigation.
2. **Subscription usage limits** are shared with interactive use; there's no API for remaining quota.
3. **Session resume across OSes** (Windows → Linux paths in transcripts) — unproven; spike early in M4.
4. **Upstash free-tier command quota** under polling.
5. **Actions minutes** on private repos.
6. **Web login = remote code execution boundary.** Keep the allowlist + permission policy strict.

---

## 17. Open items (TBD)
- Calibrate token budget ↔ "% of subscription limit".
- Archive destination: git branch vs. Vercel Blob.
- Exact Upstash/Vercel free-tier numbers at setup time.

---

## 18. Implementation notes (v1 build, 2026-10-20)

Where the code differs from or settles the draft above:

- **Branches**: `wdash/<job>/main` (job branch, also what syncs to the PC) and `wdash/<job>/<worker>`. A separate `remote/<job>` was dropped, and `job/<id>` plus `job/<id>/<w>` can't coexist as git refs.
- **Transcripts** are mirrored by the Agent SDK's `sessionStore` straight into Redis (`wd:sess:*`), with the key pinned per agent so it doesn't depend on the cwd. Cloud resume is `resume: <sessionId>`, with no file copying or path rewriting (resolves risk 3).
- **Budget** (resolves the §9 TBD) is in **API-equivalent $** from the SDK's cumulative `total_cost_usd` per agent. Live **subscription utilization** comes from SDK `rate_limit_event`s, shown on the board; a `rejected` status pauses the job with a `usage_limit` stop.
- **Archive destination** (resolves the §14 TBD): gzipped JSON at `archive/<job>.json.gz` on a `wdash-archive` branch of the wdash repo, via the GitHub contents API.
- **Failover detection** (`web/lib/placement.ts#reconcile`) runs on board polls (throttled to every 20 s) and from an external cron hitting `/api/cron/reconcile`, because Vercel Hobby crons are daily.
- **Command cursor**: the daemon records the last handled command id in `job.cmdCursor`, so commands sent while a runner is starting, or across a migration, are neither lost nor replayed.
- **Permissions**: agents run with `settingSources: []` so user or project allow-rules can't bypass the wdash policy; the project's CLAUDE.md is appended to the system prompt instead. Read-only `git status/diff/log/show…` and `ls/cat/head…` are auto-allowed alongside the configured build/test/screenshot commands. The orchestrator never edits files.
- **Idle workers**: a worker that ends its turn without `board_report_done` gets one automatic nudge, then the orchestrator is told. "Waiting for your reply" fires when the orchestrator is idle and no worker or approval is in flight.
- **Lease loss**: a runner that loses its lease stops its agents without writing their status, so it can't clobber the runner that took over.
- Monorepo uses **npm workspaces**.
