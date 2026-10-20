import { redirect } from "next/navigation";
import { currentLogin } from "./auth";

/** Server components: bounce to /signin unless signed in as the allowed user. */
export async function requirePageUser(): Promise<string> {
  const login = await currentLogin().catch(() => null);
  if (!login) redirect("/signin");
  return login;
}
