#!/usr/bin/env node
// 카메라 토큰 키 관리 (Node 20 이상, 의존성 없음)
//
//   node cam-keys.mjs new > cam-private.jwk.json
//       새 서명 키 쌍. 출력 (한 줄 JSON) 이 개인 키다. 저장소에 올리지 말 것.
//       Worker 에 넣기:  npx wrangler secret put CAM_JWT_PRIVATE_JWK < cam-private.jwk.json
//
//   node cam-keys.mjs publish-token --key cam-private.jwk.json [--days 365] [--path cam]
//       차량 (라즈베리 파이) 이 중계 서버로 송출할 때 쓰는 토큰. car/secrets.env 의 CAM_PUBLISH_TOKEN 에 넣는다.
//       MediaMTX 는 토큰의 exp 가 되면 송출 연결을 끊으므로, 대회 기간이 넉넉히 들어가게 정한다.
//
//   node cam-keys.mjs read-token --key cam-private.jwk.json [--minutes 30] [--path cam]
//       시험용 시청 토큰 (보통은 Worker 의 /api/cam/token 이 발급).

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { signCamToken } from './cam.js';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

function loadEnv() {
  const file = arg('key');
  if (!file) { console.error('--key <개인 키 JWK 파일> 이 필요합니다'); process.exit(2); }
  return { CAM_JWT_PRIVATE_JWK: readFileSync(file, 'utf8').trim() };
}

const cmd = process.argv[2];

if (cmd === 'new') {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const out = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d, kid: randomBytes(8).toString('hex') };
  process.stdout.write(JSON.stringify(out) + '\n');
} else if (cmd === 'publish-token' || cmd === 'read-token') {
  const env = loadEnv();
  const path = arg('path', 'cam');
  const ttl = cmd === 'publish-token'
    ? Math.round(Number(arg('days', '365')) * 86400)
    : Math.round(Number(arg('minutes', '30')) * 60);
  if (!(ttl > 0)) { console.error('기간이 잘못됐습니다'); process.exit(2); }
  const sub = cmd === 'publish-token' ? 'car' : 'tester';
  const action = cmd === 'publish-token' ? 'publish' : 'read';
  const t = await signCamToken(env, { sub, action, path, ttl });
  // SRT streamid 는 512 자가 한계 ("publish:<path>:car:" + 토큰)
  if (action === 'publish' && t.token.length + path.length + 13 > 512) { console.error('토큰이 SRT streamid 한계 (512 자) 를 넘습니다'); process.exit(1); }
  process.stdout.write(t.token + '\n');
  console.error(`만료: ${new Date(t.exp * 1000).toISOString()}  (${action} · 경로 ${path})`);
} else {
  console.error('사용법: node cam-keys.mjs new | publish-token --key FILE [--days N] [--path P] | read-token --key FILE [--minutes N]');
  process.exit(2);
}
