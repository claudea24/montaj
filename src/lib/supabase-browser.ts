"use client";

import { useMemo } from "react";
import { useSession } from "@clerk/nextjs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export function useSupabaseClient(): SupabaseClient | null {
  const { session, isLoaded } = useSession();
  return useMemo(() => {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
    // Wait for Clerk to finish hydrating its session before exposing a client.
    // Otherwise consumers race ahead, fire requests with the anon key, and RLS
    // silently returns [] — the page then thinks the project has no doc and
    // renders an empty timeline. (`isLoaded` is the Clerk-side signal that the
    // session state is settled; `session` itself can be transiently null.)
    if (!isLoaded) return null;
    if (!session) return null;
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      async accessToken() {
        return (await session.getToken()) ?? null;
      },
    });
  }, [session, isLoaded]);
}
