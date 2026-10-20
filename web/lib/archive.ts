import { K } from "@wdash/shared";
import { clearAllForJob } from "./attention";
import { writeArchive } from "./github";
import { redis, xrange } from "./redis";
import { deleteJobData, getEvents, getJobDetail, updateJob } from "./relay";

/** Export a job to the wdash-archive branch, then drop its bulky Redis keys (SPEC.md §14). */
export async function archiveJob(id: string): Promise<void> {
  const detail = await getJobDetail(id);
  if (!detail.job) throw new Error("not found");
  const events = [];
  let cursor = "-";
  for (;;) {
    const page = await getEvents(id, cursor, 1000);
    if (!page.length) break;
    events.push(...page);
    cursor = page.at(-1)!.id!;
  }
  const board = await xrange(K.board(id), "-", "+");
  await writeArchive(id, { version: 1, archivedAt: Date.now(), ...detail, events, board });
  await deleteJobData(id);
  await clearAllForJob(id);
  await updateJob(id, { archived: true });
  // Keep the small job hash forever-ish so the board can list it; drop the TTL refresh.
  await redis().persist(K.job(id));
}
