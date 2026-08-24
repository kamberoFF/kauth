/**
 * Dev/test support, not part of the public API surface (absent from
 * package.json exports). Renders the session hook through React's own
 * runtime so integration tests can execute `useSyncExternalStore` for real
 * instead of merely importing it. Lives inside this directory — not the
 * consuming app — so its bare `react` imports resolve here.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { KauthClient } from "../src/index";
import { useSession } from "../src/react";

export function renderSessionHook(client: KauthClient): string {
  function Probe() {
    const { isSignedIn, user } = useSession(client);

    return `${isSignedIn ? "in" : "out"}:${user?.email ?? "-"}`;
  }

  return renderToString(createElement(Probe));
}
