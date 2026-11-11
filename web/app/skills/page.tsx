import { Shell } from "@/components/Shell";
import { SkillsPage } from "@/components/Skills";
import { requirePageUser } from "@/lib/page-auth";

export default async function Page() {
  await requirePageUser();
  return (
    <Shell>
      <SkillsPage />
    </Shell>
  );
}
