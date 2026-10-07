import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { createHash, randomUUID } from "crypto";
import {
  parseUpload,
  type ParsedUpload,
} from "@instagram-manager/import-format";
import { RelationshipService } from "./relationship.service";
import type { Request } from "express";

type PrincipalRequest = Request & { principal?: { id: string } };
function owner(req: PrincipalRequest): string {
  if (!req.principal?.id) throw new HttpException("Unauthorized", 401);
  return req.principal.id;
}

@Controller()
export class AppController {
  private previews = new Map<
    string,
    { parsed: ParsedUpload; hash: string; created: number; ownerId: string }
  >();
  constructor(
    @Inject(RelationshipService) private readonly service: RelationshipService,
  ) {}

  @Post("imports/preview")
  @UseInterceptors(
    FilesInterceptor("files", 20, {
      limits: { fileSize: 25 * 1024 * 1024, files: 20 },
    }),
  )
  async preview(
    @Req() req: PrincipalRequest,
    @UploadedFiles() files: Array<Express.Multer.File> = [],
  ) {
    const ownerId = owner(req);
    if (!files.length) throw new HttpException("Upload at least one file", 400);
    this.expire();
    try {
      const parsed = await parseUpload(
        files.map((f) => ({ filename: f.originalname, buffer: f.buffer })),
      );
      const canonical = JSON.stringify(
        parsed.sides,
        Object.keys(parsed.sides).sort(),
      );
      const hash = createHash("sha256").update(canonical).digest("hex");
      const token = randomUUID();
      const sides: Record<string, unknown> = {};
      for (const side of ["followers", "following"] as const) {
        const value = parsed.sides[side];
        if (value)
          sides[side] = {
            count: value.entries.length,
            invalidCount: value.invalidCount,
            duplicateCount: value.duplicateCount,
            files: value.files,
            proposedRemovals: this.service.proposedRemovals(
              ownerId,
              side,
              value.entries.map((e) => e.usernameNormalized),
            ),
          };
      }
      this.previews.set(token, { parsed, hash, created: Date.now(), ownerId });
      return { token, sides, warnings: parsed.warnings };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      throw new HttpException("Invalid upload", 400);
    }
  }

  @Post("imports")
  commit(
    @Body()
    body: {
      token: string;
      coverage?: Record<string, "complete" | "partial">;
      idempotencyToken?: string;
      confirmHistoricalReplay?: boolean;
    },
    @Req() req: PrincipalRequest,
  ) {
    const ownerId = owner(req);
    if (
      !body ||
      typeof body.token !== "string" ||
      (body.idempotencyToken !== undefined &&
        (typeof body.idempotencyToken !== "string" ||
          body.idempotencyToken.length > 200))
    )
      throw new HttpException("Invalid commit request", 400);
    this.expire();
    const p = this.previews.get(body.token);
    if (!p || p.ownerId !== ownerId)
      throw new HttpException("Preview expired or unknown", 410);
    const coverage = body.coverage ?? {};
    for (const [side, value] of Object.entries(coverage))
      if (
        !["followers", "following"].includes(side) ||
        !["complete", "partial"].includes(value)
      )
        throw new HttpException("Invalid coverage selection", 400);
    for (const side of ["followers", "following"] as const) {
      if (
        p.parsed.sides[side] &&
        coverage[side] === "complete" &&
        p.parsed.sides[side]!.invalidCount > 0
      )
        throw new HttpException(
          `${side} has invalid entries; complete coverage rejected`,
          400,
        );
    }
    const result = this.service.commit(ownerId, p, coverage, body);
    this.previews.delete(body.token);
    return result;
  }
  @Get("imports") imports(@Req() req: PrincipalRequest) {
    return this.service.imports(owner(req));
  }
  @Get("imports/:id") importDetail(
    @Req() req: PrincipalRequest,
    @Param("id") id: string,
  ) {
    return this.service.importDetail(owner(req), id);
  }
  @Get("changes") changes(@Req() req: PrincipalRequest) {
    return this.service.changes(owner(req));
  }
  @Get("summary") summary(@Req() req: PrincipalRequest) {
    return this.service.summary(owner(req));
  }
  @Get("relationships") relationships(
    @Req() req: PrincipalRequest,
    @Query() q: Record<string, string>,
  ) {
    if (
      q.view &&
      !["mutual", "not-following-back", "follower-only", "all"].includes(q.view)
    )
      throw new HttpException("Invalid relationship view", 400);
    if (q.order && !["asc", "desc"].includes(q.order))
      throw new HttpException("Invalid sort order", 400);
    if (q.ignored && !["true", "false"].includes(q.ignored))
      throw new HttpException("Invalid ignored filter", 400);
    if (q.includeDeleted && !["true", "false"].includes(q.includeDeleted))
      throw new HttpException("Invalid includeDeleted filter", 400);
    if (
      q.includeKeepFollowing &&
      !["true", "false"].includes(q.includeKeepFollowing)
    )
      throw new HttpException("Invalid includeKeepFollowing filter", 400);
    if (q.manualStatus && !["deleted", "inactive"].includes(q.manualStatus))
      throw new HttpException("Invalid manual status filter", 400);
    if (
      q.page &&
      (!/^\d+$/.test(q.page) || Number(q.page) < 1 || Number(q.page) > 100000)
    )
      throw new HttpException("Invalid page", 400);
    if (q.search && q.search.length > 200)
      throw new HttpException("Search too long", 400);
    if (q.sort && !["username_normalized", "created_at"].includes(q.sort))
      throw new HttpException("Invalid sort field", 400);
    return this.service.relationships(owner(req), q);
  }
  @Get("accounts/:id") account(
    @Req() req: PrincipalRequest,
    @Param("id") id: string,
  ) {
    return this.service.account(owner(req), id);
  }
  @Patch("accounts/:id/preferences") preferences(
    @Req() req: PrincipalRequest,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new HttpException("Invalid preferences", 400);
    for (const key of ["keepFollowing", "ignored"])
      if (body[key] !== undefined && typeof body[key] !== "boolean")
        throw new HttpException(`${key} must be boolean`, 400);
    if (
      body.manualStatus !== undefined &&
      body.manualStatus !== null &&
      !["deleted", "inactive"].includes(String(body.manualStatus))
    )
      throw new HttpException(
        "manualStatus must be deleted, inactive, or null",
        400,
      );
    if (
      body.note !== undefined &&
      body.note !== null &&
      typeof body.note !== "string"
    )
      throw new HttpException("note must be a string", 400);
    if (typeof body.note === "string" && body.note.length > 2000)
      throw new HttpException("note is too long", 400);
    return this.service.preferences(owner(req), id, body);
  }
  private expire() {
    for (const [k, v] of this.previews)
      if (Date.now() - v.created > 15 * 60_000) this.previews.delete(k);
  }
}
