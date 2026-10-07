import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { FormEvent, useEffect, useState } from "react";
import { redeemInvitation } from "../../lib/api";
import { hosted } from "../../lib/auth";

export default function RedeemInvite() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!hosted) {
      void router.replace("/");
      return;
    }
    // Fragments never reach the server. Read once, then clear browser history.
    const fragment = window.location.hash;
    if (fragment) {
      window.history.replaceState(window.history.state, "", "/invite");
      const value = new URLSearchParams(fragment.slice(1)).get("token");
      if (value && value.length <= 256) setToken(value);
    }
  }, [router]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await redeemInvitation(token, username, password);
      setToken("");
      setDone(true);
    } catch {
      setError(
        "Could not accept this invitation. It may have expired or already been used. Ask for a new link.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!hosted) return null;
  return (
    <div className="auth-shell">
      <Head>
        <title>Accept invitation — Kinship</title>
        <meta name="referrer" content="no-referrer" />
      </Head>
      <Link className="public-brand" href="/">
        <span className="brand-symbol">✳</span> kinship
        <span className="brand-period">.</span>
      </Link>
      <main className="auth-card">
        <span className="eyebrow">YOUR INVITATION</span>
        <h1>
          A space of <em>your own.</em>
        </h1>
        {done ? (
          <>
            <p>Your account is ready. Log in to start using your workspace.</p>
            <Link className="primary-btn" href="/login">
              Go to login <span>→</span>
            </Link>
          </>
        ) : token ? (
          <>
            <p>Choose a username and password to create your account.</p>
            <form onSubmit={submit}>
              <label>
                Username
                <input
                  required
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </label>
              <label>
                Password
                <input
                  required
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              {error && (
                <p className="auth-error" role="alert">
                  {error}
                </p>
              )}
              <button className="primary-btn full" disabled={busy}>
                {busy ? "Creating account…" : "Create account"}
                <span>→</span>
              </button>
            </form>
          </>
        ) : (
          <p>
            Open your invitation link to create an account. If it is no longer
            available, ask for a new one.
          </p>
        )}
      </main>
      <Link className="auth-back" href="/">
        ← Back to home
      </Link>
    </div>
  );
}
