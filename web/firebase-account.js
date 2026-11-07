import { initializeApp } from "firebase/app";
import {
  initializeAuth,
  browserSessionPersistence,
  browserPopupRedirectResolver,
  inMemoryPersistence,
  connectAuthEmulator,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  reload,
  signOut as firebaseSignOut,
} from "firebase/auth";
import {
  initializeFirestore,
  connectFirestoreEmulator,
  memoryLocalCache,
  doc,
  collection,
  getDocFromServer,
  getDocsFromServer,
  query,
  orderBy,
  limit,
  runTransaction,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import { encodeFirebaseScore, decodeFirebaseScore } from "./firebase-score.js";

let auth;
let database;
let activeUser = null;
let sessionEpoch = 0;
let notifySession = () => {};
let initialization;
let continueUrl;

const trackIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

class AccountError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.name = "AccountError";
    this.status = status;
  }
}

function friendlyError(error) {
  if (error instanceof AccountError) return error;
  const messages = {
    "auth/invalid-email": "Enter a valid email address.",
    "auth/invalid-credential": "The email or password is incorrect. Try again or reset your password.",
    "auth/user-not-found": "The email or password is incorrect. Try again or reset your password.",
    "auth/wrong-password": "The email or password is incorrect. Try again or reset your password.",
    "auth/email-already-in-use": "This email cannot be registered. Try signing in or resetting your password.",
    "auth/weak-password": "Choose a stronger password with at least 12 characters.",
    "auth/password-does-not-meet-requirements": "Choose a stronger password with at least 12 characters.",
    "auth/popup-blocked": "Your browser blocked Google sign-in. Allow popups for this site and try again.",
    "auth/popup-closed-by-user": "Google sign-in was closed before it finished.",
    "auth/cancelled-popup-request": "Another sign-in window is already open.",
    "auth/account-exists-with-different-credential": "Sign in with the method already associated with this email.",
    "auth/too-many-requests": "Too many sign-in attempts. Please wait before trying again.",
    "auth/network-request-failed": "Sign-in could not connect. Check your connection and try again.",
    "auth/unauthorized-domain": "Sign-in is unavailable on this address. Open the published Auralis site.",
    "auth/operation-not-allowed": "This sign-in method is temporarily unavailable.",
    "auth/user-disabled": "This account is unavailable. Contact the site owner.",
    "auth/requires-recent-login": "Sign in again to continue.",
    "permission-denied": "Your library could not authorize this change. Verify your email, or wait a minute if you have made several changes.",
    "resource-exhausted": "Cloud storage is temporarily at capacity. You can still download your composition.",
    "unavailable": "Your cloud library could not connect. Check your connection and try again.",
    "deadline-exceeded": "The cloud request timed out. Check your library before retrying.",
  };
  return new AccountError(messages[error?.code] || "Your account library is unavailable. Try again shortly.");
}

function session(user = activeUser, profile = null) {
  return Object.freeze({
    authenticated: !!user,
    hasAccount: !!user?.emailVerified && !!profile,
    displayName: profile?.displayName || user?.displayName || null,
    emailVerified: user?.emailVerified === true,
    email: user?.email || null,
  });
}

function publishUser(user) {
  activeUser = user;
  sessionEpoch += 1;
  // The UI clears the previous account before any asynchronous library read.
  // Never retain Firebase User objects or tokens in the public view state.
  try {
    Promise.resolve(notifySession(session(user))).catch(() => {});
  } catch {
    // Rendering errors must not interrupt Firebase's identity listener.
  }
}

function requireInitialized() {
  if (!auth || !database) throw new AccountError("Account services are still loading. Try again shortly.");
}

function captureIdentity() {
  requireInitialized();
  const user = activeUser;
  if (!user || auth.currentUser?.uid !== user.uid) {
    throw new AccountError("Sign in to open your private library.", 401);
  }
  if (!user.emailVerified) throw new AccountError("Verify your email before opening your cloud library.", 403);
  return { user, epoch: sessionEpoch };
}

function assertIdentity(identity) {
  if (
    identity.epoch !== sessionEpoch ||
    activeUser?.uid !== identity.user.uid ||
    auth.currentUser?.uid !== identity.user.uid
  ) {
    throw new AccountError("Your sign-in changed. Open your library again to continue.", 401);
  }
}

function acceptAuthResult(user) {
  if (auth.currentUser?.uid !== user.uid) {
    throw new AccountError("Your sign-in changed. Sign in again to continue.", 401);
  }
  if (activeUser !== user) publishUser(user);
  return session(user);
}

function profileRef(identity) {
  return doc(database, "users", identity.user.uid);
}

function privateTrackRef(identity, id) {
  if (typeof id !== "string" || !trackIdPattern.test(id)) {
    throw new AccountError("This composition has an invalid identifier.", 400);
  }
  return doc(database, "users", identity.user.uid, "tracks", id);
}

