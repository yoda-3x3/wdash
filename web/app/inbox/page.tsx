import { Shell } from "@/components/Shell";
import { Inbox } from "@/components/Inbox";
import { requirePageUser } from "@/lib/page-auth";

export default async function Page() {
  await requirePageUser();
  return (
    <Shell>
      <Inbox />
    </Shell>
  );
}
