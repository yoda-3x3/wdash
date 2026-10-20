import { Shell } from "@/components/Shell";
import { Wall } from "@/components/Wall";
import { requirePageUser } from "@/lib/page-auth";

export default async function Page() {
  await requirePageUser();
  return (
    <Shell wide>
      <Wall />
    </Shell>
  );
}
