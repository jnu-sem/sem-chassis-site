/*
 * SEM Workbench — 온보드 카메라 라이브 플레이어 (T-cam)
 *
 * 쓰는 법 (앱 안, mediamtx-reader.js 다음에 이 파일):
 *   const cam = SemLiveCam.mount(document.getElementById('live'), {
 *     api: window.__SEM_AUTH__.api,             // 생략하면 이 값
 *     token: () => window.__SEM_AUTH__.token,   // 생략하면 이 값 (세션 토큰)
 *   });
 *   cam.destroy();                              // 탭을 떠날 때
 *
 * 하는 일
 *   1) Worker POST /api/cam/token 으로 짧은 시청 토큰 + WHEP 주소를 받는다.
 *   2) MediaMTX WHEP (WebRTC) 로 재생한다. 지연 약 1 초.
 *   3) 토큰이 끝나기 전에 새 토큰으로 두 번째 연결을 열고, 첫 화면이 나오면 바꿔 끼운다 (끊김 없음).
 *   4) 차량 신호가 끊기면 '차량 신호 없음' 을 띄우고 알아서 다시 붙는다.
 *   5) 해상도 · fps · 비트레이트 · 손실률 표시.
 *
 * 상태 (root 에 'semlivecam:state' 이벤트, cam.state):
 *   connecting · live · waiting (차량 송출 없음) · reconnecting · stalled · login · forbidden · unsupported · error
 */
