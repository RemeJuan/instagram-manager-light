import type { AppProps } from "next/app";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { ApiError, getSession, SessionUser } from "../lib/api";
import { hosted, isPrivatePath, privateReturnPath } from "../lib/auth";
import { SessionContext } from "../lib/session-context";
import { AccountScrollProvider } from "../lib/account-scroll";
import "../styles.css";
import "../manual-status.css";
import "../visibility-filter.css";
import "../hosted.css";

function PrivatePage({ Component, pageProps }: AppProps) {
  const router = useRouter();
  const [state, setState] = useState<{
    path: string;
    user: SessionUser | null;
    error: string;
  }>({ path: "", user: null, error: "" });
  const path = router.pathname;
  useEffect(() => {
    let active = true;
    setState({ path: "", user: null, error: "" });
    getSession()
      .then((user) => {
        if (!active) return;
        setState({ path, user, error: "" });
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiError && error.status === 401) {
          void router.replace(
            `/login?next=${encodeURIComponent(privateReturnPath(router.asPath))}`,
          );
        } else if (error instanceof ApiError && error.status === 403) {
          setState({
            path,
            user: null,
            error: "You do not have access to this page.",
          });
        } else {
          setState({
            path,
            user: null,
            error:
              "Could not check your session. Check your connection and try again.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [path]);
  useEffect(() => {
    const expired = () => {
      setState({ path: "", user: null, error: "" });
      void router.replace(
        `/login?next=${encodeURIComponent(privateReturnPath(router.asPath))}`,
      );
    };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, [router]);

  if (state.path !== path || !state.user) {
    return (
      <main className="auth-wait" role="status">
        <span className="brand-symbol">✳</span>
        <p>{state.error || "Checking your workspace…"}</p>
        {state.error && (
          <button className="primary-btn" onClick={() => void router.reload()}>
            Try again →
          </button>
        )}
      </main>
    );
  }
  if (path.startsWith("/admin/") && state.user.role !== "admin") {
    return (
      <main className="auth-wait">
        <h1>Admin access only.</h1>
        <a href="/dashboard">Back to dashboard →</a>
      </main>
    );
  }
  return (
    <SessionContext.Provider value={state.user}>
      <Component {...pageProps} />
    </SessionContext.Provider>
  );
}

export default function App(props: AppProps) {
  const router = useRouter();
  return (
    <AccountScrollProvider>
      {hosted && isPrivatePath(router.pathname) ? (
        <PrivatePage {...props} />
      ) : (
        <props.Component {...props.pageProps} />
      )}
    </AccountScrollProvider>
  );
}
