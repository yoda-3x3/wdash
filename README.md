# wdash

Remote control for Claude agent teams. Start, watch, and steer jobs from any browser (school computer, phone), with no installs on the client.
Jobs run on your home PC when it's online and on GitHub Actions when it isn't. Finished work merges back into your PC's checkout when it comes online.

See [SPEC.md](SPEC.md) for the design.

```
browser ──► web/ (Next.js on Vercel, GitHub login) ──► Upstash Redis ◄── daemon/ on your PC
                                                         ▲
                                                         └── daemon/ on a GitHub Actions runner (PC offline)
```

| Folder | What |
|---|---|
| `shared/` | Redis key layout, zod schemas, the "stop notification" catalog |
| `daemon/` | Agent runner: orchestrator + workers (Claude Agent SDK), permissions, board, checks, checkpoints, sync |
| `web/` | Dashboard, API routes, PWA + push, PC-offline failover |
| `.github/workflows/wdash-run.yml` | Reusable workflow that runs one job in the cloud |
| `templates/project-wdash.yml` | Caller workflow you copy into each project repo |
| `templates/project-wdash-standalone.yml` | Same, for project repos owned by a different GitHub account |

---

## Setup (milestone 0)

You need: Node 22+, git, a GitHub account, and a Claude subscription.

### 1. Accounts (all free tiers)
1. **Upstash Redis**: create a database. You'll need both the **REST URL + token** (for Vercel) and the **TCP connection string** `rediss://default:<token>@<host>:6379` (for the daemon and Actions).
2. **GitHub OAuth app** (Settings → Developer settings → OAuth Apps): callback URL `https://<your-app>.vercel.app/api/auth/callback/github`.
3. **Fine-grained GitHub token** for dispatching cloud runs and archiving: give it access to your project repos and the wdash repo, with *Actions: read/write* and *Contents: read/write*.
4. **VAPID keys** for push: `npx web-push generate-vapid-keys`.
5. **Claude token** for cloud runs: run `claude setup-token` on your PC (it uses your subscription).

### 2. Push this repo to GitHub
Make the wdash repo **public** (it contains no secrets) so project repos can call its reusable workflow. If you keep it private, enable *Settings → Actions → Access → "Accessible from repositories owned by you"* and add a `WDASH_REPO_TOKEN` secret to each project repo.

### 3. Deploy the web app to Vercel
Import the repo, set **Root Directory = `web`**, and add the variables from [`web/.env.example`](web/.env.example).
Only the accounts in `ALLOWED_GITHUB_LOGIN` can sign in. It's a comma-separated list (e.g. `me,me-school`), and every listed account gets full control.

**Failover cron:** Vercel Hobby crons run only daily, so point a free external scheduler (Upstash QStash schedule or cron-job.org) at
`https://<your-app>.vercel.app/api/cron/reconcile` every 1–2 minutes with header `Authorization: Bearer <CRON_SECRET>`.
This is what moves a job to the cloud when your PC dies while nobody has the dashboard open.

### 4. Home PC daemon
```bash
npm install
npm run build -w shared
npm run build -w daemon
cp daemon/.env.example daemon/.env
cp daemon/config/projects.example.json daemon/config/projects.json
```
Fill in `daemon/.env` and list your projects in `daemon/config/projects.json`. **Only listed projects can be touched.** `commands.build` / `test` / `screenshot` are the checks the orchestrator must pass before approving work. They're also the only shell commands agents can run without asking you.

The daemon runs agents on your subscription via the `claude setup-token` token that the setup script writes to `daemon/.env` (no separate `/login` needed).

Check everything, then install it as a startup task:
```bash
node daemon/dist/main.js check
```
```bash
powershell -ExecutionPolicy Bypass -File scripts/install-windows-task.ps1
```
Keep the PC awake while plugged in (`powercfg /change standby-timeout-ac 0`).

### 5. Cloud runs (per project)
1. Copy [`templates/project-wdash.yml`](templates/project-wdash.yml) to `<project>/.github/workflows/wdash.yml` on its base branch and replace `OWNER/wdash`.
2. In the project repo's *Settings → Secrets → Actions* add:
   `CLAUDE_CODE_OAUTH_TOKEN`, `WDASH_REDIS_URL` (TCP string), and optionally `WDASH_VAPID_PUBLIC_KEY`, `WDASH_VAPID_PRIVATE_KEY`, `WDASH_WEB_URL`, plus any secrets your build needs.
3. Set `"cloud": true` for it in `projects.json`. Projects with `"cloud": false` only ever run on the PC.

#### Projects owned by another GitHub account
A repo owned by a different account or org than the wdash repo (e.g. `my-school/robot`) works too, with three differences:
- **Token:** fine-grained tokens only cover one account's repos. Signed in as that account, create a token with *Actions + Contents read/write* on its repos. `scripts/setup.mjs --vercel` asks for it and stores it on Vercel as `GITHUB_TOKEN_FOR_<OWNER>` (e.g. `GITHUB_TOKEN_FOR_MY_SCHOOL`). Repos without their own token use `GITHUB_DISPATCH_TOKEN`.
- **Workflow:** GitHub won't let another account's repo call a private reusable workflow, so copy [`templates/project-wdash-standalone.yml`](templates/project-wdash-standalone.yml) instead. Its `WDASH_REPO_TOKEN` secret (set by setup) lets it check out wdash.
- **Secrets and pushes:** setting the repo's Actions secrets needs admin on it, so `gh` must be signed in as that account (`gh auth login` / `gh auth switch`) when you run setup. On the PC, the daemon pushes with your normal git credentials, so git needs push access to that repo too.

### 6. Phone
Open the site, then **Settings → Enable notifications**. On iPhone, add it to the Home Screen first and open it from there.

---

## How a job runs
1. **New job**: pick a project and type the task. *Advanced* has workers, models, where to run, budget, and review cap.
2. The **orchestrator** (Opus by default) explores the repo and submits a plan that splits the work across workers, each owning non-overlapping file globs. Plans with 3+ workers wait for your approval.
3. **Workers** (Sonnet by default) each get their own git worktree. Editing a file you don't own is blocked; workers request files through the board.
4. When a worker reports done, the checks run and the orchestrator reviews the diff, approving it or sending it back (up to the review cap, then it asks you). Approved work merges into `wdash/<job>/main`.
5. After a final combined review and checks, the orchestrator finishes with a report. At home the branch merges into your checkout if that's clean; otherwise you get a "needs merge" card. Cloud jobs merge when the PC comes back.
6. **Checkpoints**: after every turn and every 5 minutes, all job branches are pushed and transcripts are mirrored to Redis. If the PC disappears, a cloud runner resumes the same sessions from the last checkpoint.

**The wall** (`/wall`) shows every live agent across all jobs as a streaming terminal tile. Tiles that need you glow amber with their buttons inline. Use fullscreen on a spare monitor.

**Every stop you can act on notifies you** (SPEC.md §11.1): permission prompts, questions, plan approval, review cap, waiting for your reply, budget 80%/100%, usage limits, errors, failing checks, stalls, PC offline, cloud start failures, merge conflicts, finished, and failed.

## Development
```bash
npm test
npm run typecheck
npm run dev -w web
```
`npm test` covers the permission policy and the git layer (worktrees, checkpoints, merges, sync-on-wake, cloud-style resume).
