#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runCloud } from "./cloud.js";
import { env, loadLocalProjects } from "./config.js";
import { enableCloud, setupCloud } from "./enableCloud.js";
import { runHome } from "./home.js";
import { ensureKaggleFor, liveKaggleServers, stopKaggleServers } from "./kaggle.js";
import { Relay } from "./relay.js";

const USAGE = `wdash daemon

  wdash-daemon home                          run on the home PC (picks up jobs, syncs finished work)
  wdash-daemon cloud --job <id> --repo <dir> run one job (GitHub Actions)
  wdash-daemon check                         validate config and relay connectivity
  wdash-daemon setup-cloud                   set the wdash repo's secrets so any project can run in the cloud
  wdash-daemon enable-cloud <project>...     (older per-project setup; not needed after setup-cloud)
  wdash-daemon kaggle up [model]             start (or reuse) a Kaggle GPU server for a model (default: first of KAGGLE_MODELS)
  wdash-daemon kaggle status                 list the running Kaggle servers
  wdash-daemon kaggle down [slot]            stop all Kaggle servers, or one
`;

async function kaggle(sub: string | undefined, arg: string | undefined): Promise<number> {
  const relay = new Relay();
  try {
    if (sub === "up") {
      const s = await ensureKaggleFor(relay, arg, (t) => console.log(t), arg ? [arg] : undefined);
      console.log(`ready: server ${s.slot} ${s.url} (${s.models.join(", ")})`);
    } else if (sub === "status") {
      const live = await liveKaggleServers(relay);
      for (const s of live) console.log(`server ${s.slot}: ${s.url} (${s.models.join(", ")}) up ${Math.round((Date.now() - s.startedAt) / 60_000)} min`);
      if (!live.length) console.log("no Kaggle servers running");
    } else if (sub === "down") {
      const stopped = await stopKaggleServers(relay, arg ? Number(arg) : undefined);
      console.log(stopped.length ? `stopped server ${stopped.join(", ")}` : "no running server");
    } else {
      console.error(USAGE);
      return 2;
    }
    return 0;
  } finally {
    await relay.close();
  }
}

async function check(): Promise<number> {
  const e = env();
  const projects = loadLocalProjects();
  console.log(`state dir: ${e.WDASH_STATE_DIR}`);
  console.log(`projects:  ${projects.map((p) => `${p.name} (${p.repo}) -> ${p.localPath ?? "no localPath"}`).join("\n           ") || "none"}`);
  console.log(`push:      ${e.VAPID_PUBLIC_KEY ? "configured" : "NOT configured (no phone notifications from the daemon)"}`);
  const relay = new Relay();
  try {
    const pong = await relay.r.ping();
    console.log(`relay:     ${pong}`);
    return 0;
  } catch (err) {
    console.error(`relay:     FAILED ${(err as Error).message}`);
    return 1;
  } finally {
    await relay.close();
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "home") return runHome();
  if (cmd === "check") process.exit(await check());
  if (cmd === "kaggle") process.exit(await kaggle(rest[0], rest[1]));
  if (cmd === "setup-cloud") {
    for (const line of await setupCloud()) console.log(line);
    process.exit(0);
  }
  if (cmd === "enable-cloud") {
    if (!rest.length) {
      console.error(USAGE);
      process.exit(2);
    }
    const relay = new Relay();
    let failed = 0;
    for (const name of rest) {
      try {
        for (const line of await enableCloud(name, relay)) console.log(line);
      } catch (err) {
        failed++;
        console.error(`${name}: ${(err as Error).message}`);
      }
    }
    await relay.close();
    process.exit(failed ? 1 : 0);
  }
  if (cmd === "cloud") {
    const { values } = parseArgs({ args: rest, options: { job: { type: "string" }, repo: { type: "string" } } });
    if (!values.job || !values.repo) {
      console.error(USAGE);
      process.exit(2);
    }
    process.exit(await runCloud(values.job, values.repo));
  }
  console.log(USAGE);
  process.exit(cmd ? 2 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
