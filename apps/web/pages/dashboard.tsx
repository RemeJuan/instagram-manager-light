import { useEffect } from "react";
import { useRouter } from "next/router";
import { hosted } from "../lib/auth";
import { Workspace } from "./index";

export default function Dashboard() {
  const router = useRouter();
  useEffect(() => {
    if (!hosted) void router.replace("/");
  }, [router]);
  return hosted ? <Workspace /> : null;
}
