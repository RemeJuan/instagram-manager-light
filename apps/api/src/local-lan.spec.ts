import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { getHostedConfig } from "./hosted-config";
import { LocalRequestGuardMiddleware } from "./local-request-guard.middleware";

describe("opt-in local LAN configuration", () => {
  it("requires RFC1918 IPv4 only when enabled and retains loopback binding", () => {
    for (const ip of [
      "",
      "127.0.0.1",
      "169.254.1.1",
      "8.8.8.8",
      "192.168.1.256",
      "::1",
    ]) {
      assert.throws(
        () => getHostedConfig({ LOCAL_LAN: "true", LOCAL_LAN_IP: ip }),
        /RFC1918/,
      );
    }
    const config = getHostedConfig({
      LOCAL_LAN: "true",
      LOCAL_LAN_IP: "192.168.1.20",
    });
    assert.deepEqual(config.webOrigin, [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://192.168.1.20:3000",
    ]);
    assert.equal(config.bindAddress, "127.0.0.1");
    assert.throws(
      () =>
        getHostedConfig({
          HOSTED: "true",
          WEB_ORIGIN: "https://web.example",
          RELATIONSHIP_DB: "/tmp/auth.sqlite",
          LOCAL_LAN: "true",
          LOCAL_LAN_IP: "192.168.1.20",
        }),
      /cannot be enabled/,
    );
  });

  it("only accepts exact LAN-origin forwarded hosts from loopback proxy", () => {
    const config = getHostedConfig({
      LOCAL_LAN: "true",
      LOCAL_LAN_IP: "192.168.1.20",
    });
    const middleware = new LocalRequestGuardMiddleware(
      { localPrincipal: () => ({ id: "local", role: "admin" }) } as any,
      config,
    );
    const run = (options: {
      host?: string;
      origin?: string;
      remote?: string;
      method?: string;
      fetchSite?: string;
    }) => {
      let status = 200;
      let continued = false;
      const req = {
        method: options.method ?? "GET",
        path: "/summary",
        headers: {
          host: options.host,
          ...(options.origin ? { origin: options.origin } : {}),
          ...(options.fetchSite ? { "sec-fetch-site": options.fetchSite } : {}),
        },
        socket: {
          localPort: 45678,
          remoteAddress: options.remote ?? "127.0.0.1",
        },
      } as unknown as Request;
      const res = {
        status(code: number) {
          status = code;
          return this;
        },
        json() {
          return this;
        },
      } as unknown as Response;
      middleware.use(req, res, (() => {
        continued = true;
      }) as NextFunction);
      return { status, continued };
    };
    assert.deepEqual(
      run({ host: "192.168.1.20:3000", origin: "http://192.168.1.20:3000" }),
      { status: 200, continued: true },
    );
    assert.deepEqual(
      run({
        host: "192.168.1.20:3000",
        origin: "http://192.168.1.20:3000",
        method: "POST",
        fetchSite: "same-origin",
      }),
      { status: 200, continued: true },
    );
    assert.deepEqual(
      run({ host: "localhost:45678", origin: "http://localhost:3000" }),
      { status: 200, continued: true },
    );
    assert.deepEqual(
      run({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }),
      { status: 200, continued: true },
    );
    assert.deepEqual(
      run({ host: "192.168.1.20:3000", origin: "https://evil.example" }),
      { status: 403, continued: false },
    );
    assert.deepEqual(
      run({
        host: "192.168.1.20:3000",
        origin: "http://192.168.1.20:3000",
        remote: "203.0.113.7",
      }),
      { status: 403, continued: false },
    );
    assert.deepEqual(
      run({ host: "192.168.1.20:3001", origin: "http://192.168.1.20:3000" }),
      { status: 403, continued: false },
    );
    assert.deepEqual(
      run({ host: "evil.example:45678", origin: "http://localhost:3000" }),
      { status: 403, continued: false },
    );
  });
});
