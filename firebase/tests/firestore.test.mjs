import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, limit, orderBy, query, setDoc, deleteDoc, updateDoc, runTransaction,
  writeBatch, serverTimestamp, Timestamp, setLogLevel } from "firebase/firestore";

// All test data lives in a demo emulator project; never point these tests at production.
const projectId = "demo-auralis-rules";
let env;
setLogLevel("silent");
const trackId = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const epoch = () => Timestamp.fromMillis(0);
const slots = () => Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i), epoch()]));
const initial = () => ({ displayName: "Owner", createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  count: 0, revision: 0, nextSlot: 0, slots: slots(), lastTrackId: "", lastAction: "none" });
const score = () => ({ title: "Velvet reverie", bars: 16, tempo: 96, instrument: "piano", temperature: 0.85,
  tokens: "2110".repeat(64), createdAt: serverTimestamp() });
const userDb = (uid = "alice", verified = true) => env.authenticatedContext(uid, { email: `${uid}@example.test`, email_verified: verified }).firestore();
const profile = (db, uid = "alice") => doc(db, "users", uid);
const track = (db, n = 1, uid = "alice") => doc(db, "users", uid, "tracks", typeof n === "number" ? trackId(n) : n);

before(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run this suite with firebase emulators:exec --only firestore --project demo-auralis-rules.");
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(":");
  env = await initializeTestEnvironment({ projectId, firestore: { host, port: Number(port),
    rules: await readFile(new URL("../firestore.rules", import.meta.url), "utf8") } });
});
beforeEach(async () => { await env.clearFirestore(); });
after(async () => { await env?.cleanup(); });

async function openAccount(db = userDb(), uid = "alice") {
  await assertSucceeds(setDoc(profile(db, uid), initial())); return db;
}
async function mutate(db, n, action = "create", options = {}) {
  const uid = options.uid ?? "alice";
  const old = (await getDoc(profile(db, uid))).data();
  const next = { ...old, count: old.count + (action === "create" ? 1 : -1), revision: old.revision + 1,
    nextSlot: (old.nextSlot + 1) % 10, updatedAt: serverTimestamp(),
    slots: { ...old.slots, [String(old.nextSlot)]: serverTimestamp() }, lastTrackId: trackId(n), lastAction: action,
    ...options.meta };
  const batch = writeBatch(db);
  batch.set(profile(db, uid), next);
  if (action === "create") batch.set(track(db, n, uid), { ...score(), ...options.score });
  else batch.delete(track(db, n, uid));
  options.extra?.(batch);
  return batch.commit();
}
async function seed(dbUid, count = 0, patch = {}) {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore(); const batch = writeBatch(db);
    const now = Timestamp.now();
    batch.set(profile(db, dbUid), { ...initial(), createdAt: now, updatedAt: now, count, ...patch });
    for (let n = 1; n <= count; n++) batch.set(track(db, n, dbUid), { ...score(), createdAt: now });
    await batch.commit();
  });
}

test("verified owner can create, query, reload and delete an immutable composition", async () => {
  const db = await openAccount();
  await assertSucceeds(mutate(db, 1));
  const page = await assertSucceeds(getDocs(query(collection(db, "users/alice/tracks"), orderBy("createdAt", "desc"), limit(50))));
  assert.equal(page.size, 1); assert.equal(page.docs[0].data().tokens.length, 256);
  assert.equal((await getDoc(profile(db))).data().count, 1);
  await assertSucceeds(mutate(db, 1, "delete"));
  assert.equal((await getDoc(profile(db))).data().count, 0);
  assert.equal((await getDoc(track(db))).exists(), false);
});

test("SDK transaction dot-path slot updates match the browser adapter's write shape", async () => {
  const db = await openAccount();
  await assertSucceeds(runTransaction(db, async tx => {
    const [meta, existing] = await Promise.all([tx.get(profile(db)), tx.get(track(db))]);
    assert.equal(existing.exists(), false);
    const old = meta.data();
    tx.update(profile(db), { count: old.count + 1, revision: old.revision + 1,
      nextSlot: (old.nextSlot + 1) % 10, [`slots.${old.nextSlot}`]: serverTimestamp(),
      updatedAt: serverTimestamp(), lastTrackId: trackId(1), lastAction: "create" });
    tx.set(track(db), score());
  }));
  const meta = (await getDoc(profile(db))).data();
  assert.equal(meta.count, 1); assert.equal(meta.slots["1"].toMillis(), 0);
  assert.ok(meta.slots["0"].toMillis() > 0);
});

test("other users, guests and unverified identities cannot access private records", async () => {
  const alice = await openAccount(); await mutate(alice, 1);
  for (const db of [userDb("bob"), userDb("alice", false), env.unauthenticatedContext().firestore()]) {
    await assertFails(getDoc(profile(db)));
    await assertFails(getDoc(track(db)));
    await assertFails(getDocs(collection(db, "users/alice/tracks")));
    await assertFails(setDoc(profile(db), initial()));
    await assertFails(setDoc(track(db, 2), score()));
    await assertFails(deleteDoc(track(db)));
  }
  await assertFails(getDocs(collection(alice, "users")));
  await assertFails(setDoc(doc(alice, "public", "leak"), { value: "no" }));
});

