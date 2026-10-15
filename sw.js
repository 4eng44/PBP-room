// Service worker for background push notifications (built into public/firebase-messaging-sw.js)
import { initializeApp } from 'firebase/app';
import { getMessaging } from 'firebase/messaging/sw';
const app = initializeApp(self.PBP_CONFIG.firebase);
getMessaging(app);
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
