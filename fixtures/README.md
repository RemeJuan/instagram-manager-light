# Synthetic Instagram export fixtures

Generate deterministic, synthetic JSON fixtures with Node.js builtins only:

```sh
node fixtures/generate.mjs
```

Outputs are written to `fixtures/instagram-export/`. Generator checks complete relationship totals before writing: 810 following, 783 followers, 747 mutuals, 63 following-only, and 36 follower-only. Followers split across two files; following uses the `relationships_following` wrapper shape. Records include timestamps.

Additional inputs cover a partial follower snapshot, duplicate entries, username case variation, and malformed JSON. All usernames and timestamps are synthetic. No supplied archive or personal export is read.
