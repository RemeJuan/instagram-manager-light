export interface HostedConfig {
  hosted: boolean;
  webOrigin: string | string[];
  databasePath: string;
  port: number | string;
  bindAddress: string;
  lanEnabled: boolean;
  lanIp?: string;
}

function isPrivateIpv4(value: string): boolean {
  if (!require("net").isIPv4(value)) return false;
  const octets = value.split(".").map(Number);
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

export function getHostedConfig(
  env: NodeJS.ProcessEnv = process.env,
): HostedConfig {
  const hosted = env.HOSTED === "true";
  const lanEnabled = env.LOCAL_LAN === "true";
  if (hosted && lanEnabled)
    throw new Error("LOCAL_LAN cannot be enabled when HOSTED=true");
  if (!hosted) {
    const lanIp = env.LOCAL_LAN_IP;
    if (lanEnabled && (!lanIp || !isPrivateIpv4(lanIp)))
      throw new Error(
        "LOCAL_LAN=true requires LOCAL_LAN_IP to be RFC1918 IPv4",
      );
    if (!lanEnabled && lanIp && !isPrivateIpv4(lanIp))
      throw new Error("LOCAL_LAN_IP must be RFC1918 IPv4");
    return {
      hosted: false,
      webOrigin: lanEnabled
        ? [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            `http://${lanIp}:3000`,
          ]
        : "http://localhost:3000",
      databasePath: env.RELATIONSHIP_DB ?? "data/relationships.sqlite",
      port: env.PORT ?? 3001,
      bindAddress: "127.0.0.1",
      lanEnabled,
      ...(lanEnabled ? { lanIp } : {}),
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
    lanEnabled: false,
  };
}
