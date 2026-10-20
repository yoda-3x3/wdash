import { SignIn } from "@/components/SignIn";

export default async function Page({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return <SignIn error={error} />;
}
