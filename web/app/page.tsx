import { Shell } from "@/components/Shell";
import { Board } from "@/components/Board";
import { requirePageUser } from "@/lib/page-auth";

export default async function Page() {
  await requirePageUser();
  return (
    <Shell>
      <Board />
    </Shell>
  );
}
