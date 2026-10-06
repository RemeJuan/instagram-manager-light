import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { request as httpRequest } from "node:http";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

describe("HTTP import integration", () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let origin: string;
  before(async () => {
    process.env.RELATIONSHIP_DB = ":memory:";
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    if (!address || typeof address === "string")
      throw new Error("No ephemeral HTTP port");
    origin = `http://127.0.0.1:${address.port}`;
  });
  after(async () => {
    await app.close();
    delete process.env.RELATIONSHIP_DB;
  });

  const fixture = async (name: string) =>
    readFile(resolve(process.cwd(), "fixtures/instagram-export", name));
  const preview = async (
    files: Array<[string, Buffer]>,
    headers: Record<string, string> = { Origin: "http://localhost:3000" },
  ) => {
    const form = new FormData();
    for (const [name, buffer] of files)
      form.append("files", new Blob([buffer]), name);
    const response = await fetch(`${origin}/imports/preview`, {
      method: "POST",
      body: form,
      headers,
    });
    return {
      response,
      body: (await response.json()) as {
        token: string;
        sides: Record<string, { count: number; invalidCount: number }>;
        warnings: string[];
      },
    };
  };
  const commit = async (
    token: string,
    coverage: Record<string, "complete" | "partial">,
    headers: Record<string, string> = { Origin: "http://localhost:3000" },
    confirmHistoricalReplay = false,
  ) =>
    fetch(`${origin}/imports`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ token, coverage, confirmHistoricalReplay }),
    });
  const rawRequest = async (
    path: string,
    method: string,
    body: Buffer,
    headers: Record<string, string>,
  ) =>
    new Promise<{ status: number; body: Buffer }>((resolveRequest, reject) => {
      const address = new URL(origin);
      const req = httpRequest(
        {
          hostname: address.hostname,
          port: address.port,
          path,
          method,
          headers: {
            Host: address.host,
            ...(body.length ? { "Content-Length": body.length } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () =>
            resolveRequest({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  const rawPost = (
    path: string,
    body: Buffer,
    headers: Record<string, string>,
  ) => rawRequest(path, "POST", body, headers);
  const rawPreview = async (files: Array<[string, Buffer]>) => {
    const form = new FormData();
    for (const [name, buffer] of files)
      form.append("files", new Blob([buffer]), name);
    const request = new Request(`${origin}/imports/preview`, {
      method: "POST",
      body: form,
    });
    const body = Buffer.from(await request.arrayBuffer());
    return rawPost("/imports/preview", body, {
      "Content-Type": request.headers.get("content-type")!,
    });
  };

  it("previews and commits complete synthetic sides; supports filtered paging, history, details, exact replay", async () => {
    const p = await preview([
      ["followers_1.json", await fixture("followers_1.json")],
      ["followers_2.json", await fixture("followers_2.json")],
      ["following.json", await fixture("following.json")],
    ]);
    assert.equal(p.response.status, 201, JSON.stringify(p.body));
    assert.equal(p.body.sides.followers.count, 783);
    assert.equal(p.body.sides.following.count, 810);
    const committed = await commit(p.body.token, {
      followers: "complete",
      following: "complete",
    });
    assert.equal(committed.status, 201);
    const result = (await committed.json()) as { id: string };
    const summary = (await (await fetch(`${origin}/summary`)).json()) as Record<
      string,
      number
    >;
    assert.equal(summary.notFollowingBack, 63);
    assert.equal(summary.followerOnly, 36);
    assert.equal(summary.mutual, 747);
    const unfollowers = (await (
      await fetch(`${origin}/relationships?view=not-following-back&page=1`)
    ).json()) as { total: number; items: unknown[] };
    assert.equal(unfollowers.total, 63);
    assert.equal(unfollowers.items.length, 63);
    const page2 = (await (
      await fetch(`${origin}/relationships?view=not-following-back&page=2`)
    ).json()) as { total: number; items: unknown[] };
    assert.equal(page2.total, 63);
    assert.equal(page2.items.length, 0);
    const imports = (await (await fetch(`${origin}/imports`)).json()) as Array<{
      id: string;
      sides: Array<{ side: string; coverage: string }>;
    }>;
    assert.equal(imports.length, 1);
    assert.equal(imports[0].sides.length, 2);
    const detail = (await (
      await fetch(
        `${origin}/accounts/${(unfollowers.items[0] as { id: string }).id}`,
      )
    ).json()) as Record<string, unknown>;
    assert.equal(detail.following_present, true);
    const replayPreview = await preview([
      ["followers_1.json", await fixture("followers_1.json")],
      ["followers_2.json", await fixture("followers_2.json")],
      ["following.json", await fixture("following.json")],
    ]);
    const replay = await commit(replayPreview.body.token, {
      followers: "complete",
      following: "complete",
    });
    assert.equal(replay.status, 201);
    assert.deepEqual(await replay.json(), { id: result.id, idempotent: true });
    assert.equal(
      ((await (await fetch(`${origin}/imports`)).json()) as unknown[]).length,
      1,
    );
  });

  it("rejects malformed input and invalid complete coverage without state mutation", async () => {
    const malformed = await preview([
      ["malformed.json", await fixture("malformed.json")],
    ]);
    assert.equal(malformed.response.status, 400);
    const before = (await (
      await fetch(`${origin}/imports`)
    ).json()) as unknown[];
    assert.equal(before.length, 1);
    const invalid = await preview([
      [
        "upload.json",
        Buffer.from(
          JSON.stringify({ followers_99: [{ string_list_data: [] }] }),
        ),
      ],
    ]);
    assert.equal(invalid.response.status, 201);
    assert.ok(invalid.body.sides.followers.invalidCount > 0);
    const rejected = await commit(invalid.body.token, {
      followers: "complete",
    });
    assert.equal(rejected.status, 400);
    assert.equal(
      ((await (await fetch(`${origin}/imports`)).json()) as unknown[]).length,
      1,
    );
  });

  it("updates manual statuses through partial preferences and keeps them through imports", async () => {
    const response = await fetch(`${origin}/relationships?ignored=true`);
    const initial = (await response.json()) as {
      items: Array<{ id: string; username_normalized: string }>;
    };
    const alice = initial.items[0];
    const bob = initial.items[1];
    const patch = async (id: string, body: Record<string, unknown>) =>
      fetch(`${origin}/accounts/${id}/preferences`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify(body),
      });
    assert.equal(
      (
        await patch(alice.id, {
          manualStatus: "deleted",
          keepFollowing: true,
          ignored: true,
          note: "retain",
        })
      ).status,
      200,
    );
    assert.equal(
      (await patch(bob.id, { manualStatus: "inactive" })).status,
      200,
    );
    assert.equal(
      (await patch(alice.id, { manualStatus: "invalid" })).status,
      400,
    );
    const visibleByDefault = (await (
      await fetch(`${origin}/relationships?ignored=true`)
    ).json()) as { total: number; items: Array<{ id: string }> };
    assert.ok(!visibleByDefault.items.some((item) => item.id === alice.id));
    const included = (await (
      await fetch(
        `${origin}/relationships?manualStatus=deleted&includeDeleted=true&includeKeepFollowing=true&ignored=true`,
      )
    ).json()) as { items: Array<{ id: string }> };
    assert.ok(included.items.some((item) => item.id === alice.id));
    const invalidInclude = await fetch(
      `${origin}/relationships?includeDeleted=yes`,
    );
    assert.equal(invalidInclude.status, 400);
    const keepFollowingId = bob.id;
    assert.equal(
      (await patch(keepFollowingId, { keepFollowing: true })).status,
      200,
    );
    const excludedKeepFollowing = (await (
      await fetch(`${origin}/relationships?ignored=true`)
    ).json()) as { items: Array<{ id: string }> };
    assert.ok(!excludedKeepFollowing.items.some((item) => item.id === bob.id));
    const includeKeepFollowing = (await (
      await fetch(
        `${origin}/relationships?includeDeleted=true&includeKeepFollowing=true&ignored=true`,
      )
    ).json()) as { items: Array<{ id: string }> };
    assert.ok(includeKeepFollowing.items.some((item) => item.id === bob.id));
    const bothIncluded = (await (
      await fetch(
        `${origin}/relationships?includeDeleted=true&includeKeepFollowing=true&ignored=true`,
      )
    ).json()) as { items: Array<{ id: string }> };
    assert.ok(bothIncluded.items.some((item) => item.id === alice.id));
    assert.equal(
      (await fetch(`${origin}/relationships?includeKeepFollowing=maybe`))
        .status,
      400,
    );
    assert.equal((await patch(bob.id, { keepFollowing: false })).status, 200);
    assert.equal(
      (await patch("unknown-account", { manualStatus: "deleted" })).status,
      404,
    );
    const aliceAfter = (await (
      await fetch(`${origin}/accounts/${alice.id}`)
    ).json()) as Record<string, unknown>;
    assert.equal(aliceAfter.manual_status, "deleted");
    assert.equal(aliceAfter.keep_following, 1);
    assert.equal(aliceAfter.ignored, 1);
    assert.equal(aliceAfter.note, "retain");
    assert.equal(
      (
        (await (await fetch(`${origin}/accounts/${bob.id}`)).json()) as Record<
          string,
          unknown
        >
      ).manual_status,
      "inactive",
    );
    assert.equal(
      (await patch(alice.id, { manualStatus: null, keepFollowing: false }))
        .status,
      200,
    );
    const visibleAfterClear = (await (
      await fetch(`${origin}/relationships?ignored=true`)
    ).json()) as { items: Array<{ id: string }> };
    assert.ok(visibleAfterClear.items.some((item) => item.id === alice.id));
    assert.equal(
      (
        (await (
          await fetch(`${origin}/accounts/${alice.id}`)
        ).json()) as Record<string, unknown>
      ).manual_status,
      null,
    );
    const listed = (await (
      await fetch(`${origin}/relationships?manualStatus=inactive&ignored=true`)
    ).json()) as { items: Array<Record<string, unknown>> };
    assert.ok(listed.items.some((item) => item.id === bob.id));
  });

  it("enforces loopback Host and browser Origin/Fetch Metadata on mutation routes", async () => {
    const current = (await (await fetch(`${origin}/relationships`)).json()) as {
      items: Array<{ id: string }>;
    };
    const accountId = current.items[0].id;
    const payload = [
      ["followers_1.json", await fixture("followers_1.json")],
    ] as Array<[string, Buffer]>;
    const allowed = await preview(payload, { Origin: "http://localhost:3000" });
    assert.equal(allowed.response.status, 201);
    const allowedCommit = await commit(
      allowed.body.token,
      { followers: "partial" },
      { Origin: "http://localhost:3000" },
      true,
    );
    assert.equal(allowedCommit.status, 201);
    const noTimestamp = Buffer.from(
      JSON.stringify([
        {
          string_list_data: [
            { value: "cli_only", href: "https://www.instagram.com/cli_only/" },
          ],
        },
      ]),
    );
    const noOrigin = await rawPreview([["followers_99.json", noTimestamp]]);
    assert.equal(noOrigin.status, 201);
    const noOriginToken = (
      JSON.parse(noOrigin.body.toString()) as { token: string }
    ).token;
    const noOriginCommit = await rawPost(
      "/imports",
      Buffer.from(
        JSON.stringify({
          token: noOriginToken,
          coverage: { followers: "partial" },
        }),
      ),
      { "Content-Type": "application/json" },
    );
    assert.equal(noOriginCommit.status, 201, noOriginCommit.body.toString());
    const before = (await (
      await fetch(`${origin}/imports`)
    ).json()) as unknown[];
    for (const value of ["https://evil.example", "null"]) {
      const blocked = await preview(payload, { Origin: value });
      assert.equal(blocked.response.status, 403);
    }
    assert.equal(
      (
        await commit(
          noOriginToken,
          { followers: "partial" },
          { Origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${origin}/accounts/${accountId}/preferences`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            Origin: "https://evil.example",
          },
          body: JSON.stringify({ ignored: true }),
        })
      ).status,
      403,
    );
    const fetchToken = (
      await preview([
        ["partial-followers.json", await fixture("partial-followers.json")],
      ])
    ).body.token;
    const fetchBlocked = await rawPost(
      "/imports",
      Buffer.from(
        JSON.stringify({
          token: fetchToken,
          coverage: { followers: "partial" },
        }),
      ),
      { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
    );
    assert.equal(fetchBlocked.status, 403);
    const actualHost = new URL(origin).host;
    assert.equal(
      (
        await fetch(`${origin}/imports`, {
          headers: { Host: `localhost:${actualHost.split(":").at(-1)}` },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await rawRequest("/imports", "GET", Buffer.alloc(0), {
          Host: "evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await rawRequest("/imports/preview", "POST", Buffer.from("{}"), {
          Host: "evil.example",
          "content-type": "application/json",
        })
      ).status,
      403,
    );
    assert.equal(
      ((await (await fetch(`${origin}/imports`)).json()) as unknown[]).length,
      before.length,
    );
  });
});
