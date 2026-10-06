// Keep response-shape assumptions here. The UI works with normalized records only.
const BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
type RecordValue = Record<string, unknown>;
const obj = (v: unknown): RecordValue =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as RecordValue) : {};
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;
const bool = (v: unknown): boolean => v === true || v === 1;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const field = (o: RecordValue, ...keys: string[]): unknown =>
  keys.map((k) => o[k]).find((v) => v !== undefined && v !== null);

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new Error(
      "Cannot reach the local API. Start the API on localhost:3001 and try again.",
    );
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = obj(payload);
    const message = field(error, "message", "error");
    throw new Error(
      Array.isArray(message)
        ? message.join(" · ")
        : str(message) || `Request failed (${response.status}).`,
    );
  }
  return payload;
}

export type Side = "followers" | "following";
export type Coverage = "partial" | "complete";
export type PreviewSide = {
  count: number;
  invalidCount: number;
  duplicateCount: number;
  files: string[];
  proposedRemovals: number;
};
export type Preview = {
  token: string;
  sides: Partial<Record<Side, PreviewSide>>;
  warnings: string[];
};
export type ManualStatus = "deleted" | "inactive" | null;
export type Account = {
  id: string;
  username: string;
  profileUrl: string;
  view: string;
  followers: string;
  following: string;
  sourceTimestamp: string;
  firstObserved: string;
  lastObserved: string;
  ignored: boolean;
  keepFollowing: boolean;
  manualStatus: ManualStatus;
  note: string;
  timeline: Change[];
};
export type Page<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};
export type Change = {
  id: string;
  accountId: string;
  username: string;
  kind: string;
  side: string;
  detectedAt: string;
  importId: string;
};
export type ImportRecord = {
  id: string;
  createdAt: string;
  sides: Partial<
    Record<
      Side,
      { count: number; coverage: string; latestSourceTimestamp: string }
    >
  >;
  warnings: string[];
};

function pageData(raw: unknown): {
  records: unknown[];
  total: number;
  page: number;
  pageSize: number;
} {
  const outer = obj(raw);
  const nested = obj(field(outer, "data", "result"));
  const source = Array.isArray(raw)
    ? raw
    : list(
          field(
            outer,
            "items",
            "data",
            "results",
            "relationships",
            "accounts",
            "changes",
            "imports",
          ),
        ).length
      ? field(
          outer,
          "items",
          "data",
          "results",
          "relationships",
          "accounts",
          "changes",
          "imports",
        )
      : field(
          nested,
          "items",
          "results",
          "relationships",
          "accounts",
          "changes",
          "imports",
        );
  const records = list(source);
  return {
    records,
    total:
      num(
        field(outer, "total", "totalCount", "count") ??
          field(nested, "total", "totalCount", "count"),
      ) || records.length,
    page: num(field(outer, "page") ?? field(nested, "page")) || 1,
    pageSize:
      num(
        field(outer, "pageSize", "limit", "perPage") ??
          field(nested, "pageSize", "limit", "perPage"),
      ) || 20,
  };
}

export function accountFrom(raw: unknown): Account {
  const r = obj(raw),
    a = obj(r.account),
    p = obj(
      field(r, "preferences", "accountPreferences") ??
        field(a, "preferences", "accountPreferences"),
    );
  const value = (key: string, alternate?: string) =>
    field(r, key, ...(alternate ? [alternate] : [])) ??
    field(a, key, ...(alternate ? [alternate] : []));
  const username = str(
    value("display_username", "displayUsername") ?? value("username"),
  );
  const relationships = obj(r.relationships);
  const followers = obj(
    field(relationships, "followers") ?? field(r, "followers", "follower"),
  );
  const following = obj(
    field(relationships, "following") ?? field(r, "following"),
  );
  const state = (side: RecordValue, key: string) => {
    const explicit = field(r, `${key}Present`, `${key}_present`);
    const presence =
      field(side, "isPresent", "is_present", "present") ??
      field(r, `${key}_present`, `${key}Present`);
    return explicit === true || presence === true
      ? "Present"
      : explicit === false || presence === false
        ? "Absent"
        : "Unknown";
  };
  const id = String(value("id", "accountId") ?? value("account_id") ?? "");
  const profile = str(value("profileUrl", "profile_url"));
  return {
    id,
    username,
    profileUrl: /^https:\/\/(www\.)?instagram\.com\//i.test(profile)
      ? profile
      : username
        ? `https://www.instagram.com/${encodeURIComponent(username.replace(/^@/, ""))}/`
        : "",
    view: str(value("view", "category")),
    followers: state(followers, "followers"),
    following: state(following, "following"),
    sourceTimestamp: epochDate(
      field(
        r,
        "sourceRelationshipTimestamp",
        "source_relationship_timestamp",
        "sourceTimestamp",
      ) ??
        field(following, "source_relationship_timestamp") ??
        field(followers, "source_relationship_timestamp"),
    ),
    firstObserved: str(
      value("firstObservedAt", "first_observed_at") ??
        field(followers, "first_observed_at") ??
        field(following, "first_observed_at"),
    ),
    lastObserved: str(
      value("lastObservedAt", "last_observed_at") ??
        [
          field(followers, "last_observed_at"),
          field(following, "last_observed_at"),
        ]
          .filter((v) => typeof v === "string")
          .sort()
          .at(-1),
    ),
    ignored: bool(field(p, "ignored") ?? value("ignored")),
    keepFollowing: bool(
      field(p, "keepFollowing", "keep_following") ??
        value("keepFollowing", "keep_following"),
    ),
    manualStatus:
      field(p, "manualStatus", "manual_status") === "deleted" ||
      value("manualStatus", "manual_status") === "deleted"
        ? "deleted"
        : field(p, "manualStatus", "manual_status") === "inactive" ||
            value("manualStatus", "manual_status") === "inactive"
          ? "inactive"
          : null,
    note: str(field(p, "note") ?? value("note")),
    timeline: list(field(r, "timeline", "changes")).map(changeFrom),
  };
}