function validateProfile(data) {
  if (
    typeof data?.displayName !== "string" || !data.displayName.length || data.displayName.length > 100 ||
    !Number.isInteger(data.count) || data.count < 0 || data.count > 50 ||
    !Number.isInteger(data.revision) || data.revision < 0 ||
    !Number.isInteger(data.nextSlot) || data.nextSlot < 0 || data.nextSlot > 9 ||
    !data.slots || Object.keys(data.slots).length !== 10 ||
    !Array.from({ length: 10 }, (_, i) => data.slots[String(i)] instanceof Timestamp).every(Boolean)
  ) throw new AccountError("Your library metadata could not be read. Try again shortly.");
  return data;
}

function nextMutation(profile, id, action) {
  return {
    count: profile.count + (action === "create" ? 1 : -1),
    revision: profile.revision + 1,
    nextSlot: (profile.nextSlot + 1) % 10,
    [`slots.${profile.nextSlot}`]: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lastTrackId: id,
    lastAction: action,
  };
}

function emailAddress(email) {
  if (typeof email !== "string" || email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new AccountError("Enter a valid email address.", 400);
  }
  return email.trim();
}

function emailActionSettings() {
  return { url: continueUrl };
}

/** Initialize once. The callback always announces identity before a profile read. */
export async function initFirebaseAccount(config, onSessionChanged = () => {}, emulatorOptions) {
  if (initialization) return initialization;
  notifySession = onSessionChanged;
  initialization = (async () => {
    const browser = typeof window !== "undefined";
    const loopback = (host) => ["127.0.0.1", "localhost", "::1"].includes(host);
    const validPort = (port) => Number.isInteger(port) && port >= 1024 && port <= 65535;
    // Tests opt in in code, never in downloadable config. Production project IDs
    // cannot be redirected to local services, even from a local preview.
    if (emulatorOptions && (
      !/^demo-[a-z0-9-]+$/.test(config.projectId) ||
      (browser && !loopback(window.location.hostname)) ||
      !loopback(emulatorOptions.authHost) || !loopback(emulatorOptions.firestoreHost) ||
      !validPort(emulatorOptions.authPort) || !validPort(emulatorOptions.firestorePort)
    )) throw new AccountError("Emulators require a demo project and local addresses.", 400);
    if (!browser && !emulatorOptions) throw new AccountError("Account services require a browser.", 400);
    continueUrl = browser
      ? new URL("/?account=setup", window.location.origin).href
      : "http://127.0.0.1/?account=setup";
    const app = initializeApp(config, "auralis-accounts");
    auth = initializeAuth(app, {
      persistence: browser ? browserSessionPersistence : inMemoryPersistence,
      ...(browser ? { popupRedirectResolver: browserPopupRedirectResolver } : {}),
    });
    // Private music is never written to IndexedDB or the guest LocalStorage cache.
    database = initializeFirestore(app, { localCache: memoryLocalCache() });
    if (emulatorOptions) {
      const authHost = emulatorOptions.authHost.includes(":") ? `[${emulatorOptions.authHost}]` : emulatorOptions.authHost;
      connectAuthEmulator(auth, `http://${authHost}:${emulatorOptions.authPort}`, { disableWarnings: true });
      connectFirestoreEmulator(database, emulatorOptions.firestoreHost, emulatorOptions.firestorePort);
    }
    onAuthStateChanged(auth, publishUser);
    await auth.authStateReady();
    return session();
  })();
  try { return await initialization; } catch (error) { throw friendlyError(error); }
}

export async function readAccount() {
  try {
    requireInitialized();
    if (!activeUser || !activeUser.emailVerified) return session();
    const identity = captureIdentity();
    const snapshot = await getDocFromServer(profileRef(identity));
    assertIdentity(identity);
    return session(identity.user, snapshot.exists() ? validateProfile(snapshot.data()) : null);
  } catch (error) { throw friendlyError(error); }
}

export async function createAccount() {
  try {
    const identity = captureIdentity();
    const ref = profileRef(identity);
    await runTransaction(database, async (transaction) => {
      const existing = await transaction.get(ref);
      assertIdentity(identity);
      if (existing.exists()) { validateProfile(existing.data()); return; }
      const displayName = identity.user.displayName?.trim().slice(0, 100) || "Composer";
      transaction.set(ref, {
        displayName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        count: 0,
        revision: 0,
        nextSlot: 0,
        slots: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i), Timestamp.fromMillis(0)])),
        lastTrackId: "",
        lastAction: "none",
      });
    });
    assertIdentity(identity);
    return await readAccount();
  } catch (error) { throw friendlyError(error); }
}

export async function listCloudTracks() {
  let identity;
  try {
    identity = captureIdentity();
    const ref = collection(database, "users", identity.user.uid, "tracks");
    const snapshot = await getDocsFromServer(query(ref, orderBy("createdAt", "desc"), limit(50)));
    assertIdentity(identity);
    return snapshot.docs.map((record) => decodeFirebaseScore(record.id, record.data()));
  } catch (error) {
    // Auth can change while Firestore is checking a request. A rejected old
    // request is a session change, not a quota or current-account failure.
    if (identity) assertIdentity(identity);
    throw friendlyError(error);
  }
}

