// Firebase connection for PbP 세션룸.
// Exposes window.pbpBackend with a small Firestore-like API the page already uses,
// plus email/password auth helpers. Built into public/firebase-bundle.js by build.mjs.
import { initializeApp } from 'firebase/app';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail, signOut, reload,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, query, where, orderBy, limit, onSnapshot, getDocs, getDoc,
  setDoc, updateDoc, deleteDoc, arrayUnion, arrayRemove
} from 'firebase/firestore';
import { getMessaging, getToken, deleteToken, isSupported as messagingSupported } from 'firebase/messaging';

const cfg = window.PBP_CONFIG || {};
let app;
try {
  if (!cfg.firebase || !cfg.firebase.apiKey || !cfg.firebase.projectId) throw new Error('firebase-config.js에 firebase 설정값(apiKey, projectId)이 없습니다.');
  app = initializeApp(cfg.firebase);
} catch (e) {
  window.__pbpInitError = (e && e.message) || String(e);
  throw e;
}
const auth = getAuth(app);
let fs;
try {
  fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
} catch {
  fs = initializeFirestore(app, {});
}

// Firebase error codes → the codes the page already understands
const CODE = {
  'permission-denied': 'invalid_argument', 'invalid-argument': 'invalid_argument', 'not-found': 'invalid_argument',
  'failed-precondition': 'invalid_argument', 'resource-exhausted': 'resource_exhausted', 'unavailable': 'unavailable',
  'deadline-exceeded': 'unavailable', 'unauthenticated': 'revoked', 'cancelled': 'unavailable'
};
const wrapErr = e => ({ code: CODE[e && e.code] || 'unavailable', message: (e && e.message) || '', raw: e && e.code });
const rethrow = p => p.catch(e => { throw wrapErr(e); });

const docSnap = s => ({ id: s.id, exists: s.exists(), data: () => s.data(), metadata: s.metadata });
const qSnap = s => ({ docs: s.docs.map(docSnap), size: s.size, empty: s.empty, metadata: s.metadata });

function docRef(path) {
  const r = doc(fs, path);
  return {
    id: r.id, path,
    get: () => rethrow(getDoc(r)).then(docSnap),
    set: d => rethrow(setDoc(r, d)),
    update: d => rethrow(updateDoc(r, d)),
    delete: () => rethrow(deleteDoc(r)),
    onSnapshot: (next, err) => onSnapshot(r, s => next(docSnap(s)), e => err && err(wrapErr(e))),
    collection: c => colRef(path + '/' + c)
  };
}
function makeQuery(path, cons) {
  const q = () => query(collection(fs, path), ...cons);
  return {
    where: (f, op, v) => makeQuery(path, [...cons, where(f, op, v)]),
    orderBy: (f, d = 'asc') => makeQuery(path, [...cons, orderBy(f, d)]),
    limit: n => makeQuery(path, [...cons, limit(n)]),
    get: () => rethrow(getDocs(q())).then(qSnap),
    onSnapshot: (next, err) => onSnapshot(q(), s => next(qSnap(s)), e => err && err(wrapErr(e)))
  };
}
function colRef(path) {
  return Object.assign(makeQuery(path, []), {
    path,
    doc: id => docRef(id ? path + '/' + id : doc(collection(fs, path)).path)
  });
}

getRedirectResult(auth).catch(() => {});
const db = { doc: docRef, collection: colRef, arrayUnion, arrayRemove };

const authApi = {
  onChange: cb => onAuthStateChanged(auth, cb),
  current: () => auth.currentUser,
  signIn: (email, pw) => signInWithEmailAndPassword(auth, email, pw),
  signInGoogle: async () => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try { return await signInWithPopup(auth, provider); }
    catch (e) {
      if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) return signInWithRedirect(auth, provider);
      throw e;
    }
  },
  signUp: async (email, pw) => {
    const c = await createUserWithEmailAndPassword(auth, email, pw);
    try { await sendEmailVerification(c.user); } catch {}
    return c;
  },
  resendVerify: () => auth.currentUser ? sendEmailVerification(auth.currentUser) : Promise.resolve(),
  resetPassword: email => sendPasswordResetEmail(auth, email),
  refresh: async () => { if (auth.currentUser) { await reload(auth.currentUser); await auth.currentUser.getIdToken(true); } return auth.currentUser; },
  signOut: () => signOut(auth)
};

// ---- push notifications (FCM) ----
const FCM_KEY = 'pbp.fcmToken';
async function swReg(){
  const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
  await navigator.serviceWorker.ready;
  return reg;
}
async function saveToken(uid, token){
  await setDoc(doc(fs, 'users', uid, 'push', token), { token, ts: Date.now(), ua: String(navigator.userAgent || '').slice(0, 200) });
  try { localStorage.setItem(FCM_KEY, token); } catch {}
}
const pushApi = {
  hasKey: () => !!cfg.vapidKey,
  supported: async () => {
    try { return !!cfg.vapidKey && 'serviceWorker' in navigator && 'Notification' in window && await messagingSupported(); }
    catch { return false; }
  },
  enable: async uid => {
    let perm = Notification.permission;
    if (perm !== 'granted') perm = await Notification.requestPermission();
    if (perm !== 'granted') throw { code: 'push/denied' };
    const reg = await swReg();
    const token = await getToken(getMessaging(app), { vapidKey: cfg.vapidKey, serviceWorkerRegistration: reg });
    if (!token) throw { code: 'push/no-token' };
    await saveToken(uid, token);
    return token;
  },
  refresh: async uid => {
    if (Notification.permission !== 'granted') return null;
    const reg = await swReg();
    const token = await getToken(getMessaging(app), { vapidKey: cfg.vapidKey, serviceWorkerRegistration: reg });
    let old = null; try { old = localStorage.getItem(FCM_KEY); } catch {}
    if (old && old !== token) { try { await deleteDoc(doc(fs, 'users', uid, 'push', old)); } catch {} }
    if (token) await saveToken(uid, token);
    return token;
  },
  disable: async uid => {
    let old = null; try { old = localStorage.getItem(FCM_KEY); localStorage.removeItem(FCM_KEY); } catch {}
    try { await deleteToken(getMessaging(app)); } catch {}
    if (old && uid) { try { await deleteDoc(doc(fs, 'users', uid, 'push', old)); } catch {} }
  }
};

window.pbpBackend = { db, auth: authApi, push: pushApi, adminEmail: String(cfg.adminEmail || '').trim().toLowerCase() };
if (window.__pbpResolve) window.__pbpResolve(window.pbpBackend);
