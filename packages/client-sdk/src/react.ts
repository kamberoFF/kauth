import { useSyncExternalStore } from "react";
import type { KauthClient, KauthUser } from "./index";

export interface UseSessionResult {
  /** True once this client has a live session (sign-up or sign-in). */
  isSignedIn: boolean;
  /**
   * The signed-in user's profile, when the SDK learned it — `signUp` returns
   * one, `signIn` does not (the platform's login endpoint ships tokens only).
   */
  user: KauthUser | null;
}

/**
 * Reactive binding over the client's session store. Re-renders the calling
 * component whenever `signUp`/`signIn`/`signOut` transitions the state.
 */
export function useSession(client: KauthClient): UseSessionResult {
  // The snapshot is pure and synchronous, so it serves as its own server
  // snapshot — without this, server rendering throws instead of producing
  // markup from the current state.
  const state = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot,
  );

  return {
    isSignedIn: state.status === "signedIn",
    user: state.status === "signedIn" ? state.user : null,
  };
}
