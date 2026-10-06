import type {
  ParsedEntry,
  ParsedSide,
  ParsedUpload,
  Side,
} from "@instagram-manager/contracts";
import yauzl from "yauzl";

export type {
  ParsedEntry,
  ParsedSide,
  ParsedUpload,
  Side,
} from "@instagram-manager/contracts";

const MAX_COMPRESSED = 50 * 1024 * 1024;
const MAX_EXPANDED = 200 * 1024 * 1024;
const MAX_JSON = 20 * 1024 * 1024;
const MAX_ENTRIES = 500;
const MAX_RATIO = 200;

function isZip(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const signature = buffer.readUInt32LE(0);
  return (
    signature === 0x04034b50 ||
    signature === 0x06054b50 ||
    signature === 0x08074b50
  );
}

type Candidate = { side: Side; name: string; buffer: Buffer };
type DecodedRow = ParsedEntry | null;
type DecodedRows = { rows: DecodedRow[]; invalid: number };
type ZipBudget = { expanded: number; entries: number };
type JsonListItem = Record<string, unknown>;
type RelationshipRow = Record<string, unknown>;

function classify(value: unknown): Side | null {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "relationships_following")
  )
    return "following";
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (row) =>
        row &&
        typeof row === "object" &&
        !Array.isArray(row) &&
        Array.isArray((row as Record<string, unknown>).string_list_data),
    )
  )
    return "followers";
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const [key, rows] of Object.entries(record)) {
      if (/^followers(?:_\d+)?$/i.test(key) && Array.isArray(rows))
        return "followers";
    }
  }
  return null;
}

function validUsername(
  value: unknown,
): { display: string; normalized: string } | null {
  if (typeof value !== "string") return null;
  const display = value.trim().replace(/^@/, "");
  if (
    !display ||
    display.length > 30 ||
    !/^[a-zA-Z0-9._]+$/.test(display) ||
    display.startsWith(".") ||
    display.endsWith(".")
  )
    return null;
  return { display, normalized: display.toLowerCase() };
}

function urlUsername(
  value: unknown,
): { display: string; normalized: string; profileUrl: string | null } | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (/[\\/]/.test(url.hostname)) return null;
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const isInstagram = /(^|\.)instagram\.com$/i.test(url.hostname);
    if (!isInstagram || url.search || url.hash) return null;
    const routedPath =
      parts.length === 2 &&
      parts[0] === "_u" &&
      /^\/_u\/[^/]+\/?$/.test(url.pathname);
    if (
      !routedPath &&
      (parts.length !== 1 ||
        !/^\/[^/]+\/?$/.test(url.pathname) ||
        ["p", "reel", "stories", "explore", "accounts"].includes(
          parts[0].toLowerCase(),
        ))
    )
      return null;
    const decoded = decodeURIComponent(routedPath ? parts[1] : parts[0]);
    // URL path segments are identities, not free-form usernames: never trim or strip @ here.
    if (decoded !== decoded.trim() || decoded.startsWith("@")) return null;
    const account = validUsername(decoded);
    return account?.display === decoded &&
      !["p", "reel", "stories", "explore", "accounts"].includes(
        decoded.toLowerCase(),
      )
      ? {
          ...account,
          profileUrl: `https://www.instagram.com/${account.display}/`,
        }
      : null;
  } catch {
    return null;
  }
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function rowsFor(side: Side, value: unknown): unknown[] | null {
  if (side === "followers") {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (
        entries.length &&
        entries.every(
          ([key, row]) =>
            /^followers(?:_\d+)?$/.test(key) && Array.isArray(row),
        )
      )
        return entries.flatMap(([, row]) => row as unknown[]);
    }
    return null;
  }
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as Record<string, unknown>).relationships_following)
  )
    return (value as Record<string, unknown>)
      .relationships_following as unknown[];
  return null;
}