export async function saveCloudTrack(track) {
  try {
    const identity = captureIdentity();
    const ref = privateTrackRef(identity, track?.id);
    const metadata = profileRef(identity);
    const score = encodeFirebaseScore(track);
    await runTransaction(database, async (transaction) => {
      const [profileSnapshot, existing] = await Promise.all([transaction.get(metadata), transaction.get(ref)]);
      assertIdentity(identity);
      if (!profileSnapshot.exists()) throw new AccountError("Create your private library before saving a composition.", 404);
      const profile = validateProfile(profileSnapshot.data());
      if (existing.exists()) {
        if (Object.entries(score).every(([key, value]) => existing.data()[key] === value)) return;
        throw new AccountError("A different composition already uses this identifier. Generate a new composition.", 409);
      }
      if (profile.count >= 50) throw new AccountError("Your library holds 50 compositions. Remove one before saving another.", 409);
      transaction.set(ref, { ...score, createdAt: serverTimestamp() });
      transaction.update(metadata, nextMutation(profile, track.id, "create"));
    });
    assertIdentity(identity);
    const saved = await getDocFromServer(ref);
    assertIdentity(identity);
    if (!saved.exists()) throw new AccountError("This composition was removed while the library was updating.", 404);
    return decodeFirebaseScore(saved.id, saved.data());
  } catch (error) { throw friendlyError(error); }
}

export async function removeCloudTrack(id) {
  try {
    const identity = captureIdentity();
    const ref = privateTrackRef(identity, id);
    const metadata = profileRef(identity);
    await runTransaction(database, async (transaction) => {
      const [profileSnapshot, existing] = await Promise.all([transaction.get(metadata), transaction.get(ref)]);
      assertIdentity(identity);
      if (!profileSnapshot.exists()) throw new AccountError("Your private library could not be found.", 404);
      const profile = validateProfile(profileSnapshot.data());
      if (!existing.exists()) return;
      transaction.delete(ref);
      transaction.update(metadata, nextMutation(profile, id, "delete"));
    });
    assertIdentity(identity);
  } catch (error) { throw friendlyError(error); }
}

export async function signInEmail(email, password) {
  try {
    requireInitialized();
    const result = await signInWithEmailAndPassword(auth, emailAddress(email), password);
    return acceptAuthResult(result.user);
  } catch (error) { throw friendlyError(error); }
}

export async function signUpEmail(email, password) {
  try {
    requireInitialized();
    if (typeof password !== "string" || password.length < 12 || password.length > 128) {
      throw new AccountError("Use a password between 12 and 128 characters.", 400);
    }
    const result = await createUserWithEmailAndPassword(auth, emailAddress(email), password);
    acceptAuthResult(result.user);
    try {
      await sendEmailVerification(result.user, emailActionSettings());
    } catch {
      throw new AccountError("Your account was created, but the verification email could not be sent. Use Resend verification to try again.");
    }
    return acceptAuthResult(result.user);
  } catch (error) { throw friendlyError(error); }
}

export async function signInGoogle() {
  try {
    requireInitialized();
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    const result = await signInWithPopup(auth, provider);
    return acceptAuthResult(result.user);
  } catch (error) { throw friendlyError(error); }
}

export async function signOut() {
  requireInitialized();
  // Invalidate pending reads and private playback even before the SDK resolves.
  publishUser(null);
  try {
    await firebaseSignOut(auth);
    return session();
  } catch (error) {
    publishUser(auth.currentUser);
    throw friendlyError(error);
  }
}

export async function sendReset(email) {
  try {
    requireInitialized();
    await sendPasswordResetEmail(auth, emailAddress(email), emailActionSettings());
  } catch (error) {
    // Match the successful response when account enumeration protection is off.
    if (error?.code !== "auth/user-not-found") throw friendlyError(error);
  }
  return "If an account exists for this email, a password reset link has been sent.";
}

export async function resendVerification() {
  try {
    requireInitialized();
    const user = activeUser;
    if (!user) throw new AccountError("Sign in before requesting a verification email.", 401);
    const identity = { user, epoch: sessionEpoch };
    if (!user.emailVerified) await sendEmailVerification(user, emailActionSettings());
    assertIdentity(identity);
    return session();
  } catch (error) { throw friendlyError(error); }
}

export async function refreshVerification() {
  try {
    requireInitialized();
    const user = activeUser;
    const epoch = sessionEpoch;
    if (!user) throw new AccountError("Sign in to check your verification status.", 401);
    await reload(user);
    await user.getIdToken(true);
    if (epoch !== sessionEpoch || auth.currentUser?.uid !== user.uid) {
      throw new AccountError("Your sign-in changed. Sign in again to continue.", 401);
    }
    publishUser(user);
    return session();
  } catch (error) { throw friendlyError(error); }
}
