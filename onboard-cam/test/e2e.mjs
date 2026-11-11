#!/usr/bin/env node
// 종단 시험 (한 대의 리눅스 PC 에서): 가짜 차량 → SRT → 중계 → WebRTC → 헤드리스 크로미움
//
//   MEDIAMTX=/path/to/mediamtx node test/e2e.mjs
//
// 필요: mediamtx (v1.21.x), ffmpeg (libx264 · srt), node 20+, playwright (크로미움)
// 차량 쪽은 카메라 대신 ffmpeg 시험 화면을 RTSP 로 넣는다. 나머지 (차량 · 중계 설정, Worker 토큰, 웹 플레이어) 는 실제 파일 그대로.

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { handleCamRoute, signCamToken } from '../worker/cam.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUN = join(ROOT, 'test', '.run');
const MEDIAMTX = process.env.MEDIAMTX || 'mediamtx';
const SHOT = process.env.SHOT || '';                  // 스크린숏 저장 경로 (선택)
const TTL = 60;                                       // 시청 토큰 수명 (초, Worker 최소값): 갈아 끼우기까지 시험
const PASS = 'e2e0123456789abcdef';
const WORKER = 'http://127.0.0.1:8787';
const PAGE = 'http://127.0.0.1:8080';

const procs = [];
const servers = [];
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ok(cond, what) {
  console.log((cond ? '  통과  ' : '  실패  ') + what);
  if (!cond) failed++;
}
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* 아직 */ } await sleep(250); }
  throw new Error('시간 초과: ' + what);
}
function run(name, cmd, args, env) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = '';
  const keep = (d) => { p.log = (p.log + d).slice(-20000); };
  p.stdout.on('data', keep); p.stderr.on('data', keep);
  p.name = name;
  procs.push(p);
  return p;
}
function stop(p) { return new Promise((r) => { if (p.exitCode !== null) return r(); p.once('exit', r); p.kill('SIGINT'); setTimeout(() => p.kill('SIGKILL'), 3000); }); }
function fill(text, map) { return Object.entries(map).reduce((t, [k, v]) => t.split(k).join(v), text); }
function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]);
}

