import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { getHostedConfig } from "./hosted-config";

@Injectable()
export class LocalRequestGuardMiddleware implements NestMiddleware {
  constructor(private readonly config = getHostedConfig()) {}

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

    if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method.toUpperCase())) {
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
    next();
  }
}
