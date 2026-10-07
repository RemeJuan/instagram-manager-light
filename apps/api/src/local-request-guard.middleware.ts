import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { getHostedConfig } from "./hosted-config";
import { AuthService } from "./auth.service";

export const AUTH_COOKIE = "relationship_session";

export function cookieToken(header: string | undefined): string | null {
  if (!header) return null;
  if (header.length > 8192) return null;
  let found: string | null = null;
  for (const pair of header.split(";")) {
    const part = pair.trim();
    const equals = part.indexOf("=");
    if (equals <= 0) return null;
    const key = part.slice(0, equals).trim();
    const value = part.slice(equals + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n;]/.test(value))
      return null;
    if (key === AUTH_COOKIE) {
      if (found !== null || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
      found = value;
    }
  }
  return found;
}

@Injectable()
export class LocalRequestGuardMiddleware implements NestMiddleware {
  constructor(
    private readonly auth = new AuthService(),
    private readonly config = getHostedConfig(),
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const config = this.config;
    const localPort = req.socket.localPort;
    const host = req.headers.host;
    if (!config.hosted) {
      const [hostname, port, extra] = (host ?? "").toLowerCase().split(":");
      if (
        !host ||
        extra !== undefined ||
        !["localhost", "127.0.0.1"].includes(hostname) ||
        port !== String(localPort)
      ) {
        res.status(403).json({ statusCode: 403, message: "Forbidden" });
        return;
      }
    } else if (!host || /[\s/@?#]/.test(host)) {
      res.status(403).json({ statusCode: 403, message: "Forbidden" });
      return;
    }

    const unsafe = ["POST", "PATCH", "PUT", "DELETE"].includes(
      req.method.toUpperCase(),
    );
    if (config.hosted && unsafe && req.headers.origin !== config.webOrigin) {
      res.status(403).json({ statusCode: 403, message: "Forbidden" });
      return;
    }
    if (unsafe && !config.hosted) {
      const origin = req.headers.origin;
      if (origin !== undefined) {
        if (origin !== config.webOrigin) {
          res.status(403).json({ statusCode: 403, message: "Forbidden" });
          return;
        }
      } else if (
        ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"].some(
          (name) => req.headers[name] !== undefined,
        )
      ) {
        res.status(403).json({ statusCode: 403, message: "Forbidden" });
        return;
      }
    }
    if (req.path === "/healthz" && req.method === "GET") {
      next();
      return;
    }
    const publicAuth =
      req.path === "/auth/login" || req.path === "/auth/invitations/redeem";
    const localPrincipal = this.auth.localPrincipal();
    if (!config.hosted) {
      (req as Request & { principal?: unknown }).principal = localPrincipal;
      next();
      return;
    }
    if (publicAuth) {
      next();
      return;
    }
    const token = cookieToken(req.headers.cookie);
    const principal = token ? this.auth.authenticateSession(token) : null;
    if (!principal) {
      res.status(401).json({ statusCode: 401, message: "Unauthorized" });
      return;
    }
    (req as Request & { principal?: unknown }).principal = principal;
    next();
  }
}