async function main() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true });

  // 1) 키 · 송출 토큰 (실제 CLI)
  const jwk = execFileSync('node', [join(ROOT, 'worker/cam-keys.mjs'), 'new']).toString().trim();
  writeFileSync(join(RUN, 'k.jwk.json'), jwk);
  const pubTok = execFileSync('node', [join(ROOT, 'worker/cam-keys.mjs'), 'publish-token', '--key', join(RUN, 'k.jwk.json'), '--days', '1'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  const env = { CAM_JWT_PRIVATE_JWK: jwk, CAM_WHEP_URL: 'http://127.0.0.1:8889/cam/whep', CAM_TOKEN_TTL: String(TTL) };

  // 2) 가짜 Worker (cam.js 그대로, 세션 확인만 흉내)
  const worker = createServer(async (req, res) => {
    const cors = { 'access-control-allow-origin': PAGE, 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const r = await handleCamRoute(new Request(WORKER + req.url, { method: req.method, headers: req.headers }), env, {
      authenticate: async (rq) => rq.headers.get('authorization') === 'Bearer test-session' ? { login: 'tester' } : null,
    });
    const out = r || new Response('{}', { status: 404 });
    res.writeHead(out.status, { ...Object.fromEntries(out.headers), ...cors });
    res.end(Buffer.from(await out.arrayBuffer()));
  }).listen(8787, '127.0.0.1');
  servers.push(worker);

  // 3) 시험 페이지 (Workbench 출처 흉내)
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  const page = createServer((req, res) => {
    const p = join(ROOT, decodeURIComponent(new URL(req.url, PAGE).pathname));
    if (!p.startsWith(ROOT) || !existsSync(p) || !statSync(p).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' });
    res.end(readFileSync(p));
  }).listen(8080, '127.0.0.1');
  servers.push(page);

  // 4) 중계 서버: relay/mediamtx.yml 그대로 (자리 값만 채움)
  const relayConf = fill(readFileSync(join(ROOT, 'relay/mediamtx.yml'), 'utf8'), {
    __CAM_DOMAIN__: '127.0.0.1', __JWKS_URL__: WORKER + '/api/cam/jwks.json', __SRT_PASSPHRASE__: PASS, __APP_ORIGIN__: PAGE,
    '/recordings/': join(RUN, 'relay-rec') + '/',
  });
  writeFileSync(join(RUN, 'relay.yml'), relayConf);
  const relay = run('relay', MEDIAMTX, [join(RUN, 'relay.yml')]);

  // 5) 차량: car/mediamtx.yml 그대로 + 시험용으로 카메라 대신 RTSP 입력 (localhost 송출 허용)
  let carConf = fill(readFileSync(join(ROOT, 'car/mediamtx.yml'), 'utf8'), {
    __RELAY_HOST__: '127.0.0.1', __PUBLISH_TOKEN__: pubTok, __SRT_PASSPHRASE__: PASS, __SRT_LATENCY_MS__: '300',
    __REC_DIR__: join(RUN, 'car-rec'),
    'source: rpiCamera': 'source: publisher',
    '      - action: read\n      - action: api\n': '      - action: read\n      - action: api\n      - action: publish\n',
  });
  carConf = carConf.split('\n').filter((l) => !/^\s+rpiCamera/.test(l)).join('\n');
  writeFileSync(join(RUN, 'car.yml'), carConf);
  const car = run('car', MEDIAMTX, [join(RUN, 'car.yml')], {
    MTX_RTSP: 'yes', MTX_RTSPADDRESS: '127.0.0.1:18554', MTX_RTSPTRANSPORTS: 'tcp',
    MTX_WEBRTCADDRESS: '127.0.0.1:18889', MTX_WEBRTCLOCALUDPADDRESS: '127.0.0.1:18189', MTX_APIADDRESS: '127.0.0.1:19997',
  });
  await sleep(1500);
  for (const p of [relay, car]) if (p.exitCode !== null) throw new Error(p.name + ' 가 바로 끝남:\n' + p.log);

  const camera = () => run('camera', 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-c:v', 'libx264', '-profile:v', 'main', '-bf', '0', '-g', '30', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v', '2M', '-pix_fmt', 'yuv420p',
    '-f', 'rtsp', '-rtsp_transport', 'tcp', 'rtsp://127.0.0.1:18554/cam']);
  let cam = camera();

  console.log('\n[송출] 차량 → 중계');
  await until(async () => {
    const j = await (await fetch('http://127.0.0.1:19997/v3/paths/forward-dests/list?path=cam')).json();
    writeFileSync(join(RUN, 'forward.json'), JSON.stringify(j, null, 2));
    return j.items && j.items.some((d) => d.state === 'forwarding');
  }, 20000, '차량 forward 가 forwarding 상태').then(() => ok(true, '차량 MediaMTX 가 SRT 로 중계 서버에 송출 중 (JWT · 암호)'));
  const health = execFileSync('bash', [join(ROOT, 'car/health.sh')], { env: { ...process.env, SEM_CAM_API: 'http://127.0.0.1:19997/v3' } }).toString();
  ok(/카메라\s+: 켜짐/.test(health) && /송출\s+: 보내는 중/.test(health), 'car/health.sh 가 카메라 · 송출 상태를 읽음');

  console.log('\n[인증] 막혀야 하는 것');
  const whep = 'http://127.0.0.1:8889/cam/whep';
  ok((await fetch(whep, { method: 'OPTIONS' })).status === 401, '토큰 없이 WHEP → 401');
  ok((await fetch(WORKER + '/api/cam/token', { method: 'POST' })).status === 401, '세션 없이 시청 토큰 요청 → 401');
  ok((await fetch(WORKER + '/api/cam/token', { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status === 401, '틀린 세션으로 시청 토큰 요청 → 401');
  const other = await signCamToken(env, { sub: 'x', action: 'read', path: 'other', ttl: 60 });
  ok((await fetch(whep, { method: 'OPTIONS', headers: { authorization: 'Bearer ' + other.token } })).status === 401, '다른 경로용 토큰 → 401');
  const expired = await signCamToken(env, { sub: 'x', action: 'read', path: 'cam', ttl: 1, now: Date.now() - 120000 });
  ok((await fetch(whep, { method: 'OPTIONS', headers: { authorization: 'Bearer ' + expired.token } })).status === 401, '만료된 토큰 → 401');
  const forged = (await signCamToken({ CAM_JWT_PRIVATE_JWK: execFileSync('node', [join(ROOT, 'worker/cam-keys.mjs'), 'new']).toString().trim() }, { sub: 'x', action: 'read', path: 'cam', ttl: 60 })).token;
  ok((await fetch(whep, { method: 'OPTIONS', headers: { authorization: 'Bearer ' + forged } })).status === 401, '다른 키로 서명한 토큰 → 401');
  const good = await (await fetch(WORKER + '/api/cam/token', { method: 'POST', headers: { authorization: 'Bearer test-session' } })).json();
  ok(good.token && good.whep === env.CAM_WHEP_URL && good.exp - Date.now() / 1000 <= TTL + 1, 'Worker 가 시청 토큰 · WHEP 주소 발급');
  ok((await fetch(whep, { method: 'OPTIONS', headers: { authorization: 'Bearer ' + good.token } })).status < 300, '발급받은 토큰으로 WHEP → 통과');
  const readTok = good.token;
  const srtTry = (streamid, pass) => new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'mpegts',
      `srt://127.0.0.1:8890?streamid=${streamid}&passphrase=${pass}&pkt_size=1316`], { stdio: 'ignore' });
    p.on('exit', (c) => resolve(c));
  });
  ok(await srtTry('publish:cam:x:' + readTok, PASS) !== 0, '시청 토큰으로 SRT 송출 시도 → 거절');
  ok(await srtTry('publish:cam:car:' + pubTok, 'wrongpassphrase123') !== 0, '틀린 SRT 암호로 송출 시도 → 거절');
  const jwks = await (await fetch(WORKER + '/api/cam/jwks.json')).json();
  ok(jwks.keys.length === 1 && !('d' in jwks.keys[0]), '공개 키 (JWKS) 에 개인 키 값 (d) 없음');

  console.log('\n[재생] 헤드리스 크로미움 (웹 플레이어)');
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 600 }, deviceScaleFactor: SHOT ? 2 : 1 });
  const tab = await ctx.newPage();
  tab.on('console', (m) => { if (m.type() === 'error') console.log('    [console] ' + m.text()); });
  await tab.goto(`${PAGE}/test/demo.html?api=${encodeURIComponent(WORKER)}&token=test-session`);
  const st = () => tab.evaluate(() => {
    const c = window.__cam, v = c.cur && c.cur.video;
    return { state: c.state, renew: c.renewCount, w: v ? v.videoWidth : 0, h: v ? v.videoHeight : 0, t: v ? v.currentTime : 0, stats: c.statLine.textContent };
  });
  const t0 = Date.now();
  await until(async () => (await st()).state === 'live', 20000, 'live 상태');
  const s1 = await st();
  ok(true, `라이브 재생 시작 (${((Date.now() - t0) / 1000).toFixed(1)} 초)`);
  ok(s1.w === 1280 && s1.h === 720, `해상도 ${s1.w}×${s1.h}`);
  await sleep(3000);
  const s2 = await st();
  ok(s2.t > s1.t + 2, `영상이 흐름 (currentTime ${s1.t.toFixed(1)} → ${s2.t.toFixed(1)})`);
  ok(/fps/.test(s2.stats) && /bps/.test(s2.stats), `통계 표시: ${s2.stats}`);
  if (SHOT) await tab.screenshot({ path: SHOT });

  console.log(`\n[토큰 갈아 끼우기] 토큰 수명 ${TTL} 초 → ${TTL + 12} 초 동안 지켜봄`);
  let worst = 'live';
  const end = Date.now() + (TTL + 12) * 1000;
  while (Date.now() < end) { const s = await st(); if (s.state !== 'live') worst = s.state; await sleep(500); }
  const s3 = await st();
  ok(s3.renew >= 1, `새 토큰으로 갈아 끼움 ${s3.renew} 번`);
  ok(worst === 'live', `그동안 화면이 끊기지 않음 (가장 나빴던 상태: ${worst})`);
  const tA = (await st()).t; await sleep(2000); const tB = (await st()).t;
  ok(tB > tA + 1, '첫 토큰 만료 뒤에도 영상이 흐름');

  console.log('\n[차량 신호 끊김 → 복구]');
  await stop(cam);
  await until(async () => (await st()).state === 'waiting', 30000, 'waiting 상태').then(() => ok(true, '송출이 끊기면 "차량 신호 없음" 표시'));
  cam = camera();
  const t1 = Date.now();
  await until(async () => (await st()).state === 'live', 40000, '다시 live').then(() => ok(true, `송출이 돌아오면 자동 복구 (${((Date.now() - t1) / 1000).toFixed(1)} 초)`));
  const states = await tab.evaluate(() => window.__states.map((s) => s[1]).join(' → '));
  console.log('    상태 흐름: ' + states);
  await browser.close();

  console.log('\n[녹화]');
  await stop(cam);
  await sleep(1500);
  const carRec = files(join(RUN, 'car-rec')).filter((f) => f.endsWith('.mp4'));
  const relayRec = files(join(RUN, 'relay-rec')).filter((f) => f.endsWith('.mp4'));
  ok(carRec.length > 0 && carRec.some((f) => statSync(f).size > 100000), `차량 녹화 ${carRec.length} 개 (fMP4)`);
  ok(relayRec.length > 0 && relayRec.some((f) => statSync(f).size > 100000), `중계 서버 녹화 ${relayRec.length} 개 (fMP4)`);
  if (carRec[0]) {
    const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', carRec[0]]).toString().trim();
    ok(probe === 'h264,1280,720', `차량 녹화 파일 재생 가능 (${probe})`);
  }
}

main().catch((e) => { failed++; console.error('\n오류: ' + e.message); for (const p of procs) if (p.log) console.error(`--- ${p.name} 로그 (끝부분) ---\n` + p.log.slice(-3000)); })
  .finally(async () => {
    await Promise.all(procs.map(stop));
    servers.forEach((s) => s.close());
    console.log(failed ? `\n실패 ${failed} 건` : '\n모두 통과');
    process.exit(failed ? 1 : 0);
  });
