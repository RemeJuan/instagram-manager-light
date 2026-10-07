import Head from "next/head";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { createInvitation, getInvitations, Invitation } from "../../lib/api";
import { hosted } from "../../lib/auth";

export default function Invitations() {
  const [items, setItems] = useState<Invitation[]>([]);
  const [hours, setHours] = useState(24);
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      setItems(await getInvitations());
      setError("");
    } catch {
      setError("Could not load invitations. Try again.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (hosted) void load();
  }, [load]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setLink("");
    try {
      const result = await createInvitation(hours);
      setLink(
        `${window.location.origin}/invite#token=${encodeURIComponent(result.token)}`,
      );
      void load();
    } catch {
      setError("Could not create an invitation. Try again.");
    } finally {
      setBusy(false);
    }
  }
  if (!hosted)
    return (
      <main className="auth-wait">
        <Link href="/">Back to dashboard</Link>
      </main>
    );
  return (
    <div className="admin-shell">
      <Head>
        <title>Invitations — Kinship</title>
      </Head>
      <header className="admin-header">
        <Link href="/dashboard" className="public-brand">
          <span className="brand-symbol">✳</span> kinship
          <span className="brand-period">.</span>
        </Link>
        <Link href="/dashboard">← Workspace</Link>
      </header>
      <main className="admin-content">
        <span className="eyebrow">ADMIN / ACCESS</span>
        <h1>
          Invite someone <em>in.</em>
        </h1>
        <p>
          Create a one-time link and share it yourself. The link is shown only
          now, not in the invitation list.
        </p>
        <div className="admin-grid">
          <section className="panel">
            <h2>New invitation</h2>
            <form onSubmit={submit}>
              <label className="auth-field">
                Expires after
                <select
                  value={hours}
                  onChange={(e) => setHours(Number(e.target.value))}
                >
                  <option value={1}>1 hour</option>
                  <option value={24}>24 hours</option>
                  <option value={72}>3 days</option>
                  <option value={168}>7 days</option>
                </select>
              </label>
              <button className="primary-btn full" disabled={busy}>
                {busy ? "Creating…" : "Create link"}
                <span>↗</span>
              </button>
            </form>
            {link && (
              <div className="invitation-link" role="status">
                <strong>Copy this link now</strong>
                <p>
                  It will not be shown again. Share it privately with the person
                  you invited.
                </p>
                <input
                  readOnly
                  aria-label="New invitation link"
                  value={link}
                  onFocus={(e) => e.target.select()}
                />
                <button
                  type="button"
                  className="text-link"
                  onClick={() => void navigator.clipboard.writeText(link)}
                >
                  Copy link ⧉
                </button>
                <button
                  type="button"
                  className="text-link"
                  onClick={() => setLink("")}
                >
                  Hide link
                </button>
              </div>
            )}
            {error && (
              <p className="auth-error" role="alert">
                {error}
              </p>
            )}
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>Invitation activity</h2>
              <button
                className="text-link"
                type="button"
                onClick={() => void load()}
              >
                Refresh ↗
              </button>
            </div>
            {loading ? (
              <p>Loading invitations…</p>
            ) : items.length ? (
              <ul className="invitation-list">
                {items.map((item) => (
                  <li key={item.id}>
                    <span className="invitation-status">
                      {item.redeemedAt
                        ? "Used"
                        : Date.parse(item.expiresAt) < Date.now()
                          ? "Expired"
                          : "Available"}
                    </span>
                    <span>
                      Created {new Date(item.createdAt).toLocaleString()}
                      <br />
                      Expires {new Date(item.expiresAt).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No invitations yet.</p>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
