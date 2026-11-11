#!/usr/bin/env bash
# 차량 카메라 상태 한눈에 (파이에서: sem-cam-health,  피트에서: ssh pi@<주소> sem-cam-health)
API=${SEM_CAM_API:-http://127.0.0.1:9997/v3}
REC_DIR=$(grep -oP '^\s+recordPath:\s+\K[^%]+' /etc/sem-cam/mediamtx.yml 2>/dev/null | sed 's|/$||')

echo "== 서비스";   systemctl is-active sem-cam 2>/dev/null || true
echo "== 카메라 · 송출"
{ curl -fsS "$API/paths/get/cam"; echo; curl -fsS "$API/paths/forward-dests/list?path=cam"; } 2>/dev/null | python3 -c '
import json, sys
lines = [l for l in sys.stdin.read().splitlines() if l.strip()]
if len(lines) < 2:
    print("  MediaMTX API 에 닿지 않음 (서비스가 멈췄나?)"); sys.exit()
p, f = json.loads(lines[0]), json.loads(lines[1])
print("  카메라   :", "켜짐" if p.get("online") else "꺼짐", "· 받은 데이터 %.1f MB" % (p.get("inboundBytes", 0) / 1e6))
for d in f.get("items", []):
    t = d.get("typeSpecific") or {}
    sent, re_, drop = t.get("packetsSentUnique", 0), t.get("packetsRetrans", 0), t.get("packetsSendDrop", 0)
    print("  송출     :", {"forwarding": "보내는 중", "idle": "대기", "error": "오류"}.get(d.get("state"), d.get("state")),
          "· RTT %.0f ms" % t.get("msRTT", 0),
          "· 재전송 %.1f%%" % (100.0 * re_ / sent if sent else 0),
          "· 버림 %d" % drop,
          "· 보낸 양 %.1f MB" % (d.get("outboundBytes", 0) / 1e6))
    if d.get("lastError"): print("  마지막 오류:", d["lastError"])
'
echo "== 파이"
command -v vcgencmd >/dev/null && { vcgencmd measure_temp; t=$(vcgencmd get_throttled | cut -d= -f2); [ "$t" = "0x0" ] && echo "throttled=없음" || echo "throttled=$t (0x50000 이상이면 전압 부족 · 과열 이력)"; }
[ -n "$REC_DIR" ] && df -h "$REC_DIR" | tail -1 | awk '{print "녹화 공간: " $4 " 남음 (" $5 " 사용)"}'
echo "== 네트워크"; ip -br addr | grep -v '^lo' ; ip route get 1.1.1.1 2>/dev/null | head -1