function decodeRows(candidate: Candidate): DecodedRows {
  let value: unknown;
  try {
    value = JSON.parse(candidate.buffer.toString("utf8"));
  } catch {
    throw new Error(`Malformed JSON: ${candidate.name}`);
  }
  const rows = rowsFor(candidate.side, value);
  if (!rows) throw new Error(`Unexpected JSON structure: ${candidate.name}`);
  let invalid = 0;
  const decodedRows: DecodedRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      invalid++;
      continue;
    }
    const data = row as RelationshipRow;
    const items = data.string_list_data;
    if (!Array.isArray(items) || !items.length) {
      invalid++;
      continue;
    }
    let malformed = false;
    const rowEntries: ParsedEntry[] = [];
    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
        invalid++;
        malformed = true;
        continue;
      }
      const item = rawItem as JsonListItem;
      const valueAccount = validUsername(item.value);
      const titleAccount =
        candidate.side === "following" ? validUsername(data.title) : null;
      const hasHref =
        item.href !== undefined && item.href !== null && item.href !== "";
      const hrefAccount = hasHref ? urlUsername(item.href) : null;
      if (hasHref && !hrefAccount) {
        invalid++;
        malformed = true;
        continue;
      }
      const hasTitle =
        typeof data.title === "string" && data.title.trim() !== "";
      const hasValue =
        typeof item.value === "string" && item.value.trim() !== "";
      if ((hasTitle && !titleAccount) || (hasValue && !valueAccount)) {
        invalid++;
        malformed = true;
        continue;
      }
      if (
        (valueAccount &&
          titleAccount &&
          valueAccount.normalized !== titleAccount.normalized) ||
        (valueAccount &&
          hrefAccount &&
          valueAccount.normalized !== hrefAccount.normalized) ||
        (titleAccount &&
          hrefAccount &&
          titleAccount.normalized !== hrefAccount.normalized)
      ) {
        invalid++;
        malformed = true;
        continue;
      }
      const account =
        valueAccount ??
        titleAccount ??
        (hrefAccount?.profileUrl ? hrefAccount : null);
      if (!account) {
        invalid++;
        malformed = true;
        continue;
      }
      const timestampValue = timestamp(item.timestamp);
      rowEntries.push({
        usernameNormalized: account.normalized,
        displayUsername: account.display,
        profileUrl: hrefAccount?.profileUrl ?? null,
        sourceTimestamp: timestampValue,
        sourceTimestampKind:
          timestampValue === null ? null : "timestamp in export",
      });
    }
    if (!malformed) decodedRows.push(...rowEntries);
  }
  return { rows: decodedRows, invalid };
}

function openZip(buffer: Buffer, budget: ZipBudget): Promise<Candidate[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, decodeStrings: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip)
          return reject(error ?? new Error("Invalid ZIP archive"));
        const candidates: Candidate[] = [];
        const seen = new Set<string>();
        let settled = false;
        const fail = (reason: Error) => {
          if (!settled) {
            settled = true;
            zip.close();
            reject(reason);
          }
        };
        zip.on("error", fail);
        zip.on("entry", (entry) => {
          if (++budget.entries > MAX_ENTRIES)
            return fail(new Error("ZIP entry limit exceeded"));
          const name = entry.fileName;
          if (
            name.startsWith("/") ||
            /^[a-zA-Z]:/.test(name) ||
            name.includes("\\") ||
            name.split("/").some((part) => part === ".." || part === ".")
          )
            return fail(new Error("Unsafe ZIP path"));
          const foldedName = name.toLocaleLowerCase("en-US");
          if (seen.has(foldedName))
            return fail(new Error(`Duplicate ZIP path: ${name}`));
          seen.add(foldedName);
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          if ((mode & 0o170000) === 0o120000)
            return fail(new Error("ZIP symlinks are not allowed"));
          if (entry.generalPurposeBitFlag & 1)
            return fail(new Error("Encrypted ZIP entries are not allowed"));
          if (entry.fileName.toLowerCase().endsWith(".zip"))
            return fail(new Error("Nested archives are not allowed"));
          if (
            entry.uncompressedSize > 0 &&
            (entry.compressedSize === 0 ||
              entry.uncompressedSize / entry.compressedSize > MAX_RATIO)
          )
            return fail(
              new Error("ZIP entry size or expansion limit exceeded"),
            );
          budget.expanded += entry.uncompressedSize;
          if (budget.expanded > MAX_EXPANDED)
            return fail(new Error("ZIP expanded size limit exceeded"));
          if (entry.uncompressedSize > MAX_JSON)
            return fail(
              new Error("ZIP entry size or expansion limit exceeded"),
            );
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream)
              return fail(streamError ?? new Error("Cannot read ZIP entry"));
            const chunks: Buffer[] = [];
            let bytes = 0;
            stream.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > MAX_JSON) {
                stream.destroy(new Error("JSON size limit exceeded"));
                return;
              }
              chunks.push(chunk);
            });
            stream.on("error", fail);
            stream.on("end", () => {
              const contents = Buffer.concat(chunks);
              let value: unknown;
              try {
                value = JSON.parse(contents.toString("utf8"));
              } catch {
                zip.readEntry();
                return;
              }
              const side = classify(value);
              if (side) candidates.push({ side, name, buffer: contents });
              zip.readEntry();
            });
          });
        });
        zip.on("end", () => {
          if (!settled) {
            settled = true;
            resolve(candidates);
          }
        });
        zip.readEntry();
      },
    );
  });
}

