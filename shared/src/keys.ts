// Redis key layout shared by the web app and the daemon. See SPEC.md §5.

export const TTL_SECONDS = 90 * 24 * 60 * 60;
/** Big attachments take a lot of Redis space (a 90 MB file is ~120 MB as base64), so their pieces are kept 3 days. */
export const FILE_CHUNK_TTL_SECONDS = 3 * 24 * 60 * 60;
export const HEARTBEAT_TTL_SECONDS = 30;
/** The home daemon beats once a minute (every request counts against Upstash's monthly limit); "PC offline" after 2.5 min. */
export const HOME_HEARTBEAT_TTL_SECONDS = 150;
export const LEASE_TTL_SECONDS = 30;

export const K = {
  jobs: "wd:jobs", // ZSET job_id -> updated_at
  job: (id: string) => `wd:job:${id}`, // HASH (JobRecord fields, JSON-encoded values)
  events: (id: string) => `wd:job:${id}:events`, // STREAM
  cmd: (id: string) => `wd:job:${id}:cmd`, // STREAM
  agents: (id: string) => `wd:job:${id}:agents`, // HASH agent_id -> AgentRecord JSON
  board: (id: string) => `wd:job:${id}:board`, // STREAM
  claims: (id: string) => `wd:job:${id}:claims`, // HASH glob -> agent_id
  approvals: (id: string) => `wd:job:${id}:approvals`, // HASH request_id -> Approval JSON
  allowRules: (id: string) => `wd:job:${id}:allow`, // SET of "Tool:prefix" rules allowed for the job
  usage: (id: string) => `wd:job:${id}:usage`, // HASH agent_id -> Usage JSON
  files: (id: string) => `wd:job:${id}:files`, // HASH file_id -> Attachment JSON
  fileData: (id: string) => `wd:job:${id}:filedata`, // HASH file_id -> base64 contents
  upload: (fileId: string) => `wd:upload:${fileId}`, // STRING EX 1 day: { meta, data } for a file picked before its job exists
  fileChunk: (fileId: string, n: number) => `wd:filechunk:${fileId}:${n}`, // STRING: base64 of one UPLOAD_CHUNK_BYTES piece
  lease: (id: string) => `wd:job:${id}:lease`, // STRING EX 30 -> "home" | "cloud:<run>"
  sessions: (projectKey: string, sessionId: string, subpath?: string) =>
    `wd:sess:${projectKey}:${sessionId}${subpath ? `:${subpath}` : ""}`, // LIST of transcript entries
  sessionIndex: (projectKey: string) => `wd:sessidx:${projectKey}`, // ZSET sessionId -> mtime
  sessionSubkeys: (projectKey: string, sessionId: string) => `wd:sesssub:${projectKey}:${sessionId}`, // SET
  homeQueue: "wd:queue:home", // LIST of job ids for the home daemon
  projectQueue: "wd:queue:projects", // LIST of ProjectRequest ids for the home daemon
  pingQueue: "wd:queue:ping", // LIST of ping ids for the home daemon
  pong: (id: string) => `wd:pong:${id}`, // STRING EX 60: the daemon's reply JSON
  kaggleServers: "wd:kaggle:servers", // HASH slot -> running Kaggle model server JSON (daemon/src/kaggle.ts)
  kaggleSessions: "wd:kaggle:sessions", // ZSET KaggleSession JSON -> end ts (finished servers, 14 days)
  quotaSent: (id: string) => `wd:quota:sent:${id}`, // STRING EX 8d: a quota warning level already sent for that period
  kaggleQueue: "wd:queue:kaggle", // LIST of KaggleControl JSON from the website's Start/Stop buttons
  kaggleLog: "wd:kaggle:log", // LIST of recent server start/stop messages for the website (newest first, 30)
  projectRequest: (id: string) => `wd:projreq:${id}`, // STRING EX 1 day: ProjectRequest JSON
  homeHeartbeat: "wd:daemon:home:heartbeat",
  cloudHeartbeat: (id: string) => `wd:daemon:cloud:${id}:heartbeat`,
  projects: "wd:projects", // HASH name -> ProjectConfig JSON (published by home daemon)
  mergeQueue: "wd:merge_queue", // ZSET job_id -> ts (finished jobs awaiting sync into the home checkout)
  attention: "wd:attention", // HASH attention_id -> Attention JSON (open items only)
  pushSubs: "wd:push:subs", // HASH endpoint -> PushSubscription JSON
  pushDedupe: (jobId: string, reason: string) => `wd:pushdd:${jobId}:${reason}`, // STRING EX 120
  paused: "wd:paused", // STRING "1" when the global kill switch is on
  rateLimit: "wd:ratelimit", // HASH rateLimitType -> RateLimitInfo JSON
} as const;

/** Every key that belongs to one job (for TTL refresh and deletion on archive). */
export function jobKeys(id: string): string[] {
  return [
    K.job(id),
    K.events(id),
    K.cmd(id),
    K.agents(id),
    K.board(id),
    K.claims(id),
    K.approvals(id),
    K.allowRules(id),
    K.usage(id),
    K.files(id),
    K.fileData(id),
  ];
}

export const branchFor = {
  main: (jobId: string) => `wdash/${jobId}/main`,
  worker: (jobId: string, agentId: string) => `wdash/${jobId}/${agentId}`,
};

export function sessionProjectKey(jobId: string, agentId: string): string {
  return `wdash-${jobId}-${agentId}`;
}
