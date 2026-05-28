"use client";

import { useEffect, useState } from "react";
import { OWNER_TOKEN_LS_KEY } from "../_lib/ownerHeader";

// Owner gate. The site is shared read-only with friends; the owner sets
// `localStorage.ownerToken = "<matching OWNER_TOKEN env value>"` once per
// browser, which both unlocks mutating UI here and authorises mutating API
// calls via the `x-owner-token` header.
//
// Presence of any token is treated as "claims to be owner" for UI gating —
// the server still verifies the value, so a fake token gets you 403s but
// no UI advantage either.

export function useIsOwner(): boolean {
  // Default false on first paint so non-owner visitors never flash
  // owner-only UI before hydration.
  const [isOwner, setIsOwner] = useState(false);

  useEffect(() => {
    try {
      setIsOwner(!!window.localStorage.getItem(OWNER_TOKEN_LS_KEY));
    } catch {
      // localStorage can throw in privacy modes; default to non-owner.
    }
  }, []);

  return isOwner;
}
