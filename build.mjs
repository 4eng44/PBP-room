// public/firebase-bundle.js 와 public/firebase-messaging-sw.js 를 다시 만듭니다. (Firebase SDK 버전을 올릴 때만 필요)
import { build } from 'esbuild';
await build({ entryPoints: ['src/adapter.js'], bundle: true, minify: true, format: 'esm', target: 'es2020', outfile: '../public/firebase-bundle.js' });
await build({
  entryPoints: ['src/sw.js'], bundle: true, minify: true, format: 'iife', target: 'es2020', outfile: '../public/firebase-messaging-sw.js',
  banner: { js: "self.window={};importScripts('/firebase-config.js');self.PBP_CONFIG=self.window.PBP_CONFIG;delete self.window;" }
});
console.log('built');
