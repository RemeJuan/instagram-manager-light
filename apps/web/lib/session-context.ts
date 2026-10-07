import { createContext, useContext } from "react";
import type { SessionUser } from "./api";

export const SessionContext = createContext<SessionUser | null>(null);
export const useHostedSession = () => useContext(SessionContext);
