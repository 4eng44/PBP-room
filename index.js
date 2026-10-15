// PbP 세션룸 — 사이트를 꺼 둬도 새 채팅을 푸시 알림으로 보내는 서버 코드
const functions = require('firebase-functions/v1');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
initializeApp();
const db = getFirestore();

const REGION = 'asia-northeast3';      // 서울
const ONLINE_MS = 90000;              // 이 방을 보고 있는 사람에게는 보내지 않음
const THROTTLE_MS = 60000;            // 같은 방 알림은 사람마다 1분에 한 번까지
const SITE = `https://${process.env.GCLOUD_PROJECT}.web.app/`;

async function notify(rid, msg, audience) {
  if (!msg || msg.imported || !msg.uid) return;
  const [roomSnap, memSnap] = await Promise.all([
    db.doc(`rooms/${rid}`).get(),
    db.collection(`rooms/${rid}/members`).get()
  ]);
  if (!roomSnap.exists) return;
  const now = Date.now();

  const targets = memSnap.docs.filter(d => {
    if (d.id === msg.uid) return false;
    if (audience && !audience.includes(d.id)) return false;
    const m = d.data();
    // 그 방을 화면에 띄워 보고 있는 사람만 건너뜀 (다른 탭·앱으로 넘어가거나 창을 닫으면 보냄)
    const here = m.st === 'on' && m.seen && now - m.seen < ONLINE_MS;
    return !here;
  }).map(d => d.id);

  await Promise.all(targets.map(async uid => {
    // 1분 안에 이미 보냈으면 건너뜀
    const stRef = db.doc(`pushState/${uid}_${rid}`);
    const ok = await db.runTransaction(async tx => {
      const s = await tx.get(stRef);
      if (s.exists && now - (s.get('at') || 0) < THROTTLE_MS) return false;
      tx.set(stRef, { at: now });
      return true;
    });
    if (!ok) return;

    const tokSnap = await db.collection(`users/${uid}/push`).get();
    const docs = tokSnap.docs.filter(d => d.get('token'));
    const tokens = docs.map(d => d.get('token'));
    if (!tokens.length) return;

    const res = await getMessaging().sendEachForMulticast({
      tokens,
      webpush: {
        notification: { title: '새 메시지가 도착했습니다.', tag: 'pbp-' + rid, renotify: true, icon: SITE + 'icon-192.png' },
        fcmOptions: { link: SITE + '#' + rid }
      }
    });
    // 더 이상 쓰지 않는 기기의 토큰은 정리
    await Promise.all(res.responses.map((r, i) => {
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token' || code === 'messaging/invalid-argument')
        return docs[i].ref.delete().catch(() => {});
      return null;
    }));
  }));
}

exports.pushOnMessage = functions.region(REGION).firestore
  .document('rooms/{rid}/messages/{mid}')
  .onCreate((snap, ctx) => notify(ctx.params.rid, snap.data(), null));

exports.pushOnPrivate = functions.region(REGION).firestore
  .document('rooms/{rid}/private/{mid}')
  .onCreate((snap, ctx) => {
    const m = snap.data() || {};
    return notify(ctx.params.rid, m, Array.isArray(m.aud) ? m.aud : []);
  });