test("profile setup rejects roles, extra/missing fields and forged initial quotas", async () => {
  const db = userDb();
  for (const patch of [{ role: "admin" }, { count: 1 }, { count: -1 }, { revision: 10 }, { nextSlot: 2 },
    { slots: {} }, { slots: { ...slots(), "9": "0" } }, { slots: { ...slots(), "9": Timestamp.now() } },
    { displayName: "" }, { displayName: "x".repeat(101) }, { createdAt: epoch() }, { lastAction: "create" }])
    await assertFails(setDoc(profile(db), { ...initial(), ...patch }));
  const incomplete = initial(); delete incomplete.slots;
  await assertFails(setDoc(profile(db), incomplete));
  await openAccount(db);
  await assertFails(deleteDoc(profile(db)));
  await assertFails(setDoc(profile(db), initial()));
  await assertFails(updateDoc(profile(db), { role: "admin" }));
});

test("track writes must be bound to exactly one genuine metadata transition", async () => {
  const db = await openAccount();
  await assertFails(setDoc(track(db), score()));
  await assertFails(updateDoc(profile(db), { count: 1, revision: 1 }));
  await assertFails(mutate(db, 1, "create", { extra: batch => batch.set(track(db, 2), score()) }));
  await assertFails(mutate(db, 1, "create", { meta: { count: 0 } }));
  await assertFails(mutate(db, 1, "create", { meta: { revision: 0 } }));
  await assertFails(mutate(db, 1, "create", { meta: { displayName: "Changed" } }));
  await assertFails(mutate(db, 1, "create", { meta: { createdAt: epoch() } }));
  await assertSucceeds(mutate(db, 1));
  await assertFails(updateDoc(track(db), { title: "Overwrite" }));
  await assertFails(deleteDoc(track(db)));
  await assertFails(mutate(db, 1)); // Existing track cannot consume a fake create event.
  await assertFails(mutate(db, 2, "delete")); // Missing track cannot reduce the count.
  await assertFails(updateDoc(profile(db), { count: 0, revision: 2, lastAction: "delete" }));
});

test("malformed score data cannot enter storage through an otherwise valid batch", async () => {
  const db = await openAccount();
  for (const patch of [{ ownerId: "bob" }, { title: "<script>" }, { title: "x".repeat(101) }, { title: "Valid title\n" }, { bars: 17 },
    { tempo: 40 }, { tempo: 100.5 }, { temperature: 1.6 }, { instrument: "arbitrary" }, { createdAt: epoch() },
    { tokens: "1" + "0".repeat(255) }, { tokens: "01" + "0".repeat(254) }, { tokens: "d".repeat(256) },
    { tokens: "0".repeat(255) }, { tokens: "0".repeat(513) }, { tokens: "0".repeat(255) + "\n" }, { tokens: ["2"] }])
    await assertFails(mutate(db, 1, "create", { score: patch }));
  await assertSucceeds(mutate(db, 1));
  await assertSucceeds(mutate(db, 2, "create", { score: { bars: 32, tempo: 180, temperature: 0.2, tokens: "c1".repeat(256) } }));
});

test("the 50-track cap is enforced by rules and a deletion frees exactly one place", async () => {
  await seed("alice", 50); const db = userDb();
  await assertFails(mutate(db, 51));
  await assertFails(mutate(db, 51, "create", { meta: { count: 50 } }));
  await assertSucceeds(mutate(db, 1, "delete"));
  await assertSucceeds(mutate(db, 51));
  await assertFails(mutate(db, 52));
  assert.equal((await getDoc(profile(db))).data().count, 50);
});

test("the eleventh mutation in a rolling minute is denied, including deletes", async () => {
  const db = await openAccount();
  for (let n = 1; n <= 5; n++) { await assertSucceeds(mutate(db, n)); await assertSucceeds(mutate(db, n, "delete")); }
  const meta = (await getDoc(profile(db))).data();
  assert.equal(meta.count, 0); assert.equal(meta.revision, 10); assert.equal(meta.nextSlot, 0);
  await assertFails(mutate(db, 6));
  await assertFails(mutate(db, 6, "create", { meta: { slots: { ...slots(), "0": serverTimestamp() } } }));
  await assertFails(mutate(db, 6, "create", { meta: { nextSlot: 2 } }));
  await assertFails(setDoc(profile(db), initial()));
});

test("only the expired oldest slot can be reused; other slots cannot be reset", async () => {
  const recent = Timestamp.now(), old = Timestamp.fromMillis(Date.now() - 61000);
  await seed("alice", 0, { revision: 10, nextSlot: 0, slots: { ...Object.fromEntries(Array.from({length:10}, (_,i) => [String(i), recent])), "0": old } });
  const db = userDb();
  await assertFails(mutate(db, 1, "create", { meta: { slots: { ...slots(), "0": serverTimestamp() } } }));
  await assertSucceeds(mutate(db, 1));
  await assertFails(mutate(db, 2));
});

test("profile creation and an orphan track cannot be smuggled into one batch", async () => {
  const db = userDb(); const batch = writeBatch(db);
  batch.set(profile(db), initial()); batch.set(track(db), score());
  await assertFails(batch.commit());
  await assertFails(getDocs(collection(db, "users/alice/tracks")));
});
