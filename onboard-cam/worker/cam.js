// SEM Workbench 온보드 카메라 — Worker 쪽 (sem-ai Worker 에 붙이는 모듈)
//
//   GET  /api/cam/jwks.json  중계 서버 (MediaMTX) 가 시청 · 송출 토큰을 검사할 공개 키. 비밀 아님.
//   POST /api/cam/token      로그인한 팀원에게 짧은 시청 토큰 (JWT, ES256) 을 준다.
//                            응답: { token, exp, whep, path }  — 앱은 이 토큰으로 whep 주소에 WebRTC 재생을 요청한다.
//
// Worker 환경 변수
//   CAM_JWT_PRIVATE_JWK  (secret, 필수)  cam-keys.mjs new 로 만든 EC P-256 개인 키 JWK 한 줄
//   CAM_WHEP_URL         (필수)          예: https://cam.example.org/cam/whep
//   CAM_PATH             (선택)          MediaMTX 경로 이름. 기본 'cam'
//   CAM_TOKEN_TTL        (선택)          시청 토큰 수명 (초). 기본 1800, 60 ~ 14400 사이로 자름.
//                                       MediaMTX 는 토큰의 exp 가 되면 연결을 끊는다. 웹 플레이어 (live-cam.js) 가
//                                       끊기기 전에 새 토큰으로 이어 붙이므로 짧아도 화면은 끊기지 않는다.
//
// 붙이는 법 (기존 fetch 핸들러 안에서, 다른 /api 경로보다 먼저):
//   import { handleCamRoute } from './cam.js';
//   const r = await handleCamRoute(request, env, { authenticate: (req, env) => 기존세션확인(req, env) });
//   if (r) return withCors(request, r);   // 기존 CORS 처리 그대로
//
//   authenticate 는 Authorization: Bearer <세션 토큰> 을 확인해 승인된 팀원이면 사용자 객체 ({ login, ... }),
//   아니면 null 을 돌려주는 기존 함수를 그대로 쓰면 된다. 권한을 더 좁히려면 authorize(user) 를 넘긴다.

const ENC = new TextEncoder();

export const CAM_ISSUER = 'sem-workbench';
export const CAM_AUDIENCE = 'sem-cam';
const DEFAULT_PATH = 'cam';
const DEFAULT_TTL = 1800;

function b64u(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64uJson = (o) => b64u(ENC.encode(JSON.stringify(o)));

let cache = null; // { raw, key, pub }

async function signingKey(env) {
  const raw = env && env.CAM_JWT_PRIVATE_JWK;
  if (!raw) throw new Error('CAM_JWT_PRIVATE_JWK 가 없습니다');
  if (cache && cache.raw === raw) return cache;
  const jwk = JSON.parse(raw);
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y || !jwk.kid) {
    throw new Error('CAM_JWT_PRIVATE_JWK 는 kid 가 있는 EC P-256 개인 키 JWK 여야 합니다');
  }
  const key = await crypto.subtle.importKey(
    'jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  cache = { raw, key, pub: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid: jwk.kid, alg: 'ES256', use: 'sig' } };
  return cache;
}

// 공개 키 묶음 (JWKS). 개인 키의 d 는 절대 내보내지 않는다.
export async function camJwks(env) {
  const k = await signingKey(env);
  return { keys: [k.pub] };
}

// MediaMTX 가 읽는 권한 클레임 (mediamtx_permissions) 을 담은 JWT 를 서명한다.
export async function signCamToken(env, { sub, action, path, ttl, now }) {
  const k = await signingKey(env);
  const iat = Math.floor((now ?? Date.now()) / 1000);
  const claims = {
    iss: CAM_ISSUER,
    aud: CAM_AUDIENCE,
    sub: String(sub),
    iat,
    nbf: iat - 30,                       // 서버 · 기기 시계가 조금 어긋나도 받아들이게
    exp: iat + ttl,
    mediamtx_permissions: [{ action, path }],
  };
  const head = b64uJson({ alg: 'ES256', typ: 'JWT', kid: k.pub.kid });
  const body = b64uJson(claims);
  // WebCrypto ECDSA 서명은 r||s (64 바이트) 그대로 — JWS ES256 형식과 같다.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.key, ENC.encode(head + '.' + body));
  return { token: head + '.' + body + '.' + b64u(sig), exp: claims.exp };
}

function json(status, body, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(extra || {}) },
  });
}

function camPath(env) {
  const p = String((env && env.CAM_PATH) || DEFAULT_PATH);
  return /^[A-Za-z0-9_-]{1,64}$/.test(p) ? p : DEFAULT_PATH;
}

function tokenTtl(env) {
  const n = Math.floor(Number(env && env.CAM_TOKEN_TTL));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL;
  return Math.min(14400, Math.max(60, n));
}

/**
 * /api/cam/* 요청이면 Response 를, 아니면 null 을 돌려준다.
 * @param {Request} request
 * @param {object} env
 * @param {{ authenticate: (req: Request, env: object) => Promise<object|null>, authorize?: (user: object) => boolean }} opts
 */
export async function handleCamRoute(request, env, opts) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/cam/')) return null;

  if (url.pathname === '/api/cam/jwks.json') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'method', message: 'GET 만 됩니다.' });
    try {
      return json(200, await camJwks(env), { 'cache-control': 'public, max-age=300' });
    } catch (e) {
      return json(503, { error: 'cam_not_configured', message: '카메라 키가 설정되지 않았습니다.' });
    }
  }

  if (url.pathname === '/api/cam/token') {
    if (request.method !== 'POST') return json(405, { error: 'method', message: 'POST 만 됩니다.' });
    const user = await opts.authenticate(request, env);
    if (!user) return json(401, { error: 'unauthorized', message: '로그인이 필요합니다.' });
    if (opts.authorize && !opts.authorize(user)) return json(403, { error: 'forbidden', message: '라이브 카메라를 볼 권한이 없습니다.' });
    if (!env.CAM_WHEP_URL) return json(503, { error: 'cam_not_configured', message: '카메라 중계 서버 주소가 설정되지 않았습니다.' });
    try {
      const path = camPath(env);
      const t = await signCamToken(env, { sub: user.login || user.id || 'member', action: 'read', path, ttl: tokenTtl(env) });
      return json(200, { token: t.token, exp: t.exp, whep: env.CAM_WHEP_URL, path });
    } catch (e) {
      return json(503, { error: 'cam_not_configured', message: '카메라 키가 설정되지 않았습니다.' });
    }
  }

  return json(404, { error: 'not_found', message: '없는 주소입니다.' });
}
