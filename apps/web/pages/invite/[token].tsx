import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect } from "react";
import { hosted } from "../../lib/auth";

// Older links put the secret in the request path. That exposure cannot be
// undone by clearing the address bar; do not redeem or repeat the secret here.
export default function LegacyInvite() {
  const router = useRouter();
  useEffect(() => {
    if (!hosted) {
      void router.replace("/");
      return;
    }
    window.history.replaceState(window.history.state, "", "/invite");
  }, [router]);
  if (!hosted) return null;
  return (
    <div className="auth-shell">
      <Head>
        <title>Request a new invitation — Kinship</title>
        <meta name="referrer" content="no-referrer" />
      </Head>
      <Link className="public-brand" href="/">
        <span className="brand-symbol">✳</span> kinship
        <span className="brand-period">.</span>
      </Link>
      <main className="auth-card">
        <span className="eyebrow">INVITATION LINK UPDATED</span>
        <h1>
          Get a <em>new link.</em>
        </h1>
        <p>
          This older invitation format included its secret in the web address,
          where server access logs may have recorded it. It is not safe to use.
          Ask the administrator for a new invitation link.
        </p>
      </main>
      <Link className="auth-back" href="/">
        ← Back to home
      </Link>
    </div>
  );
}
