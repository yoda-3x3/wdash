import { Shell } from "@/components/Shell";
import { SettingsTabs } from "@/components/Settings";
import { WorkerCache } from "@/components/WorkerCache";
import { requirePageUser } from "@/lib/page-auth";

export default async function Page() {
  await requirePageUser();
  return (
    <Shell>
      <div className="mx-auto max-w-2xl space-y-4">
        <SettingsTabs active="cache" />
        <WorkerCache />
      </div>
    </Shell>
  );
}
