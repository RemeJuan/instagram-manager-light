import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { describe, it } from "node:test";
import { parseUpload } from "./index.ts";

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const compressed = deflateRawSync(file.data);
    const crc = crc32(file.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, compressed);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const follower = (value: string, timestamp = 1) => ({
  string_list_data: [{ value, timestamp }],
});
const following = (
  value: string,
  href = `https://www.instagram.com/${value}/`,
) => ({ title: value, string_list_data: [{ value, href, timestamp: 2 }] });

describe("parseUpload", () => {
  it("parses every identity value in split follower rows", async () => {
    const parsed = await parseUpload([
      {
        filename: "followers_1.json",
        buffer: json([
          {
            string_list_data: [
              { value: "alpha", timestamp: 1 },
              { value: "beta", timestamp: 2 },
            ],
          },
        ]),
      },
    ]);
    assert.deepEqual(
      parsed.sides.followers?.entries.map((entry) => entry.usernameNormalized),
      ["alpha", "beta"],
    );
    assert.equal(parsed.sides.followers?.invalidCount, 0);
  });

  it("marks conflicting title/value identities and malformed href invalid", async () => {
    const parsed = await parseUpload([
      {
        filename: "following.json",
        buffer: json({
          relationships_following: [
            {
              title: "alpha",
              string_list_data: [
                { value: "beta", href: "https://www.instagram.com/beta/" },
              ],
            },
            following("gamma", "https://example.org/gamma"),
          ],
        }),
      },
    ]);
    assert.equal(parsed.sides.following?.entries.length, 0);
    assert.equal(parsed.sides.following?.invalidCount, 2);
  });

  it("rejects empty and unrecognized ZIPs", async () => {
    await assert.rejects(
      parseUpload([{ filename: "empty.zip", buffer: zip([]) }]),
      /no recognized relationship files/,
    );
    await assert.rejects(
      parseUpload([
        {
          filename: "unknown.zip",
          buffer: zip([{ name: "media/photo.jpg", data: Buffer.from("x") }]),
        },
      ]),
      /no recognized relationship files/,
    );
  });

  it("rejects case-variant duplicate ZIP paths", async () => {
    const archive = zip([
      { name: "relationships/followers.json", data: json([follower("alpha")]) },
      { name: "Relationships/Followers.json", data: json([follower("beta")]) },
    ]);
    await assert.rejects(
      parseUpload([{ filename: "test.zip", buffer: archive }]),
      /Duplicate ZIP path/,
    );
  });

  it("enforces expanded-size budget across ZIP uploads", async () => {
    const block = randomBytes(1024);
    const repeated = Buffer.concat(Array.from({ length: 5_000 }, () => block));
    const archives = Array.from({ length: 41 }, (_, index) => ({
      filename: `part-${index}.zip`,
      buffer: zip([
        { name: "followers.json", data: json([follower(`user${index}`)]) },
        { name: "payload.bin", data: repeated },
      ]),
    }));
    await assert.rejects(parseUpload(archives), /expanded size limit/);
  });

  it("parses synthetic follower and following shapes, timestamps, and duplicates", async () => {
    const result = await parseUpload([
      {
        filename: "followers_1.json",
        buffer: json([follower("@Alpha"), follower("alpha")]),
      },
      {
        filename: "following.json",
        buffer: json({ relationships_following: [following("Beta")] }),
      },
    ]);
    assert.equal(result.sides.followers?.entries.length, 1);
    assert.equal(result.sides.followers?.duplicateCount, 1);
    assert.equal(
      result.sides.followers?.entries[0].usernameNormalized,
      "alpha",
    );
    assert.equal(result.sides.followers?.entries[0].sourceTimestamp, 1);
    assert.equal(
      result.sides.following?.entries[0].profileUrl,
      "https://www.instagram.com/Beta/",
    );
  });

  it("identifies JSON relationship side from content, not filename or archive path", async () => {
    const followerJson = json([follower("alpha")]);
    const followingJson = json({
      relationships_following: [following("beta")],
    });
    const direct = await parseUpload([
      { filename: "opaque.data", buffer: followerJson },
      { filename: "no-extension", buffer: followingJson },
    ]);
    assert.deepEqual(
      direct.sides.followers?.entries.map((entry) => entry.usernameNormalized),
      ["alpha"],
    );
    assert.deepEqual(
      direct.sides.following?.entries.map((entry) => entry.usernameNormalized),
      ["beta"],
    );

    const archive = zip([
      { name: "arbitrary/deep/opaque.bin", data: followerJson },
      { name: "elsewhere/not-following.json", data: followingJson },
      { name: "metadata.json", data: json({ unrelated: true }) },
      { name: "broken.json", data: Buffer.from("{not json") },
    ]);
    const zipped = await parseUpload([
      { filename: "anything.zip", buffer: archive },
    ]);
    assert.deepEqual(
      zipped.sides.followers?.entries.map((entry) => entry.usernameNormalized),
      ["alpha"],
    );
    assert.deepEqual(
      zipped.sides.following?.entries.map((entry) => entry.usernameNormalized),
      ["beta"],
    );
  });

  it("does not assign an ambiguous empty array based on its filename", async () => {
    await assert.rejects(
      parseUpload([{ filename: "followers.json", buffer: json([]) }]),
      /no recognized relationship files/,
    );
  });

  it("rejects unsupported ZIP archives", async () => {
    await assert.rejects(
      parseUpload([
        { filename: "unsupported.zip", buffer: Buffer.from("not a zip") },
      ]),
      /Malformed JSON/,
    );
  });

  it("uses content rather than root filename extension to identify JSON and ZIP", async () => {
    const namedZip = await parseUpload([
      { filename: "followers.zip", buffer: json([follower("alpha")]) },
    ]);
    assert.deepEqual(
      namedZip.sides.followers?.entries.map(
        (entry) => entry.usernameNormalized,
      ),
      ["alpha"],
    );
    const opaqueZip = await parseUpload([
      {
        filename: "opaque.data",
        buffer: zip([
          { name: "arbitrary/place/data.bin", data: json([follower("beta")]) },
        ]),
      },
    ]);
    assert.deepEqual(
      opaqueZip.sides.followers?.entries.map(
        (entry) => entry.usernameNormalized,
      ),
      ["beta"],
    );
  });

  it("accepts Instagram routing href only when a base identity independently matches", async () => {
    const routed = (host: string, identity: string, extras = "") =>
      `https://${host}/_u/${identity}${extras}`;
    const result = await parseUpload([
      {
        filename: "opaque-name",
        buffer: json({
          relationships_following: [
            {
              title: "alpha",
              string_list_data: [
                { href: routed("sub.instagram.com", "alpha"), timestamp: 2 },
              ],
            },
          ],
        }),
      },
    ]);
    assert.equal(
      result.sides.following?.entries[0].usernameNormalized,
      "alpha",
    );
    assert.equal(
      result.sides.following?.entries[0].profileUrl,
      "https://www.instagram.com/alpha/",
    );

    for (const [index, href] of [
      routed("sub.instagram.com", "beta"),
      routed("sub.instagram.com", "alpha", "?x=y"),
      routed("sub.instagram.com", "alpha", "#fragment"),
      "https://user@sub.instagram.com/_u/alpha",
      "http://sub.instagram.com/_u/alpha",
      "https://sub.instagram.com/_u/alpha/extra",
      routed("sub.instagram.com", "%2Falpha"),
    ].entries()) {
      const rejected = await parseUpload([
        {
          filename: "opaque-name",
          buffer: json({
            relationships_following: [
              { title: "alpha", string_list_data: [{ href }] },
            ],
          }),
        },
      ]);
      assert.equal(
        rejected.sides.following?.invalidCount,
        1,
        `invalid routing case ${index}`,
      );
      assert.equal(rejected.sides.following?.entries.length, 0);
    }
    const unknownHost = await parseUpload([
      {
        filename: "opaque-name",
        buffer: json({
          relationships_following: [
            {
              title: "alpha",
              string_list_data: [{ href: routed("routing.example", "alpha") }],
            },
          ],
        }),
      },
    ]);
    assert.equal(unknownHost.sides.following?.invalidCount, 1);
    const noIdentity = await parseUpload([
      {
        filename: "opaque-name",
        buffer: json({
          relationships_following: [
            {
              title: "",
              string_list_data: [
                { href: routed("sub.instagram.com", "alpha") },
              ],
            },
          ],
        }),
      },
    ]);
    assert.equal(noIdentity.sides.following?.entries.length, 1);
    assert.equal(noIdentity.sides.following?.invalidCount, 0);
    const routedMismatch = await parseUpload([
      {
        filename: "opaque-name",
        buffer: json({
          relationships_following: [
            {
              title: "beta",
              string_list_data: [
                { href: routed("sub.instagram.com", "alpha") },
              ],
            },
          ],
        }),
      },
    ]);
    assert.equal(routedMismatch.sides.following?.invalidCount, 1);
  });

  it("recognizes explicit corrupted relationship wrappers but not arbitrary metadata", async () => {
    const corrupted = await parseUpload([
      {
        filename: "opaque",
        buffer: json({
          relationships_following: [
            { title: "bad identity", string_list_data: [] },
          ],
        }),
      },
    ]);
    assert.equal(corrupted.sides.following?.invalidCount, 1);
    await assert.rejects(
      parseUpload([
        {
          filename: "opaque",
          buffer: json({ unrelated: [{ string_list_data: [] }] }),
        },
      ]),
      /no recognized relationship files/,
    );
    await assert.rejects(
      parseUpload([{ filename: "opaque", buffer: json([]) }]),
      /no recognized relationship files/,
    );
    await assert.rejects(
      parseUpload([
        { filename: "opaque", buffer: json([{}, { string_list_data: [] }]) },
      ]),
      /no recognized relationship files/,
    );
    const keyed = await parseUpload([
      {
        filename: "opaque",
        buffer: json({ followers_1: [{ string_list_data: [] }] }),
      },
    ]);
    assert.equal(keyed.sides.followers?.invalidCount, 1);
  });

  it("accepts following value identity with empty title and rejects malformed or conflicting identities", async () => {
    const href = "https://www.instagram.com/alpha/";
    const accepted = await parseUpload([
      {
        filename: "opaque",
        buffer: json({
          relationships_following: [
            { title: "", string_list_data: [{ value: "alpha", href }] },
          ],
        }),
      },
    ]);
    assert.deepEqual(
      accepted.sides.following?.entries.map(
        (entry) => entry.usernameNormalized,
      ),
      ["alpha"],
    );
    assert.equal(accepted.sides.following?.invalidCount, 0);

    const malformed = await parseUpload([
      {
        filename: "opaque",
        buffer: json({
          relationships_following: [
            { title: "bad name", string_list_data: [{ value: "alpha", href }] },
          ],
        }),
      },
    ]);
    assert.equal(malformed.sides.following?.entries.length, 0);
    assert.equal(malformed.sides.following?.invalidCount, 1);

    const conflicting = await parseUpload([
      {
        filename: "opaque",
        buffer: json({
          relationships_following: [
            { title: "", string_list_data: [{ value: "beta", href }] },
          ],
        }),
      },
    ]);
    assert.equal(conflicting.sides.following?.entries.length, 0);
    assert.equal(conflicting.sides.following?.invalidCount, 1);
  });
});