(function () {
  'use strict';

  var CSS = [
    '.slc{position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:8px;overflow:hidden;color:#fff;font:13px/1.4 inherit;font-family:inherit;user-select:none}',
    '.slc video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;opacity:0;transition:opacity .25s}',
    '.slc video.on{opacity:1}',
    '.slc-top{position:absolute;left:10px;right:10px;top:10px;display:flex;align-items:center;gap:8px;pointer-events:none}',
    '.slc-badge{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:4px;background:rgba(0,0,0,.55);font-weight:600;letter-spacing:.04em;font-size:12px}',
    '.slc-dot{width:8px;height:8px;border-radius:50%;background:#8a8f98}',
    '.slc[data-state=live] .slc-dot{background:#ff3b30;animation:slcB 1.6s ease-in-out infinite}',
    '.slc[data-state=stalled] .slc-dot,.slc[data-state=reconnecting] .slc-dot,.slc[data-state=connecting] .slc-dot{background:#ffb020}',
    '@keyframes slcB{50%{opacity:.35}}',
    '@media (prefers-reduced-motion:reduce){.slc-dot{animation:none!important}.slc video{transition:none}}',
    '.slc-sp{flex:1}',
    '.slc-fs{pointer-events:auto;min-height:0;padding:4px 8px;border:0;border-radius:4px;background:rgba(0,0,0,.55);color:#fff;font:inherit;font-size:12px;cursor:pointer}',
    '.slc-fs:hover{background:rgba(0,0,0,.75)}',
    '.slc-fs:focus-visible{outline:2px solid #6A9BF0;outline-offset:2px}',
    '.slc-msg{position:absolute;inset:0;display:grid;place-items:center;padding:16px;text-align:center;font-size:14px;color:#d8dde5;pointer-events:none}',
    '.slc[data-state=live] .slc-msg{display:none}',
    '.slc-stats{position:absolute;left:10px;bottom:8px;padding:2px 6px;border-radius:4px;background:rgba(0,0,0,.55);font-size:11.5px;font-variant-numeric:tabular-nums;color:#e6eaf0}',
    '.slc-stats:empty{display:none}',
  ].join('\n');

  var MSG = {
    connecting: '연결하는 중…',
    live: '',
    waiting: '차량 신호 없음 — 카메라가 송출을 시작하면 자동으로 나옵니다',
    reconnecting: '다시 연결하는 중…',
    stalled: '신호가 약합니다 — 화면이 멈춰 있습니다',
    login: '로그인이 끝났습니다. 다시 로그인하세요.',
    forbidden: '라이브 카메라를 볼 권한이 없습니다.',
    unsupported: '이 브라우저는 WebRTC 재생을 지원하지 않습니다.',
    error: '연결하지 못했습니다. 잠시 뒤 다시 시도합니다.',
  };
  var BADGE = { live: 'LIVE', stalled: 'LIVE', waiting: 'OFFLINE', login: 'OFFLINE', forbidden: 'OFFLINE', unsupported: 'OFFLINE' };

  function injectCss() {
    if (document.getElementById('slc-css')) return;
    var s = document.createElement('style');
    s.id = 'slc-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function el(tag, cls, attrs) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }

  function fmtRate(bps) {
    return bps >= 1e6 ? (bps / 1e6).toFixed(1) + ' Mbps' : Math.round(bps / 1e3) + ' kbps';
  }

  function LiveCam(root, opts) {
    var auth = window.__SEM_AUTH__ || {};
    opts = opts || {};
    this.root = root;
    this.api = String(opts.api || auth.api || '').replace(/\/+$/, '');
    this.tokenOf = typeof opts.token === 'function' ? opts.token
      : opts.token ? function () { return opts.token; }
      : function () { return (window.__SEM_AUTH__ || {}).token || ''; };
    this.renewLead = (opts.renewBeforeSec || 120) * 1000;   // 토큰 만료 몇 초 전에 갈아 끼울지
    this.state = '';
    this.renewCount = 0;
    this.cur = null;      // { reader, video, ticket, receiver }
    this.next = null;     // 갈아 끼우는 중인 연결
    this.timers = {};
    this.retryMs = 2000;
    this.dead = false;
    this.stats = { bytes: 0, at: 0, lost: 0, recv: 0 };
    this.lastFrame = { t: -1, at: 0 };

    if (typeof window.MediaMTXWebRTCReader !== 'function' || typeof RTCPeerConnection !== 'function') {
      this.build();
      this.setState('unsupported');
      return;
    }
    this.build();
    this.connect(false);
    var self = this;
    this.timers.stats = setInterval(function () { self.tick(); }, 1000);
  }

  LiveCam.prototype.build = function () {
    injectCss();
    var box = el('div', 'slc', { 'data-state': 'connecting' });
    this.videos = [0, 1].map(function () {
      var v = el('video', '', { playsinline: '', 'aria-label': '차량 온보드 카메라 라이브' });
      v.muted = true; v.autoplay = true; v.playsInline = true;
      box.appendChild(v);
      return v;
    });
    var top = el('div', 'slc-top');
    var badge = el('span', 'slc-badge');
    badge.appendChild(el('span', 'slc-dot', { 'aria-hidden': 'true' }));
    this.badgeText = el('span');
    badge.appendChild(this.badgeText);
    top.appendChild(badge);
    top.appendChild(el('span', 'slc-sp'));
    var fs = el('button', 'slc-fs', { type: 'button', title: '전체 화면' });
    fs.textContent = '전체 화면';
    fs.addEventListener('click', function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (box.requestFullscreen) box.requestFullscreen();
    });
    if (!document.fullscreenEnabled) fs.hidden = true;
    top.appendChild(fs);
    box.appendChild(top);
    this.msg = el('div', 'slc-msg', { role: 'status', 'aria-live': 'polite' });
    box.appendChild(this.msg);
    this.statLine = el('div', 'slc-stats');
    box.appendChild(this.statLine);
    this.box = box;
    this.root.appendChild(box);
  };

  LiveCam.prototype.setState = function (s) {
    if (this.state === s) return;
    this.state = s;
    this.box.setAttribute('data-state', s);
    this.badgeText.textContent = BADGE[s] || '···';
    this.msg.textContent = MSG[s] || '';
    if (s !== 'live' && s !== 'stalled') this.statLine.textContent = '';
    this.root.dispatchEvent(new CustomEvent('semlivecam:state', { detail: { state: s } }));
  };

  // Worker 에서 시청 토큰 받기
  LiveCam.prototype.ticket = function () {
    var self = this;
    return fetch(this.api + '/api/cam/token', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + this.tokenOf() },
      cache: 'no-store',
      credentials: 'omit',
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (r.ok && j && j.token && j.whep) return j;
        var e = new Error((j && j.message) || ('HTTP ' + r.status));
        e.status = r.status;
        throw e;
      });
    }, function () {
      var e = new Error('network'); e.status = 0; throw e;
    }).then(function (t) {
      if (self.dead) throw new Error('closed');
      return t;
    });
  };

  // renew = false: 처음 · 끊긴 뒤 다시 연결. renew = true: 토큰 갈아 끼우기 (지금 화면은 그대로 둔 채)
  LiveCam.prototype.connect = function (renew) {
    var self = this;
    if (this.dead) return;
    clearTimeout(this.timers.retry);
    if (!renew) {
      clearTimeout(this.timers.renew);
      this.setState(this.cur ? 'reconnecting' : 'connecting');
    }
    this.ticket().then(function (t) {
      if (self.dead) return;
      // 예전 연결을 먼저 정리한 뒤 (같은 <video> 를 다시 쓰므로) 새 연결을 붙인다
      var video;
      if (renew) {
        if (self.next) { self.drop(self.next); self.next = null; }
        if (!self.cur) return self.connect(false);
        video = self.cur.video === self.videos[0] ? self.videos[1] : self.videos[0];
      } else {
        if (self.cur) { self.drop(self.cur); self.cur = null; }
        if (self.next) { self.drop(self.next); self.next = null; }
        video = self.videos[0];
      }
      var conn = { ticket: t, video: video, receiver: null, reader: null };
      video.onplaying = function () { self.onPlaying(conn); };
      if (renew) self.next = conn; else self.cur = conn;
      conn.reader = new window.MediaMTXWebRTCReader({
        url: t.whep,
        token: t.token,
        onTrack: function (evt) {
          if (evt.track.kind !== 'video') return;
          conn.receiver = evt.receiver;
          video.srcObject = evt.streams[0];
          var p = video.play();
          if (p && p.catch) p.catch(function () { /* 음소거라 대개 자동 재생됨 */ });
        },
        onError: function (err) { self.onReaderError(conn, String(err)); },
      });
    }, function (e) {
      if (self.dead || e.message === 'closed') return;
      if (renew) {
        // 갈아 끼우기 실패: 지금 연결은 살려 두고 조금 뒤 다시
        self.timers.renew = setTimeout(function () { self.connect(true); }, 30000);
        return;
      }
      if (e.status === 401) return self.setState('login');
      if (e.status === 403) return self.setState('forbidden');
      self.setState('error');
      self.retryLater(e.status === 503 ? 60000 : 0);
    });
  };

  LiveCam.prototype.retryLater = function (ms) {
    var self = this;
    var wait = ms || this.retryMs;
    this.retryMs = Math.min(30000, this.retryMs * 2);
    clearTimeout(this.timers.retry);
    this.timers.retry = setTimeout(function () { self.connect(false); }, wait);
  };

  LiveCam.prototype.onPlaying = function (conn) {
    if (this.dead) return;
    this.retryMs = 2000;
    if (conn === this.next) {
      // 새 토큰 연결의 첫 화면이 나왔다 → 바꿔 끼우고 예전 연결을 닫는다
      var old = this.cur;
      this.cur = conn;
      this.next = null;
      conn.video.classList.add('on');
      if (old) this.drop(old);
      this.renewCount++;
    } else if (conn === this.cur) {
      conn.video.classList.add('on');
    } else {
      return;
    }
    this.stats = { bytes: 0, at: 0, lost: 0, recv: 0 };
    this.lastFrame = { t: -1, at: Date.now() };
    this.setState('live');
    this.scheduleRenew(conn.ticket);
  };

  LiveCam.prototype.scheduleRenew = function (t) {
    var self = this;
    clearTimeout(this.timers.renew);
    var left = t.exp * 1000 - Date.now();
    var lead = Math.min(this.renewLead, left / 3);
    var wait = Math.max(5000, left - lead);
    this.timers.renew = setTimeout(function () { self.connect(true); }, wait);
  };

  LiveCam.prototype.onReaderError = function (conn, err) {
    if (this.dead) return;
    var auth = /\b401\b/.test(err);
    if (conn === this.next) {
      // 갈아 끼우기 연결은 조용히 버리고 나중에 다시
      if (auth || !/retrying/.test(err)) {
        this.drop(conn); this.next = null;
        var self = this;
        clearTimeout(this.timers.renew);
        this.timers.renew = setTimeout(function () { self.connect(true); }, 30000);
      }
      return;
    }
    if (conn !== this.cur) return;
    conn.video.classList.remove('on');
    if (auth) {
      // 토큰이 끝났거나 틀림 → 새 토큰으로 처음부터
      this.drop(conn); this.cur = null;
      this.setState('reconnecting');
      this.retryLater(0);
    } else if (/stream not found/.test(err)) {
      this.setState('waiting');           // 리더가 2 초마다 스스로 다시 시도
    } else if (/retrying/.test(err)) {
      this.setState('reconnecting');      // 리더가 스스로 다시 시도
    } else {
      this.drop(conn); this.cur = null;   // 리더가 포기함 (코덱 확인 실패 등)
      this.setState('unsupported');
    }
  };

  LiveCam.prototype.drop = function (conn) {
    try { conn.reader && conn.reader.close(); } catch (e) { /* 이미 닫힘 */ }
    conn.video.onplaying = null;
    conn.video.classList.remove('on');
    conn.video.srcObject = null;
  };

  // 1 초마다: 멈춤 감지 · 통계
  LiveCam.prototype.tick = function () {
    var self = this;
    var c = this.cur;
    if (!c || (this.state !== 'live' && this.state !== 'stalled')) return;
    var v = c.video, now = Date.now();
    if (v.currentTime !== this.lastFrame.t) { this.lastFrame = { t: v.currentTime, at: now }; if (this.state === 'stalled') this.setState('live'); }
    else if (now - this.lastFrame.at > 4000 && this.state === 'live') this.setState('stalled');
    if (!c.receiver || !c.receiver.getStats) return;
    c.receiver.getStats().then(function (rep) {
      rep.forEach(function (s) {
        if (s.type !== 'inbound-rtp' || s.kind !== 'video') return;
        var st = self.stats, parts = [];
        if (s.frameWidth) parts.push(s.frameWidth + '×' + s.frameHeight);
        if (s.framesPerSecond) parts.push(Math.round(s.framesPerSecond) + ' fps');
        if (st.at) {
          var bps = (s.bytesReceived - st.bytes) * 8000 / Math.max(1, s.timestamp - st.at);
          parts.push(fmtRate(bps));
          var dl = (s.packetsLost || 0) - st.lost, dr = (s.packetsReceived || 0) - st.recv;
          if (dl + dr > 0) parts.push('손실 ' + (100 * Math.max(0, dl) / (dl + dr)).toFixed(1) + '%');
        }
        if (s.jitterBufferEmittedCount) parts.push('버퍼 ' + Math.round(1000 * s.jitterBufferDelay / s.jitterBufferEmittedCount) + ' ms');
        self.stats = { bytes: s.bytesReceived, at: s.timestamp, lost: s.packetsLost || 0, recv: s.packetsReceived || 0 };
        if (self.cur === c) self.statLine.textContent = parts.join(' · ');
      });
    }).catch(function () { /* 연결이 바뀌는 중 */ });
  };

  LiveCam.prototype.destroy = function () {
    this.dead = true;
    Object.keys(this.timers).forEach(function (k) { clearTimeout(this.timers[k]); clearInterval(this.timers[k]); }, this);
    if (this.cur) this.drop(this.cur);
    if (this.next) this.drop(this.next);
    this.cur = this.next = null;
    if (this.box && this.box.parentNode) this.box.parentNode.removeChild(this.box);
  };

  window.SemLiveCam = { mount: function (root, opts) { return new LiveCam(root, opts); } };
})();
