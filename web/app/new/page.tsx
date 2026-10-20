import { Shell } from "@/components/Shell";
import { NewJob } from "@/components/NewJob";
import { requirePageUser } from "@/lib/page-auth";

export default async function Page() {
  await requirePageUser();
  return (
    <Shell>
      <NewJob />
    </Shell>
  );
}
