import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthError, AuthService } from "./auth.service";
import { AUTH_COOKIE, cookieToken } from "./local-request-guard.middleware";
import { getHostedConfig } from "./hosted-config";

const COOKIE = AUTH_COOKIE;
type PrincipalRequest = Request & {
  principal?: { id: string; username: string; role: "admin" | "user" };
};

function authError(error: unknown): never {
  if (!(error instanceof AuthError)) throw error;
  const status =
    error.code === "INVALID_CREDENTIALS"
      ? 401
      : error.code === "RATE_LIMITED"
        ? 429
        : error.code === "INVALID_INPUT"
          ? 400
          : error.code === "FORBIDDEN"
            ? 403
            : 410;
  throw new HttpException(
    { statusCode: status, message: error.message },
    status,
  );
}

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post("login")
  async login(
    @Body() body: any,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      if (!getHostedConfig().hosted) {
        res.setHeader("Cache-Control", "no-store");
        return { user: this.auth.localPrincipal() };
      }
      if (
        !body ||
        typeof body.username !== "string" ||
        typeof body.password !== "string"
      )
        throw new AuthError("Invalid account details", "INVALID_INPUT");
      const result = await this.auth.login(
        body.username,
        body.password,
        req.ip ?? "unknown",
      );
      res.cookie(COOKIE, result.token, {
        httpOnly: true,
        secure: process.env.HOSTED === "true",
        sameSite: "lax",
        path: "/api",
        expires: new Date(result.expiresAt),
      });
      res.setHeader("Cache-Control", "no-store");
      return { user: result.user };
    } catch (error) {
      return authError(error);
    }
  }

  @Post("invitations/redeem")
  async redeem(
    @Body() body: any,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      if (
        !body ||
        typeof body.token !== "string" ||
        typeof body.username !== "string" ||
        typeof body.password !== "string"
      )
        throw new AuthError("Invalid account details", "INVALID_INPUT");
      const user = await this.auth.redeemInvitation(
        body.token,
        body.username,
        body.password,
        req.ip ?? "unknown",
      );
      res.setHeader("Cache-Control", "no-store");
      return { user };
    } catch (error) {
      return authError(error);
    }
  }

  @Get("me")
  me(@Req() req: PrincipalRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("Cache-Control", "no-store");
    return { user: req.principal };
  }

  @Post("logout")
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = cookieToken(req.headers.cookie);
    if (getHostedConfig().hosted && token) this.auth.logout(token);
    res.clearCookie(COOKIE, {
      httpOnly: true,
      secure: process.env.HOSTED === "true",
      sameSite: "lax",
      path: "/api",
    });
    res.setHeader("Cache-Control", "no-store");
    return { ok: true };
  }

  @Get("invitations")
  invitations(
    @Req() req: PrincipalRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "no-store");
    try {
      return this.auth.listInvitationMetadata(req.principal!.id);
    } catch (error) {
      return authError(error);
    }
  }

  @Post("invitations")
  createInvitation(
    @Body() body: any,
    @Req() req: PrincipalRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (
        !body ||
        !Number.isInteger(body.expiresInHours) ||
        body.expiresInHours < 1 ||
        body.expiresInHours > 720
      )
        throw new AuthError("Invalid expiry", "INVALID_INPUT");
      return this.auth.createInvitation(
        req.principal!.id,
        Date.now() + body.expiresInHours * 60 * 60 * 1000,
      );
    } catch (error) {
      return authError(error);
    }
  }
}

@Controller()
export class HealthController {
  @Get("healthz")
  health(@Res({ passthrough: true }) res: Response) {
    res.setHeader("Cache-Control", "no-store");
    return { status: "ok" };
  }
}
