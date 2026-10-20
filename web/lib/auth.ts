import { getServerSession, type AuthOptions } from "next-auth";
import GitHubProvider from "next-auth/providers/github";
import { NextResponse } from "next/server";

// SPEC.md §12 — only the GitHub accounts listed in ALLOWED_GITHUB_LOGIN (comma separated) may sign in.

function allowedLogins(): Set<string> {
  const v = (process.env.ALLOWED_GITHUB_LOGIN ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!v.length) throw new Error("ALLOWED_GITHUB_LOGIN is not set");
  return new Set(v);
}

export const authOptions: AuthOptions = {
  providers: [
    GitHubProvider({
      clientId: process.env.GITHUB_ID ?? "",
      clientSecret: process.env.GITHUB_SECRET ?? "",
      authorization: { params: { scope: "read:user" } },
    }),
  ],
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: "/signin", error: "/signin" },
  callbacks: {
    async signIn({ profile }) {
      const login = String((profile as { login?: string } | undefined)?.login ?? "").toLowerCase();
      return allowedLogins().has(login);
    },
    async jwt({ token, profile }) {
      if (profile) token.login = String((profile as { login?: string }).login ?? "").toLowerCase();
      return token;
    },
    async session({ session, token }) {
      (session as { login?: string }).login = token.login as string | undefined;
      return session;
    },
  },
};

export async function currentLogin(): Promise<string | null> {
  try {
    const s = await getServerSession(authOptions);
    const login = (s as { login?: string } | null)?.login;
    return login && allowedLogins().has(login) ? login : null;
  } catch (e) {
    // Misconfiguration (e.g. ALLOWED_GITHUB_LOGIN unset) must fail closed, not 500.
    console.error("auth:", (e as Error).message);
    return null;
  }
}

/** For API routes: returns a 401 response if not signed in as the allowed user. */
export async function requireApiUser(): Promise<NextResponse | null> {
  return (await currentLogin()) ? null : NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/** Mutating routes: reject cross-site requests (SPEC.md §12 CSRF). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // same-origin fetches from older browsers / server calls
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
