import assert from "node:assert/strict";
import { test } from "node:test";
import { getApp, deleteApp } from "firebase/app";
import { getAuth, applyActionCode } from "firebase/auth";
import { getFirestore, getDocFromServer, doc, terminate, setLogLevel } from "firebase/firestore";
import {
  initFirebaseAccount, readAccount, createAccount, listCloudTracks,
  saveCloudTrack, removeCloudTrack, signUpEmail, signInEmail,
  signOut, sendReset, refreshVerification,
} from "../web/firebase-account.js";
import { createShowcaseTrack } from "../web/showcase.js";
import { midiBytes } from "../web/music.js";

setLogLevel("silent");

function emulatorAddress(variable) {
  const value = process.env[variable];
  const match = /^(127\.0\.0\.1|localhost):(\d+)$/.exec(value || "");
  assert.ok(match, `${variable} must point to a loopback emulator. No production tests are allowed.`);
  return { host: match[1], port: Number(match[2]) };
}

test("real account adapter verifies email, isolates accounts and discards results after signout", { timeout: 90_000 }, async (t) => {
  const firestore = emulatorAddress("FIRESTORE_EMULATOR_HOST");
  const authentication = emulatorAddress("FIREBASE_AUTH_EMULATOR_HOST");
  const projectId = process.env.GCLOUD_PROJECT || "demo-auralis-rules";
  assert.match(projectId, /^demo-[a-z0-9-]+$/);
  const authBase = `http://${authentication.host}:${authentication.port}`;
  const changes = [];
  const initial = await initFirebaseAccount({
    apiKey: "demo-auralis-emulator-only",
    projectId,
    authDomain: `${projectId}.firebaseapp.com`,
    appId: "1:000000000000:web:emulator",
  }, (value) => changes.push(value), {
    authHost: authentication.host, authPort: authentication.port,
    firestoreHost: firestore.host, firestorePort: firestore.port,
  });
  t.after(async () => {
    await signOut();
    await terminate(getFirestore(getApp("auralis-accounts")));
    await deleteApp(getApp("auralis-accounts"));
  });
  assert.equal(initial.authenticated, false);
  const nonce = crypto.randomUUID();
  const email = `owner-${nonce}@example.test`;
  const secondEmail = `other-${nonce}@example.test`;
  const password = "Emulator-only-password-2026";
  let ownerId;
  const track = { ...createShowcaseTrack(), id: crypto.randomUUID(), title: "Adapter lifecycle" };

  async function verifyEmail(targetEmail) {
    const response = await fetch(`${authBase}/emulator/v1/projects/${projectId}/oobCodes`);
    assert.equal(response.status, 200);
    const body = await response.json();
    const code = body.oobCodes?.findLast((item) => item.email === targetEmail && item.requestType === "VERIFY_EMAIL");
    assert.ok(code?.oobCode, "Auth emulator captures the verification code without sending email");
    await applyActionCode(getAuth(getApp("auralis-accounts")), code.oobCode);
    const refreshed = await refreshVerification();
    assert.equal(refreshed.emailVerified, true);
  }

  await t.test("unverified signup cannot create or read a cloud library", async () => {
    const signedUp = await signUpEmail(email, password);
    assert.equal(signedUp.authenticated, true);
    assert.equal(signedUp.emailVerified, false);
    assert.equal(signedUp.hasAccount, false);
    assert.equal((await readAccount()).hasAccount, false);
    await assert.rejects(createAccount(), /Verify your email/);
    await assert.rejects(listCloudTracks(), /Verify your email/);
    ownerId = getAuth(getApp("auralis-accounts")).currentUser.uid;
  });

  await t.test("verified profile creation and score storage use the real rules and transaction", async () => {
    await verifyEmail(email);
    const account = await createAccount();
    assert.equal(account.hasAccount, true);
    assert.equal((await createAccount()).hasAccount, true, "profile creation is idempotent");
    const saved = await saveCloudTrack(track);
    assert.deepEqual(midiBytes(saved), midiBytes(track));
    assert.equal((await listCloudTracks())[0].id, track.id);
    await saveCloudTrack(track);
    const metadata = (await getDocFromServer(doc(getFirestore(getApp("auralis-accounts")), "users", ownerId))).data();
    assert.equal(metadata.count, 1);
    assert.equal(metadata.revision, 1, "idempotent saves do not spend a quota slot");
    await assert.rejects(saveCloudTrack({ ...track, title: "Conflicting identity" }), /different composition/);
  });

  await t.test("signout announces an empty session before completion and rejects pending private results", async () => {
    const pendingRead = listCloudTracks();
    const loggedOut = signOut();
    assert.equal(changes.at(-1).authenticated, false);
    await assert.rejects(pendingRead, /sign-in changed/);
    await loggedOut;
    assert.equal((await readAccount()).authenticated, false);
    await assert.rejects(listCloudTracks(), /Sign in/);
  });

  await t.test("a different user has an empty independent library", async () => {
    await signUpEmail(secondEmail, password);
    await verifyEmail(secondEmail);
    await createAccount();
    assert.deepEqual(await listCloudTracks(), []);
    await removeCloudTrack(track.id);
    await signOut();
    await signInEmail(email, password);
    assert.equal((await readAccount()).hasAccount, true);
    assert.equal((await listCloudTracks())[0].id, track.id, "other user's delete did not touch owner's score");
  });

  await t.test("delete updates the profile atomically and reset responses reveal no account existence", async () => {
    await removeCloudTrack(track.id);
    assert.deepEqual(await listCloudTracks(), []);
    const metadata = (await getDocFromServer(doc(getFirestore(getApp("auralis-accounts")), "users", ownerId))).data();
    assert.equal(metadata.count, 0);
    assert.equal(metadata.revision, 2);
    const existing = await sendReset(email);
    const missing = await sendReset(`missing-${nonce}@example.test`);
    assert.equal(existing, missing);
    assert.ok(changes.every((value) => value.hasAccount === false), "identity notifications never reuse a previous profile");
    assert.ok(changes.every((value) => !Object.hasOwn(value, "uid") && !Object.hasOwn(value, "accessToken")));
  });
});

