import test from "node:test";
import assert from "node:assert/strict";
import { publicConfigSchema } from "../public-config.js";
const config = {
  mode: "production",
  apiBaseUrl: "https://api.example.org",
  auth0Domain: "tenant.example.org",
  auth0ClientId: "public_id",
  auth0Audience: "https://auralis.example",
  turnstileSiteKey: "public-site-key",
};
test("production bundles only complete, public origin configuration", () => {
  assert.ok(publicConfigSchema.safeParse(config).success);
  for (const change of [
    { apiBaseUrl: "http://api.example.org" },
    { apiBaseUrl: "https://user:password@api.example.org" },
    { auth0ClientId: "" },
    { turnstileSiteKey: "" },
    { auth0Audience: " " },
    { database_url: "private" },
    { mode: "other" },
  ])
    assert.equal(
      publicConfigSchema.safeParse({ ...config, ...change }).success,
      false,
    );
});

test("Firebase config accepts public app identifiers and rejects admin secrets or emulator routing", () => {
  const firebase = {
    mode: "firebase",
    firebase: {
      apiKey: "public-project-identifier-12345",
      authDomain: "auralis-example.firebaseapp.com",
      projectId: "auralis-example",
      appId: "1:123456:web:abc123",
    },
  };
  assert.ok(publicConfigSchema.safeParse(firebase).success);
  for (const extra of [{privateKey:"secret"}, {clientSecret:"secret"}, {emulatorHost:"127.0.0.1"}])
    assert.equal(publicConfigSchema.safeParse({...firebase, firebase:{...firebase.firebase,...extra}}).success, false);
  assert.equal(publicConfigSchema.safeParse({...firebase, firebase:{...firebase.firebase,authDomain:"attacker.example"}}).success, false);
  assert.equal(publicConfigSchema.safeParse({...firebase, serviceAccount:{private_key:"secret"}}).success, false);
});
