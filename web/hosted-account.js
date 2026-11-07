import { z } from "zod";
import { trackSchema } from "./music.js";

// The platform owns these top-level routes. Return only to a fixed studio URL.
export const signInHref = "/signin-with-chatgpt?return_to=%2F%3Faccount%3Dsetup";
export const signOutHref = "/signout-with-chatgpt?return_to=%2F";

const accountSchema = z.object({
  authenticated: z.boolean(),
  hasAccount: z.boolean(),
  displayName: z.string().max(500).nullish(),
}).refine((state) => state.authenticated || !state.hasAccount);

class AccountRequestError extends Error {
  constructor(status) {
    const messages = {
      401: "Your sign-in has expired. Sign in again to open your private library.",
      403: "Your account could not authorize this request. Reload the studio and try again.",
      404: "The requested account or composition could not be found.",
      409: "Your library could not accept this save. Check its capacity and try again.",
      413: "This composition is too large to save. You can still download it.",
      429: "Too many requests. Please wait a minute and try again.",
    };
    super(messages[status] || "Your account library is unavailable. Try again shortly.");
    this.status = status;
  }
}

async function request(path, method = "GET", payload) {
  const headers = { Accept: "application/json" };
  if (method !== "GET") {
    headers["X-Auralis-Request"] = "1";
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(path, {
    method, headers, cache: "no-store", credentials: "same-origin",
    mode: "same-origin", redirect: "error",
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  if (!response.ok) throw new AccountRequestError(response.status);
  if (response.status === 204) return null;
  return response.json();
}

export async function readAccount() {
  return accountSchema.parse(await request("/api/account"));
}

export async function createAccount() {
  await request("/api/account", "POST", {});
  return readAccount();
}

export async function listCloudTracks() {
  const page = await request("/api/library");
  return z.array(trackSchema).parse(page.tracks);
}

export async function saveCloudTrack(track) {
  // Ownership and creation times are assigned by the server, never the client.
  const {id, title, bars, tempo, instrument, temperature, duration, notes} = trackSchema.parse(track);
  const result = await request("/api/library", "POST", {id, title, bars, tempo, instrument, temperature, duration, notes});
  return trackSchema.parse(result.track);
}

export async function removeCloudTrack(id) {
  await request(`/api/library/${encodeURIComponent(id)}`, "DELETE");
}
