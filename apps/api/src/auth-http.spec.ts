import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { AuthService } from "./auth.service";

describe("hosted auth HTTP", () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let root: string;
  let origin: string;
  const webOrigin = "https://web.example";
  const password = "secure-password-for-tests";

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "auth-http-"));
    process.env.HOSTED = "true";
    process.env.WEB_ORIGIN = webOrigin;
    process.env.RELATIONSHIP_DB = join(root, "hosted.sqlite");
    app = await NestFactory.create(AppModule, { logger: ["error"] });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    if (!address || typeof address === "string")
      throw new Error("No HTTP listener");
    origin = `http://127.0.0.1:${address.port}`;
    await app.get(AuthService).bootstrapAdmin("admin", password);
  });
  after(async () => {
    await app.close();
    delete process.env.HOSTED;
    delete process.env.WEB_ORIGIN;
    delete process.env.RELATIONSHIP_DB;
    rmSync(root, { recursive: true, force: true });
  });

  it("requires authentication, validates Origin, cookies, and invite permissions", async () => {
    for (const [path, init] of [
      ["/imports", {}],
      ["/imports/example", {}],
      ["/changes", {}],
      ["/summary", {}],
      ["/relationships", {}],
      ["/accounts/example", {}],
      ["/imports/preview", { method: "POST", headers: { Origin: webOrigin } }],
      [
        "/imports",
        {
          method: "POST",
          headers: { Origin: webOrigin, "Content-Type": "application/json" },
          body: "{}",
        },
      ],
      [
        "/accounts/example/preferences",
        {
          method: "PATCH",
          headers: { Origin: webOrigin, "Content-Type": "application/json" },
          body: "{}",
        },
      ],
    ] as Array<[string, RequestInit]>)
      assert.equal((await fetch(`${origin}${path}`, init)).status, 401, path);
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
    const noOrigin = await fetch(`${origin}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password }),
    });
    assert.equal(noOrigin.status, 403);
    const evil = await fetch(`${origin}/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ username: "admin", password }),
    });
    assert.equal(evil.status, 403);

    const login = await fetch(`${origin}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: webOrigin },
      body: JSON.stringify({ username: "admin", password }),
    });
    assert.equal(login.status, 201);
    assert.equal(login.headers.get("cache-control"), "no-store");
    const setCookie = login.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\/api/i);
    const cookie = setCookie.split(";")[0];
    const me = await fetch(`${origin}/auth/me`, {
      headers: { Cookie: cookie },
    });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), {
      user: {
        id: (
          (await (
            await fetch(`${origin}/auth/me`, { headers: { Cookie: cookie } })
          ).json()) as any
        ).user.id,
        username: "admin",
        role: "admin",
      },
    });

    const inviteResponse = await fetch(`${origin}/auth/invitations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: webOrigin,
        Cookie: cookie,
      },
      body: JSON.stringify({ expiresInHours: 2 }),
    });
    assert.equal(inviteResponse.status, 201);
    const invite = (await inviteResponse.json()) as { token: string };
    const redemption = await fetch(`${origin}/auth/invitations/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: webOrigin },
      body: JSON.stringify({
        token: invite.token,
        username: "member",
        password,
      }),
    });
    assert.equal(redemption.status, 201);
    const reused = await fetch(`${origin}/auth/invitations/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: webOrigin },
      body: JSON.stringify({
        token: invite.token,
        username: "member2",
        password,
      }),
    });
    assert.equal(reused.status, 410);
    const userLogin = await fetch(`${origin}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: webOrigin },
      body: JSON.stringify({ username: "member", password }),
    });
    const userCookie = (userLogin.headers.get("set-cookie") ?? "").split(
      ";",
    )[0];
    const forbidden = await fetch(`${origin}/auth/invitations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: webOrigin,
        Cookie: userCookie,
      },
      body: JSON.stringify({ expiresInHours: 2 }),
    });
    assert.equal(forbidden.status, 403);

    const fixture = await readFile(
      resolve(process.cwd(), "fixtures/instagram-export/followers_1.json"),
    );
    const previewFor = async (
      sessionCookie: string,
      filename = "followers_1.json",
    ) => {
      const content = await readFile(
        resolve(process.cwd(), `fixtures/instagram-export/${filename}`),
      );
      const form = new FormData();
      form.append("files", new Blob([content]), filename);
      const response = await fetch(`${origin}/imports/preview`, {
        method: "POST",
        headers: { Origin: webOrigin, Cookie: sessionCookie },
        body: form,
      });
      assert.equal(response.status, 201);
      return (await response.json()) as { token: string };
    };
    const adminPreview = await previewFor(cookie);
    const foreignCommit = await fetch(`${origin}/imports`, {
      method: "POST",
      headers: {
        Origin: webOrigin,
        Cookie: userCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token: adminPreview.token,
        coverage: { followers: "partial" },
      }),
    });
    assert.equal(foreignCommit.status, 410);
    const commitFor = (sessionCookie: string, token: string) =>
      fetch(`${origin}/imports`, {
        method: "POST",
        headers: {
          Origin: webOrigin,
          Cookie: sessionCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token,
          coverage: { followers: "complete" },
          idempotencyToken: "same-client-token",
        }),
      });
    const adminCommit = await commitFor(cookie, adminPreview.token);
    assert.equal(adminCommit.status, 201);
    const adminReplayPreview = await previewFor(cookie);
    const adminReplay = await commitFor(cookie, adminReplayPreview.token);
    assert.equal(adminReplay.status, 201);
    assert.equal(
      ((await adminReplay.json()) as { id: string }).id,
      ((await adminCommit.json()) as { id: string }).id,
    );
    const memberPreview = await previewFor(
      userCookie,
      "partial-followers.json",
    );
    const memberCommit = await commitFor(userCookie, memberPreview.token);
    assert.equal(memberCommit.status, 201);
    const adminImports = (await (
      await fetch(`${origin}/imports`, { headers: { Cookie: cookie } })
    ).json()) as Array<{ id: string }>;
    const memberImports = (await (
      await fetch(`${origin}/imports`, { headers: { Cookie: userCookie } })
    ).json()) as Array<{ id: string }>;
    assert.equal(adminImports.length, 1);
    assert.equal(memberImports.length, 1);
    assert.notEqual(adminImports[0].id, memberImports[0].id);
    const adminRelations = (await (
      await fetch(`${origin}/relationships`, { headers: { Cookie: cookie } })
    ).json()) as { total?: number; items?: unknown[] };
    const memberRelations = (await (
      await fetch(`${origin}/relationships`, {
        headers: { Cookie: userCookie },
      })
    ).json()) as { total?: number; items?: unknown[] };
    assert.notEqual(
      adminRelations.total ?? adminRelations.items?.length,
      memberRelations.total ?? memberRelations.items?.length,
    );
    assert.equal(
      (
        await fetch(`${origin}/imports/${adminImports[0].id}`, {
          headers: { Cookie: userCookie },
        })
      ).status,
      404,
    );
    const adminAccounts = (await (
      await fetch(`${origin}/relationships`, { headers: { Cookie: cookie } })
    ).json()) as { items?: Array<{ id: string }> };
    if (adminAccounts.items?.[0])
      assert.equal(
        (
          await fetch(`${origin}/accounts/${adminAccounts.items[0].id}`, {
            headers: { Cookie: userCookie },
          })
        ).status,
        404,
      );

    const logout = await fetch(`${origin}/auth/logout`, {
      method: "POST",
      headers: { Origin: webOrigin, Cookie: cookie },
    });
    assert.equal(logout.status, 201);
    assert.equal(
      (await fetch(`${origin}/auth/me`, { headers: { Cookie: cookie } }))
        .status,
      401,
    );
  });
});
