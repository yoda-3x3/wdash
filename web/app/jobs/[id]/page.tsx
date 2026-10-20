import { Suspense } from "react";
import { Shell } from "@/components/Shell";
import { JobView } from "@/components/JobView";
import { requirePageUser } from "@/lib/page-auth";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requirePageUser();
  const { id } = await params;
  return (
    <Shell>
      <Suspense>
        <JobView id={id} />
      </Suspense>
    </Shell>
  );
}
