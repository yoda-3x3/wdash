import { Shell } from "@/components/Shell";
import { Home } from "@/components/Home";
import { requirePageUser } from "@/lib/page-auth";

export default async function Page() {
  await requirePageUser();
  return (
    <Shell wide>
      <Home />
    </Shell>
  );
}
