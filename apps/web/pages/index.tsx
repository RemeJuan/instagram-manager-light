import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import {
  Account,
  Change,
  Coverage,
  getAccount,
  getAccounts,
  getChanges,
  getImports,
  getSummary,
  importFrom,
  ImportRecord,
  Page,
  Preview,
  previewImport,
  commitImport,
  savePreferences,
  Side,
} from "../lib/api";
import {
  ManualStatusBadge,
  ManualStatusControl,
} from "../components/ManualStatus";
import { useAccountScroll } from "../lib/account-scroll";
import { VisibilityFilter } from "../components/VisibilityFilter";
import { hosted } from "../lib/auth";
import { useHostedSession } from "../lib/session-context";

export default function Index() {
  return hosted ? <Landing /> : <Workspace />;
}

export function Landing() {
  return (
    <div className="public-shell">
      <Head>
        <title>Kinship — a clearer view of your connections</title>
        <meta
          name="description"
          content="Make sense of your Instagram exports, one snapshot at a time."
        />
      </Head>
      <header className="public-nav">
        <Link className="public-brand" href="/">
          <span className="brand-symbol">✳</span> kinship
          <span className="brand-period">.</span>
        </Link>
        <Link className="public-nav-link" href="/login">
          Log in <span>↗</span>
        </Link>
      </header>
      <main className="public-main">
        <section className="public-hero">
          <div>
            <span className="eyebrow">YOUR CONNECTIONS, IN CONTEXT</span>
            <h1>
              See the story
              <br />
              behind <em>your circle.</em>
            </h1>
            <p>
              Import your Instagram export. Explore the accounts and changes it
              reveals, without guessing what happened between snapshots.
            </p>
            <Link href="/login" className="primary-btn">
              Go to your workspace <span>↗</span>
            </Link>
            <p className="public-caption">
              Already invited? Use your invitation link to create an account.
            </p>
          </div>
          <div className="public-art" aria-hidden="true">
            <div className="art-orbit art-orbit-one" />
            <div className="art-orbit art-orbit-two" />
            <span className="art-core">✳</span>
            <span className="art-point art-point-a">◎</span>
            <span className="art-point art-point-b">↗</span>
            <span className="art-point art-point-c">◷</span>
            <span className="art-label">
              A clearer picture
              <br />
              with every import.
            </span>
          </div>
        </section>
        <section className="public-features" aria-label="How it works">
          <div>
            <span>01 / BRING YOUR EXPORT</span>
            <h2>Start with your data.</h2>
            <p>
              Upload a ZIP or supported JSON files from Instagram. No Instagram
              password needed.
            </p>
          </div>
          <div>
            <span>02 / READ THE EVIDENCE</span>
            <h2>Know what you know.</h2>
            <p>Separate confirmed changes from gaps in incomplete snapshots.</p>
          </div>
          <div>
            <span>03 / KEEP THE CONTEXT</span>
            <h2>See change over time.</h2>
            <p>Compare imports and keep your own notes on accounts.</p>
          </div>
        </section>
      </main>
      <footer className="public-footer">
        Kinship · Built for a more thoughtful look at your connections.
      </footer>
    </div>
  );
}

type Section = "overview" | "import" | "accounts" | "changes";
const sections: { id: Section; label: string; icon: string }[] = [
  { id: "overview", label: "Overview", icon: "◫" },
  { id: "import", label: "Import data", icon: "↥" },
  { id: "accounts", label: "Accounts", icon: "◎" },
  { id: "changes", label: "Changes", icon: "↗" },
];
const views = [
  { value: "", label: "All accounts" },
  { value: "not-following-back", label: "Not following back" },
  { value: "follower-only", label: "Follower only" },
  { value: "mutual", label: "Mutual" },
];
const date = (value: string) => {
  if (!value) return "Not available";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(d);
};
const dateTime = (value: string) => {
  if (!value) return "Not available";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(d);
};
const titleCase = (value: string) =>
  value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const category = (a: Account) =>
  a.followers === "Present" && a.following === "Present"
    ? "Mutual"
    : a.followers === "Absent" && a.following === "Present"
      ? "Not following back"
      : a.followers === "Present" && a.following === "Absent"
        ? "Follower only"
        : a.view
          ? titleCase(a.view)
          : "Uncertain";
const changeLabel = (c: Change) =>
  c.kind === "no_longer_present"
    ? `No longer in ${c.side || "snapshot"}`
    : c.kind === "newly_present"
      ? `Present again in ${c.side || "snapshot"}`
      : c.kind === "first_seen"
        ? `First observed in ${c.side || "snapshot"}`
        : titleCase(c.kind || "Change");

function CopyButton({ username }: { username: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-button"
      title={`Copy ${username}`}
      aria-label={`Copy username ${username}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(username);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "✓" : "⧉"}
      <span className="sr-only">{copied ? "Copied" : ""}</span>
    </button>
  );
}
function ProfileLink({ account }: { account: Account }) {
  return account.profileUrl ? (
    <a
      className="profile-link"
      href={account.profileUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${account.username} on Instagram in a new tab`}
    >
      ↗
    </a>
  ) : null;
}
function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty">
      <span className="empty-mark">◇</span>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
