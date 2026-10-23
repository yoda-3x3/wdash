"use client";

import { signIn } from "next-auth/react";

export function SignIn({ error }: { error?: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="card w-full max-w-sm space-y-4 p-6 text-center">
        <img src="/icon.svg" alt="" className="mood-icon mx-auto h-12 w-12" />
        <h1 className="text-xl font-semibold">wdash</h1>
        <p className="text-sm text-muted">Remote control for your Claude agent teams.</p>
        {error && <p className="text-sm text-bad">{error === "AccessDenied" ? "That GitHub account isn't allowed." : "Sign-in failed. Try again."}</p>}
        <button className="btn btn-primary w-full py-2" onClick={() => signIn("github", { callbackUrl: "/" })}>
          Sign in with GitHub
        </button>
      </div>
    </main>
  );
}
