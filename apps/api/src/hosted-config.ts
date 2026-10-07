export interface HostedConfig {
  hosted: boolean;
  webOrigin: string;
  databasePath: string;
  port: number | string;
  bindAddress: string;
}

export function getHostedConfig(
  env: NodeJS.ProcessEnv = process.env,
): HostedConfig {
  const hosted = env.HOSTED === "true";
  if (!hosted) {
    return {
      hosted: false,
      webOrigin: "http://localhost:3000",
      databasePath: env.RELATIONSHIP_DB ?? "data/relationships.sqlite",
      port: env.PORT ?? 3001,
      bindAddress: "127.0.0.1",
    };
  }

  const origin = env.WEB_ORIGIN;
  if (!origin) throw new Error("HOSTED=true requires WEB_ORIGIN");
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("WEB_ORIGIN must be an exact HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== origin ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "WEB_ORIGIN must be an exact HTTPS origin without path, query, hash, or trailing slash",
    );
  }
  const databasePath = env.RELATIONSHIP_DB;
  if (
    !databasePath ||
    databasePath === ":memory:" ||
    !require("path").isAbsolute(databasePath)
  ) {
    throw new Error(
      "HOSTED=true requires RELATIONSHIP_DB to be an absolute file path (not :memory:)",
    );
  }
  return {
    hosted: true,
    webOrigin: origin,
    databasePath,
    port: env.PORT ?? 3001,
    bindAddress: "0.0.0.0",
  };
}
