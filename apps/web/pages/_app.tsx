import type { AppProps } from "next/app";
import { AccountScrollProvider } from "../lib/account-scroll";
import "../styles.css";
import "../manual-status.css";
import "../visibility-filter.css";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <AccountScrollProvider>
      <Component {...pageProps} />
    </AccountScrollProvider>
  );
}
