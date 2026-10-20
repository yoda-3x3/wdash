#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runCloud } from "./cloud.js";
import { env, loadLocalProjects } from "./config.js";
import { runHome } from "./home.js";
import { Relay } from "./relay.js";

const USAGE = `wdash daemon

  wdash-daemon home                          run on the home PC (picks up jobs, syncs finished work)
  wdash-daemon cloud --job <id> --repo <dir> run one job (GitHub Actions)
  wdash-daemon check                         validate config and relay connectivity
`;

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