function epochDate(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value))
    return new Date(value * 1000).toISOString();
  if (typeof value === "string" && /^\d+$/.test(value))
    return new Date(Number(value) * 1000).toISOString();
  return str(value);
}

export function changeFrom(raw: unknown): Change {
  const r = obj(raw),
    a = obj(r.account);
  return {
    id: String(field(r, "id") ?? ""),
    accountId: String(
      field(r, "account_id", "accountId") ?? field(a, "id") ?? "",
    ),
    username: str(
      field(r, "display_username", "displayUsername", "username") ??
        field(a, "display_username", "displayUsername", "username"),
    ),
    kind: str(field(r, "kind", "type")),
    side: str(field(r, "side")),
    detectedAt: str(
      field(r, "detected_at", "detectedAt", "createdAt", "created_at"),
    ),
    importId: String(field(r, "import_id", "importId") ?? ""),
  };
}

export function importFrom(raw: unknown): ImportRecord {
  const r = obj(raw),
    sides = obj(field(r, "sides", "importSides"));
  const entries = Array.isArray(field(r, "sides", "importSides"))
    ? list(field(r, "sides", "importSides"))
    : [];
  const normalized: ImportRecord["sides"] = {};
  for (const side of ["followers", "following"] as Side[]) {
    const s = obj(
      sides[side] ?? entries.find((entry) => obj(entry).side === side),
    );
    if (Object.keys(s).length)
      normalized[side] = {
        count: num(field(s, "observedCount", "observed_count", "count")),
        coverage: str(field(s, "coverage")),
        latestSourceTimestamp: str(
          field(s, "latestSourceTimestamp", "latest_source_timestamp"),
        ),
      };
  }
  const warningValue = field(r, "warnings_json", "warnings", "warningsJson");
  let warnings: string[] = [];
  if (typeof warningValue === "string") {
    try {
      warnings = list(JSON.parse(warningValue)).map(String);
    } catch {
      warnings = warningValue ? [warningValue] : [];
    }
  } else warnings = list(warningValue).map(String);
  return {
    id: String(field(r, "id") ?? ""),
    createdAt: str(field(r, "createdAt", "created_at")),
    sides: normalized,
    warnings,
  };
}

export async function getAccounts(
  query: Record<string, string>,
): Promise<Page<Account>> {
  const params = new URLSearchParams(query);
  const data = pageData(await request(`/relationships?${params}`));
  return {
    items: data.records.map(accountFrom),
    total: data.total,
    page: data.page,
    pageSize: data.pageSize,
  };
}
export type Summary = {
  totalAccounts: number;
  notFollowingBack: number;
  followerOnly: number;
  mutual: number;
};
export async function getSummary(): Promise<Summary> {
  const r = obj(await request("/summary"));
  return {
    totalAccounts: num(r.totalAccounts),
    notFollowingBack: num(r.notFollowingBack),
    followerOnly: num(r.followerOnly),
    mutual: num(r.mutual),
  };
}
export async function getChanges(): Promise<Page<Change>> {
  const d = pageData(await request("/changes"));
  return {
    items: d.records.map(changeFrom),
    total: d.total,
    page: d.page,
    pageSize: d.pageSize,
  };
}
export async function getImports(): Promise<Page<ImportRecord>> {
  const d = pageData(await request("/imports"));
  return {
    items: d.records.map(importFrom),
    total: d.total,
    page: d.page,
    pageSize: d.pageSize,
  };
}
export async function getAccount(id: string): Promise<Account> {
  const data = await request(`/accounts/${encodeURIComponent(id)}`);
  const r = obj(data);
  return accountFrom(field(r, "data") ?? data);
}
export async function savePreferences(
  id: string,
  value: Partial<{
    keepFollowing: boolean;
    ignored: boolean;
    manualStatus: ManualStatus;
    note: string;
  }>,
): Promise<void> {
  await request(`/accounts/${encodeURIComponent(id)}/preferences`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}
export async function previewImport(files: File[]): Promise<Preview> {
  const body = new FormData();
  files.forEach((file) => body.append("files", file));
  const raw = obj(await request("/imports/preview", { method: "POST", body }));
  const sides = obj(raw.sides),
    result: Preview["sides"] = {};
  for (const side of ["followers", "following"] as Side[]) {
    const s = obj(sides[side]);
    if (!Object.keys(s).length) continue;
    result[side] = {
      count: num(s.count),
      invalidCount: num(s.invalidCount),
      duplicateCount: num(s.duplicateCount),
      files: list(s.files).map(String),
      proposedRemovals: num(s.proposedRemovals),
    };
  }
  return {
    token: str(raw.token),
    sides: result,
    warnings: list(raw.warnings).map(String),
  };
}
export async function commitImport(
  preview: Preview,
  coverage: Partial<Record<Side, Coverage>>,
  idempotencyToken: string,
): Promise<unknown> {
  return request("/imports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: preview.token, coverage, idempotencyToken }),
  });
}
