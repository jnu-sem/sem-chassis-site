#!/usr/bin/env bash
# 차량 (라즈베리 파이 4, Raspberry Pi OS Bookworm/Trixie 64-bit) 설치
#   cd onboard-cam/car && cp secrets.env.example secrets.env && (편집) && sudo ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"

MTX_VERSION=v1.21.3
[ "$(id -u)" -eq 0 ] || { echo "sudo 로 실행하세요"; exit 1; }
[ -f secrets.env ] || { echo "secrets.env 가 없습니다 (secrets.env.example 을 복사해 채우세요)"; exit 1; }
set -a; . ./secrets.env; set +a

for v in RELAY_HOST CAM_PUBLISH_TOKEN SRT_PASSPHRASE SRT_LATENCY_MS REC_DIR; do
  [ -n "${!v:-}" ] || { echo "secrets.env 의 $v 가 비었습니다"; exit 1; }
done
n=${#SRT_PASSPHRASE}; { [ "$n" -ge 10 ] && [ "$n" -le 79 ]; } || { echo "SRT_PASSPHRASE 는 10 ~ 79 자여야 합니다"; exit 1; }
case "$SRT_PASSPHRASE" in *[!A-Za-z0-9_.-]*) echo "SRT_PASSPHRASE 에는 영문 · 숫자 · _ . - 만 쓰세요"; exit 1;; esac
case "$CAM_PUBLISH_TOKEN" in *[!A-Za-z0-9_.-]*) echo "CAM_PUBLISH_TOKEN 이 JWT 모양이 아닙니다"; exit 1;; esac
case "$SRT_LATENCY_MS" in *[!0-9]*) echo "SRT_LATENCY_MS 는 숫자 (ms)"; exit 1;; esac

case "$(uname -m)" in
  aarch64) ARCH=arm64 ;;
  armv7l)  ARCH=armv7 ;;
  *) echo "라즈베리 파이 (arm64 / armv7) 에서 실행하세요: $(uname -m)"; exit 1 ;;
esac

# 1) MediaMTX (카메라 지원 포함, 공식 배포본)
if ! /usr/local/bin/mediamtx --version 2>/dev/null | grep -q "$MTX_VERSION"; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/m.tgz" "https://github.com/bluenviron/mediamtx/releases/download/${MTX_VERSION}/mediamtx_${MTX_VERSION}_linux_${ARCH}.tar.gz"
  tar -C "$tmp" -xzf "$tmp/m.tgz" mediamtx
  install -m 755 "$tmp/mediamtx" /usr/local/bin/mediamtx
  rm -rf "$tmp"
fi

# 2) 실행 계정 · 폴더
id sem-cam >/dev/null 2>&1 || useradd --system --home /var/lib/sem-cam --shell /usr/sbin/nologin --groups video sem-cam
install -d -o sem-cam -g sem-cam -m 750 /var/lib/sem-cam "$REC_DIR"
install -d -m 750 -g sem-cam /etc/sem-cam

# 3) 설정 (비밀 값을 채워 root · sem-cam 만 읽게)
esc() { printf '%s' "$1" | sed -e 's/[\/&|]/\\&/g'; }
sed -e "s|__RELAY_HOST__|$(esc "$RELAY_HOST")|g" \
    -e "s|__PUBLISH_TOKEN__|$(esc "$CAM_PUBLISH_TOKEN")|g" \
    -e "s|__SRT_PASSPHRASE__|$(esc "$SRT_PASSPHRASE")|g" \
    -e "s|__SRT_LATENCY_MS__|$(esc "$SRT_LATENCY_MS")|g" \
    -e "s|__REC_DIR__|$(esc "$REC_DIR")|g" \
    mediamtx.yml > /etc/sem-cam/mediamtx.yml
chown root:sem-cam /etc/sem-cam/mediamtx.yml
chmod 640 /etc/sem-cam/mediamtx.yml
if grep -q '__[A-Z_]*__' /etc/sem-cam/mediamtx.yml; then echo "채우지 못한 값:"; grep -n '__[A-Z_]*__' /etc/sem-cam/mediamtx.yml; exit 1; fi

# 4) 서비스
install -m 644 sem-cam.service /etc/systemd/system/sem-cam.service
install -m 755 health.sh /usr/local/bin/sem-cam-health
systemctl daemon-reload
systemctl enable --now sem-cam
sleep 3
systemctl --no-pager --lines=15 status sem-cam || true
echo
echo "확인: sem-cam-health   ·   미리보기 (같은 망 노트북): http://$(hostname -I | awk '{print $1}'):8889/cam"
