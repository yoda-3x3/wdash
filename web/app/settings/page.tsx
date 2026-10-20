import { Shell } from "@/components/Shell";
import { Settings } from "@/components/Settings";
import { requirePageUser } from "@/lib/page-auth";

export default async function Page() {
  const login = await requirePageUser();
  return (
    <Shell>
      <Settings login={login} vapidKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ""} />
    </Shell>
  );
}
