import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

export const SUPABASE_URL = "https://uoeorsjrxzwjgsuuxlof.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_Wx5QlaQVbeEek4GFbGyvxg_KXAyAeuM";
export const APP_LOGIN_URL = "https://uqamsavatelier.github.io/sesame/login.html";

// Configure one of these for company SSO.
// Prefer SSO_PROVIDER_ID if your IdP is explicitly configured in Supabase.
export const SSO_DOMAIN = "example.com";
export const SSO_PROVIDER_ID = "";

export const supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Required for OAuth/SSO callback handling.
    detectSessionInUrl: true,
  },
});
