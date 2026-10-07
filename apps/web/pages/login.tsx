import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { FormEvent, useEffect, useState } from "react";
import { getSession, login } from "../lib/api";
import { hosted, privateReturnPath } from "../lib/auth";

export default function Login() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const next = privateReturnPath(router.query.next);
  useEffect(() => {
    if (!hosted) void router.replace("/");
  }, [router]);
  useEffect(() => {
    if (!hosted || !router.isReady) return;
    let active = true;
    getSession()
      .then(() => {
        if (active) void router.replace(next);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [router.isReady, next]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(username, password);
      await getSession();
      void router.replace(next);
    } catch {
      setError("Could not log in. Check your details and try again.");
    } finally {
      setBusy(false);
    }
  }
  if (!hosted) return null;
  return (
    <div className="auth-shell">
      <Head>
        <title>Log in — Kinship</title>
      </Head>
      <Link className="public-brand" href="/">
        <span className="brand-symbol">✳</span> kinship
        <span className="brand-period">.</span>
      </Link>
      <main className="auth-card">
        <span className="eyebrow">WELCOME BACK</span>
        <h1>
          Your space <em>awaits.</em>
        </h1>
        <p>Log in to view your imports and relationship history.</p>
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
              autoComplete="current-password"
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
            {busy ? "Logging in…" : "Log in"}
            <span>→</span>
          </button>
        </form>
        <p className="auth-foot">
          New here? Ask an administrator for an invitation link.
        </p>
      </main>
      <Link href="/" className="auth-back">
        ← Back to home
      </Link>
    </div>
  );
}
