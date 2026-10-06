import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, "instagram-export");
const generatedAt = "2025-01-15T12:00:00.000Z";

function username(prefix, index) {
  return `${prefix}_${String(index).padStart(3, "0")}`;
}

function record(value, index, timestamp = generatedAt) {
  return {
    title: "",
    string_list_data: [
      {
        href: `https://www.instagram.com/${value}/`,
        value,
        timestamp: Date.parse(timestamp) / 1000 + index,
      },
    ],
  };
}

const following = Array.from({ length: 810 }, (_, index) => ({
  title: "",
  media_list_data: [],
  string_list_data: [
    {
      href: `https://www.instagram.com/${username("following", index + 1)}/`,
      value: username("following", index + 1),
      timestamp: Date.parse(generatedAt) / 1000 + index,
    },
  ],
}));

const followers = [
  ...Array.from({ length: 747 }, (_, index) =>
    record(username("following", index + 1), index),
  ),
  ...Array.from({ length: 36 }, (_, index) =>
    record(username("follower_only", index + 1), index + 747),
  ),
];

const partialFollowers = followers.slice(0, 120);
const duplicateFollowers = [followers[0], followers[0], followers[1]];
const caseVariantFollowers = [record(username("Following", 1), 0)];

const files = new Map([
  ["followers_1.json", followers.slice(0, 400)],
  ["followers_2.json", followers.slice(400)],
  ["following.json", { relationships_following: following }],
  ["partial-followers.json", partialFollowers],
  ["duplicate-followers.json", duplicateFollowers],
  ["case-variant-followers.json", caseVariantFollowers],
]);

const mutuals = new Set(
  followers.map((entry) => entry.string_list_data[0].value),
);
const followingNames = new Set(
  following.map((entry) => entry.string_list_data[0].value),
);
const followBackCount = [...followingNames].filter((value) =>
  mutuals.has(value),
).length;
const followerOnlyCount = [...mutuals].filter(
  (value) => !followingNames.has(value),
).length;
if (
  following.length !== 810 ||
  followers.length !== 783 ||
  followBackCount !== 747 ||
  following.length - followBackCount !== 63 ||
  followerOnlyCount !== 36
) {
  throw new Error("Synthetic fixture aggregate validation failed");
}

await mkdir(output, { recursive: true });
for (const [name, contents] of files) {
  await writeFile(join(output, name), `${JSON.stringify(contents, null, 2)}\n`);
}
await writeFile(
  join(output, "malformed.json"),
  '{"relationships_following": [\n',
);
console.log(`Generated validated synthetic fixtures in ${output}`);
