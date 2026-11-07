import { z } from "zod";

// Only these public fields may be copied into a browser build.
const keys = {
  apiBaseUrl: z.string(),
  auth0Domain: z.string(),
  auth0ClientId: z.string(),
  auth0Audience: z.string(),
  turnstileSiteKey: z.string(),
};
export const publicConfigSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("firebase"),
    firebase: z.object({
      apiKey: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/),
      authDomain: z.string().regex(/^[a-z0-9-]+\.(firebaseapp\.com|web\.app)$/),
      projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
      appId: z.string().regex(/^1:\d+:web:[a-f0-9]+$/),
      messagingSenderId: z.string().regex(/^\d+$/).optional(),
      storageBucket: z.string().regex(/^[a-z0-9.-]+$/).optional(),
    }).strict(),
  }).strict(),
  z
    .object({
      mode: z.enum(["demo", "hosted"]),
      ...Object.fromEntries(Object.keys(keys).map((k) => [k, z.literal("")])),
    })
    .strict(),
  z
    .object({
      mode: z.literal("production"),
      ...keys,
      apiBaseUrl: z.string().regex(/^https:\/\/[a-z0-9.-]+(?::443)?$/),
      auth0Domain: z.string().regex(/^(?![.-])[a-z0-9.-]+\.[a-z]+$/),
      auth0ClientId: z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/),
      auth0Audience: z.string().trim().min(1).max(512),
      turnstileSiteKey: z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/),
    })
    .strict(),
]);