function InlineError({ text, retry }: { text: string; retry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <span>{text}</span>
      {retry && (
        <button onClick={retry} type="button">
          Try again ↗
        </button>
      )}
    </div>
  );
}

export function Workspace() {
  const router = useRouter();
  const user = useHostedSession();
  const accountScroll = useAccountScroll();
  const section: Section =
    router.pathname === "/import"
      ? "import"
      : router.pathname === "/changes"
        ? "changes"
        : router.pathname.startsWith("/accounts")
          ? "accounts"
          : "overview";
  const routeValue = (key: string) => {
    const value = router.query[key];
    return typeof value === "string" ? value : "";
  };
  const view = routeValue("view");
  const search = routeValue("search");
  const sort = routeValue("sort") || "username_normalized";
  const order = routeValue("order") || "asc";
  const showIgnored = routeValue("ignored") === "true";
  const manualStatus = routeValue("manualStatus");
  const showDeleted =
    routeValue("includeDeleted") === "true" || manualStatus === "deleted";
  const showKeepFollowing = routeValue("includeKeepFollowing") === "true";
  const page = Math.max(1, Number.parseInt(routeValue("page"), 10) || 1);
  const selectedId =
    router.pathname === "/accounts/[id]" ? routeValue("id") : "";
  const listParams = () => {
    const params = new URLSearchParams();
    for (const key of [
      "view",
      "search",
      "sort",
      "order",
      "ignored",
      "manualStatus",
      "includeDeleted",
      "includeKeepFollowing",
      "page",
    ]) {
      const value = routeValue(key);
      if (value) params.set(key, value);
    }
    return params;
  };
  const accountListUrl = () => {
    const params = listParams().toString();
    return `/accounts${params ? `?${params}` : ""}`;
  };
  const goTo = (next: Section, filter?: string) => {
    if (next === "accounts") {
      const params =
        filter === undefined
          ? listParams()
          : new URLSearchParams(filter ? { view: filter } : {});
      const qs = params.toString();
      void router.push(`/accounts${qs ? `?${qs}` : ""}`);
    } else
      void router.push(
        next === "overview" ? (hosted ? "/dashboard" : "/") : `/${next}`,
      );
  };
  const updateList = (values: Record<string, string>, replace = false) => {
    const params = listParams();
    for (const [key, value] of Object.entries(values)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const qs = params.toString();
    const url = `/accounts${qs ? `?${qs}` : ""}`;
    if (replace) void router.replace(url, undefined, { shallow: true });
    else void router.push(url, undefined, { shallow: true });
  };
  const openAccount = (id: string) => {
    if (id) {
      accountScroll.remember(accountListUrl());
      void router.push(
        `/accounts/${encodeURIComponent(id)}${listParams().toString() ? `?${listParams()}` : ""}`,
        undefined,
        { scroll: false },
      );
    }
  };
  const [imports, setImports] = useState<ImportRecord[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [accounts, setAccounts] = useState<Page<Account>>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
  });
  const [counts, setCounts] = useState<Record<string, number | null>>({
    "": null,
    "not-following-back": null,
    mutual: null,
  });
  const [error, setError] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [loadedAccountsQuery, setLoadedAccountsQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [idempotencyToken, setIdempotencyToken] = useState("");
  const [coverage, setCoverage] = useState<Partial<Record<Side, Coverage>>>({});
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [importSuccess, setImportSuccess] = useState("");

  useEffect(() => {
    if (router.isReady) setSearchInput(search);
  }, [router.isReady, search]);
  useEffect(() => {
    if (!router.isReady || section !== "accounts" || searchInput === search)
      return;
    const timer = window.setTimeout(
      () => updateList({ search: searchInput, page: "" }, true),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [router.isReady, section, searchInput, search]);
  const loadHistory = useCallback(() => {
    setLoading((v) => ({ ...v, history: true }));
    Promise.allSettled([getImports(), getChanges()]).then(
      ([history, events]) => {
        setError((v) => ({
          ...v,
          history: history.status === "rejected" ? history.reason.message : "",
          changes: events.status === "rejected" ? events.reason.message : "",
        }));
        if (history.status === "fulfilled") setImports(history.value.items);
        if (events.status === "fulfilled") setChanges(events.value.items);
        setLoading((v) => ({ ...v, history: false }));
      },
    );
  }, []);
  useEffect(() => {
    loadHistory();
  }, [loadHistory, revision]);
  const query = useMemo(
    () => ({
      view,
      search,
      sort,
      order,
      ignored: showIgnored ? "true" : "false",
      manualStatus,
      includeDeleted: showDeleted ? "true" : "false",
      includeKeepFollowing: showKeepFollowing ? "true" : "false",
      page: String(page),
    }),
    [
      view,
      search,
      sort,
      order,
      showIgnored,
      manualStatus,
      showDeleted,
      showKeepFollowing,
      page,
    ],
  );
  const accountQueryKey = JSON.stringify(query);
  const loadAccounts = useCallback(() => {
    let alive = true;
    setLoading((v) => ({ ...v, accounts: true }));
    getAccounts(query)
      .then((data) => {
        if (alive) {
          setAccounts(data);
          setLoadedAccountsQuery(JSON.stringify(query));
          setError((v) => ({ ...v, accounts: "" }));
        }
      })
      .catch((err) => {
        if (alive) setError((v) => ({ ...v, accounts: err.message }));
      })
      .finally(() => {
        if (alive) setLoading((v) => ({ ...v, accounts: false }));
      });
    return () => {
      alive = false;
    };
  }, [query]);
  useEffect(() => {
    if (router.isReady) return loadAccounts();
  }, [loadAccounts, revision, router.isReady]);
  useLayoutEffect(() => {
    if (
      !router.isReady ||
      router.pathname !== "/accounts" ||
      loading.accounts ||
      loadedAccountsQuery !== accountQueryKey ||
      error.accounts
    )
      return;
    const top = accountScroll.position(accountListUrl());
    if (top !== null) {
      if (window.scrollY !== top) window.scrollTo(0, top);
      accountScroll.restored(accountListUrl());
    }
  }, [
    router.isReady,
    router.pathname,
    router.asPath,
    loading.accounts,
    loadedAccountsQuery,
    accountQueryKey,
    error.accounts,
  ]);
  useEffect(() => {
    let active = true;
    getSummary()
      .then((summary) => {
        if (active)
          setCounts({
            "": summary.totalAccounts,
            "not-following-back": summary.notFollowingBack,
            mutual: summary.mutual,
          });
      })
      .catch(() => {
        if (active)
          setCounts({ "": null, "not-following-back": null, mutual: null });
      });
    return () => {
      active = false;
    };
  }, [revision]);
  const latestSide = (side: Side) => {
    const uploads = imports
      .filter((item) => item.sides[side])
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return {
      latest: uploads[0],
      complete: uploads.find(
        (item) => item.sides[side]?.coverage === "complete",
      ),
    };
  };
  const beginPreview = async () => {
    if (!files.length) return;
    setBusy(true);
    setImportError("");
    setImportSuccess("");
    setPreview(null);
    try {
      const result = await previewImport(files);
      setPreview(result);
      setIdempotencyToken(crypto.randomUUID());
      setCoverage(
        Object.fromEntries(
          Object.keys(result.sides).map((side) => [side, "partial"]),
        ) as Partial<Record<Side, Coverage>>,
      );
    } catch (e) {
      setImportError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    setImportError("");
    try {
      const result = await commitImport(preview, coverage, idempotencyToken);
      const record = importFrom(result);
      setImportSuccess(
        record.id
          ? `Import ${record.id} saved. Your workspace is up to date.`
          : "Import saved. Your workspace is up to date.",
      );
      setPreview(null);
      setFiles([]);
      setRevision((n) => n + 1);
    } catch (e) {
      setImportError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Head>
        <title>Kinship — Instagram relationship manager</title>
        <meta
          name="description"
          content="A clear view of your Instagram export relationships."
        />
      </Head>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-symbol">✳</span>
            <span>
              kinship<span className="brand-period">.</span>
            </span>
          </div>
          <p className="brand-sub">YOUR RELATIONSHIP SPACE</p>
          <div className="nav-label">WORKSPACE</div>
          <nav aria-label="Main navigation">
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`nav-item ${section === s.id ? "active" : ""}`}
                onClick={() => goTo(s.id)}
              >
                <span className="nav-icon">{s.icon}</span>
                {s.label}
                {section === s.id && <span className="nav-arrow">↗</span>}
              </button>
            ))}
            {hosted && user?.role === "admin" && (
              <Link className="nav-item" href="/admin/invitations">
                <span className="nav-icon">✉</span> Invitations
              </Link>
            )}
          </nav>
          <div className="sidebar-bottom">
            <div className="privacy-icon">⌂</div>
            <strong>Made for your own space.</strong>
            <p>
              {hosted
                ? "Your workspace is tied to your account. No Instagram login needed."
                : "Your data stays with your local setup. No Instagram login needed."}
            </p>
            <span className="local-pill">
              <span className="dot" />{" "}
              {hosted ? "YOUR WORKSPACE" : "LOCAL WORKSPACE"}
            </span>
            {hosted && (
              <button
                className="sidebar-logout"
                type="button"
                onClick={async () => {
                  try {
                    await import("../lib/api").then(({ logout }) => logout());
                    window.location.assign("/login");
                  } catch {
                    window.alert("Could not log out. Try again.");
                  }
                }}
              >
                Log out ↗
              </button>
            )}
          </div>
        </aside>
        <div className="main-area">
          <header className="topbar">
            <span className="breadcrumb">
              WORKSPACE <span>/</span>{" "}
              {sections.find((s) => s.id === section)?.label.toUpperCase()}
            </span>
            <span className="top-right">
              <span className="top-dot" /> PRIVATE BY DESIGN
            </span>
          </header>
          <main className="content" key={section}>
            {section === "overview" && (
              <>
                <div className="intro">
                  <div>
                    <span className="eyebrow">YOUR CONNECTIONS, CLEARLY</span>
                    <h1>
                      A closer look at
                      <br />
                      <em>your circle.</em>
                    </h1>
                    <p>
                      Add your Instagram account data export to compare what
                      followers and following snapshots show over time. No
                      Instagram password needed.
                    </p>
                  </div>
                  <div className="intro-import">
                    <button
                      className="primary-btn intro-action"
                      type="button"
                      onClick={() => goTo("import")}
                    >
                      ↥ &nbsp; Import Instagram export <span>↗</span>
                    </button>
                    <p className="intro-import-hint">
                      Instagram ZIP or supported followers/following JSON files.
                      Review before saving.
                    </p>
                  </div>
                </div>
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">AT A GLANCE</span>
                    <h2>Your relationship view</h2>
                  </div>
                  <button
                    className="text-link"
                    onClick={() => goTo("accounts")}
                    type="button"
                  >
                    Explore accounts ↗
                  </button>
                </div>
                <div className="stats-grid">
                  {[
                    {
                      label: "Imported accounts",
                      tone: "cream",
                      icon: "◎",
                      filter: "",
                    },
                    {
                      label: "Not following back",
                      tone: "peach",
                      icon: "↗",
                      filter: "not-following-back",
                    },
                    {
                      label: "Mutual connections",
                      tone: "mint",
                      icon: "✳",
                      filter: "mutual",
                    },
                  ].map((stat, i) => (
                    <button
                      type="button"
                      key={i}
                      className={`stat-card ${stat.tone}`}
                      onClick={() => goTo("accounts", stat.filter)}
                    >
                      <span className="stat-icon">{stat.icon}</span>
                      <span className="stat-value">
                        {counts[stat.filter] ?? "—"}
                      </span>
                      <span className="stat-label">{stat.label}</span>
                      <span className="stat-hint">
                        {i === 0
                          ? "All accounts · summary"
                          : "Open filtered list"}{" "}
                        ↗
                      </span>
                    </button>
                  ))}
                </div>
                <p className="small-note">
                  Summary totals may include ignored accounts. The accounts list
                  shows up to 100 results per page. Unknown sides or incomplete
                  snapshots can make classifications uncertain.
                </p>
                <div className="two-col">
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <span className="eyebrow">SNAPSHOT HEALTH</span>
                        <h2>Freshness by side</h2>
                      </div>
                      <span className="panel-symbol">◷</span>
                    </div>
                    {(["followers", "following"] as Side[]).map((side) => {
                      const { latest, complete } = latestSide(side);
                      return (
                        <div className="fresh-row" key={side}>
                          <div className="fresh-glyph">
                            {side === "followers" ? "↓" : "↑"}
                          </div>
                          <div>
                            <strong>{titleCase(side)}</strong>
                            <p>
                              Latest upload:{" "}
                              {latest
                                ? `${date(latest.createdAt)} · ${latest.sides[side]?.coverage || "coverage unknown"}`
                                : "No upload yet"}
                            </p>
                            <p>
                              Last complete snapshot:{" "}
                              {complete
                                ? date(complete.createdAt)
                                : "None — absence uncertain"}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                    {error.history && (
                      <InlineError text={error.history} retry={loadHistory} />
                    )}
                  </section>
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <span className="eyebrow">LATEST ACTIVITY</span>
                        <h2>First detected on import</h2>
                      </div>
                      <button
                        className="text-link"
                        onClick={() => goTo("changes")}
                        type="button"
                      >
                        View all ↗
                      </button>
                    </div>
                    {error.changes ? (
                      <InlineError text={error.changes} retry={loadHistory} />
                    ) : changes.length ? (
                      changes.slice(0, 3).map((c, i) => (
                        <div className="activity-row" key={c.id || i}>
                          <span className="activity-avatar">
                            {c.username.slice(0, 1).toUpperCase() || "◦"}
                          </span>
                          <div>
                            <strong>
                              {c.username ? `@${c.username}` : "Account update"}
                            </strong>
                            <p>{changeLabel(c)}</p>
                          </div>
                          <time>{date(c.detectedAt)}</time>
                        </div>
                      ))
                    ) : (
                      <Empty
                        title="No changes detected yet"
                        detail="Add an Instagram export now and another later to see changes in your followers and following."
                      />
                    )}
                  </section>
                </div>
                <div className="disclaimer">
                  <span>✳</span>
                  <p>
                    <strong>What this data can tell you.</strong> Changes are
                    first detected when you import an export, not when someone
                    followed or unfollowed. A timestamp in an export is not
                    necessarily the exact event time.
                  </p>
                </div>
              </>
            )}
            {section === "import" && (
              <>
                <div className="page-heading">
                  <span className="eyebrow">BRING YOUR DATA IN</span>
                  <h1>
                    Import your <em>export.</em>
                  </h1>
                  <p>
                    Add an Instagram export ZIP or follower/following JSON
                    files. Review what was found before saving anything.
                  </p>
                </div>
                <div className="import-layout">
                  <div>
                    <div className="panel upload-panel">
                      <div className="step-label">01 / SELECT FILES</div>
                      <h2>Choose files to review</h2>
                      <label className="dropzone">
                        <input
                          aria-label="Select Instagram export ZIP or JSON files"
                          type="file"
                          accept=".zip,.json,application/zip,application/json"
                          multiple
                          onChange={(e) => {
                            setFiles(Array.from(e.target.files || []));
                            setPreview(null);
                            setImportError("");
                          }}
                        />
                        <span className="upload-icon">↥</span>
                        <strong>Click to choose files</strong>
                        <span>ZIP or JSON · multiple files supported</span>
                      </label>
                      {files.length > 0 && (
                        <div className="file-list">
                          {files.map((file, i) => (
                            <div key={`${file.name}-${i}`}>
                              <span>▤</span>
                              <span>{file.name}</span>
                              <small>{(file.size / 1024).toFixed(0)} KB</small>
                            </div>
                          ))}
                        </div>
                      )}
                      <button
                        type="button"
                        className="primary-btn full"
                        disabled={!files.length || busy}
                        onClick={beginPreview}
                      >
                        {busy && !preview ? "Reading files…" : "Preview import"}{" "}
                        <span>→</span>
                      </button>
                    </div>
                    {preview && (
                      <div className="panel preview-panel">
                        <div className="step-label">02 / REVIEW & CONFIRM</div>
                        <h2>Review before saving</h2>
                        <p className="muted">
                          Coverage is set separately for each side. Partial is
                          safest when files may be missing.
                        </p>
                        {(["followers", "following"] as Side[]).map((side) => {
                          const info = preview.sides[side];
                          return info ? (
                            <div className="preview-side" key={side}>
                              <div className="preview-side-head">
                                <strong>{titleCase(side)}</strong>
                                <span>{info.count} valid accounts</span>
                              </div>
                              <p>
                                {info.files.length
                                  ? `Recognized: ${info.files.join(", ")}`
                                  : "Recognized files in upload"}
                              </p>
                              <p>
                                {info.invalidCount} invalid ·{" "}
                                {info.duplicateCount} duplicates ·{" "}
                                {info.proposedRemovals} proposed removals if
                                complete
                              </p>
                              <div className="coverage-choice">
                                <label>
                                  <input
                                    type="radio"
                                    name={`coverage-${side}`}
                                    checked={coverage[side] === "partial"}
                                    onChange={() =>
                                      setCoverage((v) => ({
                                        ...v,
                                        [side]: "partial",
                                      }))
                                    }
                                  />{" "}
                                  Partial <span>No removals inferred</span>
                                </label>
                                <label>
                                  <input
                                    type="radio"
                                    name={`coverage-${side}`}
                                    checked={coverage[side] === "complete"}
                                    onChange={() =>
                                      setCoverage((v) => ({
                                        ...v,
                                        [side]: "complete",
                                      }))
                                    }
                                  />{" "}
                                  Complete{" "}
                                  <span>
                                    Missing accounts may be marked absent
                                  </span>
                                </label>
                              </div>
                              {coverage[side] === "complete" && (
                                <p className="warning-line">
                                  Confirm this is a full {side} snapshot.{" "}
                                  {info.invalidCount > 0
                                    ? "Invalid records must be repaired before complete coverage can be saved."
                                    : "Missing accounts may be detected as no longer present."}
                                </p>
                              )}
                            </div>
                          ) : null;
                        })}
                        {!Object.keys(preview.sides).length && (
                          <InlineError text="No recognized relationship sides found. Choose a supported export file." />
                        )}
                        {preview.warnings.length > 0 && (
                          <div className="warnings">
                            <strong>Review warnings</strong>
                            {preview.warnings.map((w, i) => (
                              <p key={i}>• {w}</p>
                            ))}
                          </div>
                        )}
                        <button
                          type="button"
                          className="primary-btn full"
                          disabled={
                            busy ||
                            !Object.keys(preview.sides).length ||
                            (["followers", "following"] as Side[]).some(
                              (s) =>
                                !!preview.sides[s] &&
                                coverage[s] === "complete" &&
                                preview.sides[s]!.invalidCount > 0,
                            )
                          }
                          onClick={commit}
                        >
                          {busy ? "Saving…" : "Confirm & save import"}{" "}
                          <span>→</span>
                        </button>
                      </div>
                    )}
                    {importError && <InlineError text={importError} />}
                    {importSuccess && (
                      <div className="success-box" role="status">
                        ✓ {importSuccess}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="help-card">
                      <span className="eyebrow">GET YOUR EXPORT</span>
                      <h2>Export your Instagram data</h2>
                      <div className="help-item">
                        <span>01</span>
                        <p>
                          In Instagram, open <strong>Accounts Centre</strong> →
                          Your information and permissions → Export your
                          information → Create export.
                        </p>
                      </div>
                      <div className="help-item">
                        <span>02</span>
                        <p>
                          Select your Instagram profile,{" "}
                          <strong>Export to device</strong>, then specific
                          information. Look for Followers and following (or the
                          closest category). Choose All time if offered, and
                          JSON.
                        </p>
                      </div>
                      <div className="help-item">
                        <span>03</span>
                        <p>
                          Start the export and download it when ready. Upload
                          the ZIP here if provided, or the supported
                          follower/following JSON files.
                        </p>
                      </div>
                      <a
                        className="export-help-link"
                        href="https://www.facebook.com/help/instagram/181231772500920"
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="Instagram Help Center export instructions (opens in a new tab)"
                      >
                        Official Instagram instructions{" "}
                        <span aria-hidden="true">↗</span>
                      </a>
                      <p className="help-footnote">
                        Before saving, mark a side complete only if it includes
                        everyone in that snapshot. Otherwise, leave it partial.
                      </p>
                    </div>
                    <div className="panel history-panel">
                      <span className="eyebrow">IMPORT HISTORY</span>
                      <h2>Previous imports</h2>
                      {error.history ? (
                        <InlineError text={error.history} retry={loadHistory} />
                      ) : imports.length ? (
                        imports.slice(0, 6).map((item, i) => (
                          <div className="history-row" key={item.id || i}>
                            <span className="history-icon">↥</span>
                            <div>
                              <strong>{dateTime(item.createdAt)}</strong>
                              <p>
                                {(["followers", "following"] as Side[])
                                  .filter((s) => item.sides[s])
                                  .map(
                                    (s) =>
                                      `${titleCase(s)}: ${item.sides[s]?.coverage || "unknown"} (${item.sides[s]?.count ?? 0})`,
                                  )
                                  .join(" · ") || "Side details unavailable"}
                              </p>
                            </div>
                          </div>
                        ))
                      ) : (
                        <Empty
                          title="No imports yet"
                          detail="Your saved imports will appear here."
                        />
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
            {section === "accounts" && (
              <>
                <div className="page-heading row-heading">
                  <div>
                    <span className="eyebrow">THE PEOPLE IN YOUR EXPORTS</span>
                    <h1>
                      Your <em>accounts.</em>
                    </h1>
                    <p>
                      Search, sort and organize what your latest imports show.
                    </p>
                  </div>
                  <div className="count-badge">{accounts.total} matching</div>
                </div>
                <div className="panel accounts-panel">
                  <div className="toolbar">
                    <label className="search-box">
                      <span>⌕</span>
                      <input
                        type="search"
                        placeholder="Search username…"
                        aria-label="Search username"
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                      />
                    </label>
                    <label className="select-wrap">
                      <span className="sr-only">Filter by relationship</span>
                      <select
                        value={view}
                        onChange={(e) =>
                          updateList({ view: e.target.value, page: "" })
                        }
                      >
                        {views.map((v) => (
                          <option value={v.value} key={v.value}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="select-wrap">
                      <span className="sr-only">Sort accounts</span>
                      <select
                        value={`${sort}:${order}`}
                        onChange={(e) => {
                          const [s, o] = e.target.value.split(":");
                          updateList({ sort: s, order: o, page: "" });
                        }}
                      >
                        <option value="username_normalized:asc">
                          Username A–Z
                        </option>
                        <option value="username_normalized:desc">
                          Username Z–A
                        </option>
                        <option value="created_at:desc">
                          Recently observed
                        </option>
                      </select>
                    </label>
                    <label className="select-wrap">
                      <span className="sr-only">Filter manual status</span>
                      <select
                        value={manualStatus}
                        onChange={(e) =>
                          updateList({
                            manualStatus: e.target.value,
                            ...(e.target.value === "deleted"
                              ? { includeDeleted: "true" }
                              : {}),
                            page: "",
                          })
                        }
                      >
                        <option value="">All personal labels</option>
                        <option value="deleted">Marked deleted by you</option>
                        <option value="inactive">Marked inactive by you</option>
                      </select>
                    </label>
                    <VisibilityFilter
                      showIgnored={showIgnored}
                      showDeleted={showDeleted}
                      showKeepFollowing={showKeepFollowing}
                      onIgnoredChange={(checked) =>
                        updateList({ ignored: checked ? "true" : "", page: "" })
                      }
                      onDeletedChange={(checked) =>
                        updateList({
                          includeDeleted: checked ? "true" : "",
                          ...(checked
                            ? {}
                            : {
                                manualStatus:
                                  manualStatus === "deleted"
                                    ? ""
                                    : manualStatus,
                              }),
                          page: "",
                        })
                      }
                      onKeepFollowingChange={(checked) =>
                        updateList({
                          includeKeepFollowing: checked ? "true" : "",
                          page: "",
                        })
                      }
                    />
                  </div>
                  {error.accounts ? (
                    <InlineError
                      text={error.accounts}
                      retry={() => setRevision((n) => n + 1)}
                    />
                  ) : loading.accounts ? (
                    <div className="loading" role="status">
                      Loading accounts…
                    </div>
                  ) : accounts.items.length ? (
                    <>
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>ACCOUNT</th>
                              <th>RELATIONSHIP</th>
                              <th>FOLLOWERS</th>
                              <th>FOLLOWING</th>
                              <th>LAST OBSERVED</th>
                              <th>
                                <span className="sr-only">Actions</span>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {accounts.items.map((a, i) => (
                              <tr key={a.id || i}>
                                <td>
                                  <button
                                    className="account-name"
                                    type="button"
                                    onClick={() => openAccount(a.id)}
                                  >
                                    <span className="avatar">
                                      {a.username.slice(0, 1).toUpperCase() ||
                                        "◦"}
                                    </span>
                                    <span>
                                      @{a.username || "Unknown"}
                                      {a.ignored && <small>Ignored</small>}
                                      {a.keepFollowing && (
                                        <small>Keep following</small>
                                      )}
                                    </span>
                                  </button>
                                </td>
                                <td>
                                  <span
                                    className={`tag ${category(a) === "Mutual" ? "tag-green" : category(a) === "Not following back" ? "tag-peach" : ""}`}
                                  >
                                    {category(a)}
                                  </span>
                                  <ManualStatusBadge status={a.manualStatus} />
                                </td>
                                <td>{a.followers}</td>
                                <td>{a.following}</td>
                                <td>{date(a.lastObserved)}</td>
                                <td>
                                  <div className="row-actions">
                                    <CopyButton username={a.username} />
                                    <ProfileLink account={a} />
                                    <button
                                      type="button"
                                      className="icon-button"
                                      aria-label={`View details for ${a.username}`}
                                      onClick={() => openAccount(a.id)}
                                    >
                                      →
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="pagination">
                        <span>
                          Page {page} · {accounts.total} matching
                        </span>
                        <div>
                          <button
                            type="button"
                            disabled={page <= 1}
                            onClick={() =>
                              updateList({ page: String(page - 1) })
                            }
                          >
                            ← Previous
                          </button>
                          <button
                            type="button"
                            disabled={
                              page * accounts.pageSize >= accounts.total
                            }
                            onClick={() =>
                              updateList({ page: String(page + 1) })
                            }
                          >
                            Next →
                          </button>
                        </div>
                      </div>
                    </>
                  ) : (
                    <Empty
                      title="No accounts found"
                      detail="Try another filter, or add your Instagram export to get started."
                    />
                  )}
                </div>
                <p className="small-note">
                  Absent means missing from a complete snapshot; unknown means
                  not enough evidence. Partial imports do not establish absence.
                </p>
              </>
            )}
            {section === "changes" && (
              <>
                <div className="page-heading">
                  <span className="eyebrow">OVER TIME</span>
                  <h1>
                    What <em>changed.</em>
                  </h1>
                  <p>
                    Changes are first detected on import, not necessarily when a
                    follow or unfollow happened.
                  </p>
                </div>
                <div className="disclaimer changes-note">
                  <span>◷</span>
                  <p>
                    <strong>A note about dates.</strong> Detection dates reflect
                    when you imported a snapshot. Timestamps in an export are
                    shown separately and may not represent exact follow or
                    unfollow times.
                  </p>
                </div>
                <div className="panel change-panel">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">DETECTED EVENTS</span>
                      <h2>Relationship history</h2>
                    </div>
                    <span className="count-badge">{changes.length} shown</span>
                  </div>
                  {error.changes ? (
                    <InlineError text={error.changes} retry={loadHistory} />
                  ) : loading.history ? (
                    <div className="loading">Loading changes…</div>
                  ) : changes.length ? (
                    changes.map((c, i) => (
                      <div className="change-row" key={c.id || i}>
                        <span className="change-mark">
                          {c.kind === "no_longer_present" ? "−" : "+"}
                        </span>
                        <div>
                          <strong>
                            {c.username ? `@${c.username}` : "Account update"}
                          </strong>
                          <p>
                            {changeLabel(c)} ·{" "}
                            {titleCase(c.side || "relationship")}
                          </p>
                          {c.importId && <small>Import {c.importId}</small>}
                        </div>
                        <div className="change-date">
                          <span>FIRST DETECTED ON IMPORT</span>
                          <strong>{dateTime(c.detectedAt)}</strong>
                        </div>
                      </div>
                    ))
                  ) : (
                    <Empty
                      title="No changes recorded"
                      detail="Changes appear here when a later import reveals a difference."
                    />
                  )}
                </div>
              </>
            )}
          </main>
        </div>
      </div>
      {selectedId && (
        <AccountDrawer
          id={selectedId}
          onClose={() =>
            void router.push(accountListUrl(), undefined, { scroll: false })
          }
          onSaved={() => setRevision((n) => n + 1)}
        />
      )}
    </>
  );
}

function AccountDrawer({
  id,
  onClose,
  onSaved,
}: {
  id: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [account, setAccount] = useState<Account | null>(null);
  const [draft, setDraft] = useState<{
    keepFollowing: boolean;
    ignored: boolean;
    manualStatus: Account["manualStatus"];
    note: string;
  }>({ keepFollowing: false, ignored: false, manualStatus: null, note: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    getAccount(id)
      .then((a) => {
        if (active) {
          setAccount(a);
          setDraft({
            keepFollowing: a.keepFollowing,
            ignored: a.ignored,
            manualStatus: a.manualStatus,
            note: a.note,
          });
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [id]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      await savePreferences(id, draft);
      setAccount((current) => (current ? { ...current, ...draft } : current));
      setSaved(true);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Account details"
      >
        <div className="drawer-top">
          <span className="eyebrow">ACCOUNT DETAILS</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Close account details"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {error && <InlineError text={error} />}
        {!account && !error && <div className="loading">Loading account…</div>}
        {account && (
          <>
            <div className="drawer-identity">
              <span className="avatar big">
                {account.username.slice(0, 1).toUpperCase() || "◦"}
              </span>
              <h2>@{account.username}</h2>
              <span className="tag">{category(account)}</span>
              <ManualStatusBadge status={account.manualStatus} />
              <div className="drawer-links">
                <CopyButton username={account.username} />
                <ProfileLink account={account} />
              </div>
            </div>
            <div className="drawer-section">
              <span className="eyebrow">IMPORTED EVIDENCE</span>
              <div className="detail-line">
                <span>Followers</span>
                <strong>{account.followers}</strong>
              </div>
              <div className="detail-line">
                <span>Following</span>
                <strong>{account.following}</strong>
              </div>
              <div className="detail-line">
                <span>First observed</span>
                <strong>{date(account.firstObserved)}</strong>
              </div>
              <div className="detail-line">
                <span>Last observed</span>
                <strong>{date(account.lastObserved)}</strong>
              </div>
              <div className="detail-line">
                <span>Timestamp in export</span>
                <strong>{dateTime(account.sourceTimestamp)}</strong>
              </div>
              <p className="small-note">
                Export timestamp is not an exact follow date. Unknown states
                need a complete snapshot before absence can be inferred.
              </p>
            </div>
            <div className="drawer-section">
              <span className="eyebrow">YOUR PREFERENCES</span>
              <p className="muted">
                These notes and choices do not change imported facts.
              </p>
              <label className="toggle-row">
                <span>
                  <strong>Keep following</strong>
                  <small>Mark as a connection to keep</small>
                </span>
                <input
                  type="checkbox"
                  checked={draft.keepFollowing}
                  onChange={(e) =>
                    setDraft((v) => ({ ...v, keepFollowing: e.target.checked }))
                  }
                />
              </label>
              <label className="toggle-row">
                <span>
                  <strong>Ignore account</strong>
                  <small>Hide from lists by default</small>
                </span>
                <input
                  type="checkbox"
                  checked={draft.ignored}
                  onChange={(e) =>
                    setDraft((v) => ({ ...v, ignored: e.target.checked }))
                  }
                />
              </label>
              <ManualStatusControl
                value={draft.manualStatus}
                onChange={(manualStatus) =>
                  setDraft((v) => ({ ...v, manualStatus }))
                }
              />
              <label className="form-field">
                Private note
                <textarea
                  rows={3}
                  placeholder="Add a note for yourself…"
                  value={draft.note}
                  onChange={(e) =>
                    setDraft((v) => ({ ...v, note: e.target.value }))
                  }
                />
              </label>
              <button
                type="button"
                disabled={saving}
                className="primary-btn full"
                onClick={save}
              >
                {saving ? "Saving…" : "Save preferences"} <span>→</span>
              </button>
              {saved && (
                <p className="saved-message" role="status">
                  ✓ Preferences saved
                </p>
              )}
            </div>
            <div className="drawer-section">
              <span className="eyebrow">OBSERVATION HISTORY</span>
              {account.timeline.length ? (
                account.timeline.map((c, i) => (
                  <div className="timeline-row" key={c.id || i}>
                    <strong>{changeLabel(c)}</strong>
                    <span>First detected on import · {date(c.detectedAt)}</span>
                  </div>
                ))
              ) : (
                <p className="muted">No account timeline available.</p>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
