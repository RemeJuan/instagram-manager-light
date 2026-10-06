import { createContext, useContext, useEffect, useRef } from "react";
import { useRouter } from "next/router";

type Bookmark = { listUrl: string; top: number; awaitingRestore: boolean };
type AccountScroll = {
  remember: (listUrl: string) => void;
  position: (listUrl: string) => number | null;
  restored: (listUrl: string) => void;
};

const ScrollContext = createContext<AccountScroll | null>(null);

function sameListQuery(left: string, right: string) {
  const leftParams = new URL(left, window.location.origin).searchParams;
  const rightParams = new URL(right, window.location.origin).searchParams;
  leftParams.sort();
  rightParams.sort();
  return leftParams.toString() === rightParams.toString();
}

// Lives above Pages Router route components, which may remount between list and detail.
// Only keeps position for the exact accounts list that opened the detail drawer.
export function AccountScrollProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const bookmark = useRef<Bookmark | null>(null);

  useEffect(() => {
    const saved = bookmark.current;
    if (!saved || !router.isReady) return;
    if (
      !["/accounts", "/accounts/[id]"].includes(router.pathname) ||
      !sameListQuery(router.asPath, saved.listUrl)
    ) {
      bookmark.current = null;
    } else if (router.pathname === "/accounts/[id]") {
      saved.awaitingRestore = true;
    }
  }, [router.asPath, router.isReady, router.pathname]);

  useEffect(() => {
    if (router.pathname !== "/accounts") return;
    const onScroll = () => {
      if (
        bookmark.current &&
        !bookmark.current.awaitingRestore &&
        sameListQuery(bookmark.current.listUrl, router.asPath)
      ) {
        bookmark.current.top = window.scrollY;
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [router.asPath, router.pathname]);

  const controls = {
    remember: (listUrl: string) => {
      bookmark.current = {
        listUrl,
        top: window.scrollY,
        awaitingRestore: true,
      };
    },
    position: (listUrl: string) =>
      bookmark.current?.listUrl === listUrl && bookmark.current.awaitingRestore
        ? bookmark.current.top
        : null,
    restored: (listUrl: string) => {
      if (bookmark.current?.listUrl === listUrl) {
        bookmark.current.awaitingRestore = false;
      }
    },
  };

  return (
    <ScrollContext.Provider value={controls}>{children}</ScrollContext.Provider>
  );
}

export function useAccountScroll() {
  const context = useContext(ScrollContext);
  if (!context) throw new Error("Account scroll provider missing");
  return context;
}
