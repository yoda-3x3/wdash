import { z } from "zod";

// SPEC.md §11.1: whenever an agent or job stops and the user can act on it, raise an Attention.

export const AttentionReason = z.enum([
  "permission",
  "plan_approval",
  "review_cap",
  "question",
  "waiting_for_input",
  "budget_warning",
  "over_budget",
  "usage_limit",
  "agent_error",
  "checks_failing",
  "stalled",
  "pc_offline",
  "cloud_dispatch_failed",
  "needs_merge",
  "job_finished",
  "job_failed",
]);
export type AttentionReason = z.infer<typeof AttentionReason>;

/** An action button. `cmd` is posted to the job's command stream; `href` navigates. */
export const AttentionAction = z.object({
  label: z.string(),
  cmd: z.record(z.string(), z.unknown()).optional(),
  /** Web-side actions that don't go through the daemon. */
  webAction: z.enum(["merge", "leave_branch", "discard", "retry_dispatch", "run_home", "archive", "cancel_migration"]).optional(),
  href: z.string().optional(),
  /** Needs a text box (reply / guidance / nudge). */
  needsText: z.boolean().optional(),
  style: z.enum(["primary", "danger", "default"]).default("default"),
});
export type AttentionAction = z.infer<typeof AttentionAction>;

export const Attention = z.object({
  id: z.string(),
  jobId: z.string(),
  agentId: z.string().optional(),
  reason: AttentionReason,
  title: z.string(),
  body: z.string(),
  actions: z.array(AttentionAction),
  createdAt: z.number(),
  /** e.g. approval request id; used to clear when resolved. */
  ref: z.string().optional(),
});
export type Attention = z.infer<typeof Attention>;

/** Reasons that are informational follow-ups, not blocking (shown in inbox but lower priority). */
export const NON_BLOCKING: AttentionReason[] = ["budget_warning", "pc_offline", "job_finished"];

/** Stable id so re-raising the same stop replaces rather than duplicates. */
export function attentionId(jobId: string, reason: AttentionReason, ref?: string): string {
  return `${jobId}:${reason}${ref ? `:${ref}` : ""}`;
}

type Ctx = { jobId: string; agentId?: string; agentName?: string; ref?: string; detail?: string };