export async function parseUpload(
  files: Array<{ filename: string; buffer: Buffer }>,
): Promise<ParsedUpload> {
  if (!Array.isArray(files) || !files.length)
    throw new Error("Upload contains no files");
  if (files.length > MAX_ENTRIES)
    throw new Error("Upload file count limit exceeded");
  const candidates: Candidate[] = [];
  const zipBudget: ZipBudget = { expanded: 0, entries: 0 };
  let hasRecognizedSide = false;
  let compressed = 0;
  for (const file of files) {
    if (!Buffer.isBuffer(file.buffer))
      throw new Error("Upload file must contain a Buffer");
    compressed += file.buffer.length;
    if (compressed > MAX_COMPRESSED)
      throw new Error("Upload size limit exceeded");
    if (isZip(file.buffer))
      candidates.push(...(await openZip(file.buffer, zipBudget)));
    else {
      if (file.buffer.length > MAX_JSON)
        throw new Error("JSON size limit exceeded");
      let value: unknown;
      try {
        value = JSON.parse(file.buffer.toString("utf8"));
      } catch {
        throw new Error(`Malformed JSON: ${file.filename}`);
      }
      const side = classify(value);
      if (side)
        candidates.push({ side, name: file.filename, buffer: file.buffer });
    }
    if (candidates.length) hasRecognizedSide = true;
  }
  if (!hasRecognizedSide)
    throw new Error("Upload contains no recognized relationship files");
  const result: ParsedUpload = { sides: {}, warnings: [] };
  let totalRows = 0;
  const MAX_ROWS = 1_000_000;
  const parsedBySide: Record<Side, Map<string, ParsedEntry>> = {
    followers: new Map(),
    following: new Map(),
  };
  for (const candidate of candidates) {
    const decoded = decodeRows(candidate);
    totalRows += decoded.rows.length + decoded.invalid;
    if (totalRows > MAX_ROWS)
      throw new Error("Upload relationship row limit exceeded");
    const side = (result.sides[candidate.side] ??= {
      entries: [],
      files: [],
      invalidCount: 0,
      duplicateCount: 0,
    } satisfies ParsedSide);
    side.files.push(candidate.name);
    side.invalidCount += decoded.invalid;
    for (const row of decoded.rows) {
      if (!row) continue;
      const previous = parsedBySide[candidate.side].get(row.usernameNormalized);
      if (previous) {
        side.duplicateCount++;
        if (
          previous.displayUsername !== row.displayUsername ||
          previous.profileUrl !== row.profileUrl ||
          previous.sourceTimestamp !== row.sourceTimestamp
        )
          result.warnings.push(
            `Conflicting duplicate metadata for ${row.usernameNormalized}`,
          );
      } else {
        parsedBySide[candidate.side].set(row.usernameNormalized, row);
        side.entries.push(row);
      }
    }
  }
  for (const [sideName, side] of Object.entries(result.sides)) {
    if (side.duplicateCount)
      result.warnings.push(
        `${sideName}: ${side.duplicateCount} duplicate entries`,
      );
    if (side.invalidCount)
      result.warnings.push(`${sideName}: ${side.invalidCount} invalid entries`);
  }
  return result;
}
