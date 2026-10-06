export type RelationshipSide = "followers" | "following";
export type Side = RelationshipSide;

export interface ParsedEntry {
  usernameNormalized: string;
  displayUsername: string;
  profileUrl: string | null;
  sourceTimestamp: number | null;
  sourceTimestampKind: string | null;
}

export interface ParsedSide {
  entries: ParsedEntry[];
  files: string[];
  invalidCount: number;
  duplicateCount: number;
}

export interface ParsedUpload {
  sides: Partial<Record<Side, ParsedSide>>;
  warnings: string[];
}