/** Default title/body/actions per reason. Callers may override body. */
export function buildAttention(reason: AttentionReason, ctx: Ctx): Omit<Attention, "createdAt"> {
  const who = ctx.agentName ?? ctx.agentId ?? "The job";
  const a = ctx.agentId;
  const base = { id: attentionId(ctx.jobId, reason, ctx.ref ?? a), jobId: ctx.jobId, agentId: a, reason, ref: ctx.ref };
  const d = ctx.detail ?? "";
  const job = `/jobs/${ctx.jobId}`;
  switch (reason) {
    case "permission":
      return {
        ...base,
        title: `${who} needs permission`,
        body: d,
        actions: [
          { label: "Allow", cmd: { type: "decide", requestId: ctx.ref, allow: true, scope: "once" }, style: "primary" },
          { label: "Allow for job", cmd: { type: "decide", requestId: ctx.ref, allow: true, scope: "job" }, style: "default" },
          { label: "Deny", cmd: { type: "decide", requestId: ctx.ref, allow: false }, style: "danger" },
        ],
      };
    case "question":
      return {
        ...base,
        title: `${who} has a question`,
        body: d,
        actions: [{ label: "Answer", href: job, style: "primary" }],
      };
    case "plan_approval":
      return {
        ...base,
        title: "Plan needs approval",
        body: d,
        actions: [
          { label: "Approve", cmd: { type: "approve_plan" }, style: "primary" },
          { label: "Edit", href: `${job}?tab=team`, style: "default" },
          { label: "Cancel job", cmd: { type: "cancel" }, style: "danger" },
        ],
      };
    case "review_cap":
      return {
        ...base,
        title: `Review cap reached for ${who}`,
        body: d,
        actions: [
          { label: "Accept anyway", cmd: { type: "accept_review", agentId: a }, style: "primary" },
          { label: "Give guidance", cmd: { type: "guidance", agentId: a }, needsText: true, style: "default" },
          { label: "Cancel job", cmd: { type: "cancel" }, style: "danger" },
        ],
      };
    case "waiting_for_input":
      return {
        ...base,
        title: `${who} is waiting for your reply`,
        body: d,
        actions: [{ label: "Reply", cmd: { type: "user_message", agentId: a }, needsText: true, style: "primary" }],
      };
    case "budget_warning":
      return {
        ...base,
        title: "Job at 80% of budget",
        body: d,
        actions: [
          { label: "Raise budget", cmd: { type: "raise_budget" }, needsText: true, style: "default" },
          { label: "Cancel job", cmd: { type: "cancel" }, style: "danger" },
        ],
      };
    case "over_budget":
      return {
        ...base,
        title: "Job stopped: budget reached",
        body: d,
        actions: [
          { label: "Raise budget", cmd: { type: "raise_budget" }, needsText: true, style: "primary" },
          { label: "Cancel job", cmd: { type: "cancel" }, style: "danger" },
        ],
      };
    case "usage_limit":
      return {
        ...base,
        title: "Claude usage limit hit",
        body: d,
        actions: [
          { label: "Retry now", cmd: { type: "resume" }, style: "primary" },
          { label: "Cancel job", cmd: { type: "cancel" }, style: "danger" },
        ],
      };
    case "agent_error":
      return {
        ...base,
        title: `${who} stopped with an error`,
        body: d,
        actions: [
          { label: "Retry agent", cmd: { type: "retry_agent", agentId: a }, style: "primary" },
          { label: "Cancel job", cmd: { type: "cancel" }, style: "danger" },
        ],
      };
    case "checks_failing":
      return {
        ...base,
        title: `Checks keep failing for ${who}`,
        body: d,
        actions: [
          { label: "Give guidance", cmd: { type: "guidance", agentId: a }, needsText: true, style: "primary" },
          { label: "Accept anyway", cmd: { type: "accept_review", agentId: a }, style: "default" },
          { label: "Cancel job", cmd: { type: "cancel" }, style: "danger" },
        ],
      };
    case "stalled":
      return {
        ...base,
        title: `${who} seems stalled`,
        body: d,
        actions: [
          { label: "Nudge", cmd: { type: "nudge", agentId: a }, style: "primary" },
          { label: "Restart agent", cmd: { type: "retry_agent", agentId: a }, style: "default" },
          { label: "Cancel job", cmd: { type: "cancel" }, style: "danger" },
        ],
      };
    case "pc_offline":
      return {
        ...base,
        title: "PC went offline — moving job to the cloud",
        body: d,
        actions: [
          { label: "Keep waiting for PC", webAction: "cancel_migration", style: "default" },
          { label: "Cancel job", cmd: { type: "cancel" }, style: "danger" },
        ],
      };
    case "cloud_dispatch_failed":
      return {
        ...base,
        title: "Cloud run failed to start",
        body: d,
        actions: [
          { label: "Retry", webAction: "retry_dispatch", style: "primary" },
          { label: "Run on PC when online", webAction: "run_home", style: "default" },
          { label: "Cancel job", cmd: { type: "cancel" }, style: "danger" },
        ],
      };
    case "needs_merge":
      return {
        ...base,
        title: "Changes need a manual merge",
        body: d,
        actions: [
          { label: "Review diff", href: `${job}?tab=diff`, style: "primary" },
          { label: "Leave as branch", webAction: "leave_branch", style: "default" },
          { label: "Discard", webAction: "discard", style: "danger" },
        ],
      };
    case "job_finished":
      return {
        ...base,
        title: "Job finished",
        body: d,
        actions: [
          { label: "Review diff", href: `${job}?tab=diff`, style: "primary" },
          { label: "Archive", webAction: "archive", style: "default" },
        ],
      };
    case "job_failed":
      return {
        ...base,
        title: "Job failed",
        body: d,
        actions: [
          { label: "Resume from checkpoint", cmd: { type: "resume" }, style: "primary" },
          { label: "Archive", webAction: "archive", style: "default" },
        ],
      };
  }
}
