import { Shell } from "@/components/Shell";
import { NewProject } from "@/components/NewProject";
import { requirePageUser } from "@/lib/page-auth";

export default async function Page() {
  await requirePageUser();
  return (
    <Shell>
      <NewProject />
    </Shell>
  );
}
