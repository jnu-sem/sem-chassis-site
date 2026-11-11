#!/usr/bin/env bash
# 중계 서버 준비: secrets.env 로 mediamtx.gen.yml 을 만들고 Docker 로 띄운다.
#   cd onboard-cam/relay && cp secrets.env.example secrets.env && (편집) && ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"

[ -f secrets.env ] || { echo "secrets.env 가 없습니다 (secrets.env.example 을 복사해 채우세요)"; exit 1; }
set -a; . ./secrets.env; set +a

for v in CAM_DOMAIN JWKS_URL SRT_PASSPHRASE APP_ORIGIN; do
  [ -n "${!v:-}" ] || { echo "secrets.env 의 $v 가 비었습니다"; exit 1; }
done
n=${#SRT_PASSPHRASE}; { [ "$n" -ge 10 ] && [ "$n" -le 79 ]; } || { echo "SRT_PASSPHRASE 는 10 ~ 79 자여야 합니다 (지금 $n 자)"; exit 1; }
case "$SRT_PASSPHRASE" in *[!A-Za-z0-9_.-]*) echo "SRT_PASSPHRASE 에는 영문 · 숫자 · _ . - 만 쓰세요 (차량 쪽 SRT 주소에 그대로 들어감)"; exit 1;; esac

esc() { printf '%s' "$1" | sed -e 's/[\/&|]/\\&/g'; }
sed -e "s|__CAM_DOMAIN__|$(esc "$CAM_DOMAIN")|g" \
    -e "s|__JWKS_URL__|$(esc "$JWKS_URL")|g" \
    -e "s|__SRT_PASSPHRASE__|$(esc "$SRT_PASSPHRASE")|g" \
    -e "s|__APP_ORIGIN__|$(esc "$APP_ORIGIN")|g" \
    mediamtx.yml > mediamtx.gen.yml
chmod 600 mediamtx.gen.yml
if grep -q '__[A-Z_]*__' mediamtx.gen.yml; then echo "채우지 못한 값이 남았습니다:"; grep -n '__[A-Z_]*__' mediamtx.gen.yml; exit 1; fi

mkdir -p recordings
echo "공개 키 확인: $JWKS_URL"
curl -fsS "$JWKS_URL" >/dev/null || { echo "Worker 공개 키를 받지 못했습니다 (CAM_JWT_PRIVATE_JWK 를 넣고 배포했는지 확인)"; exit 1; }

export CAM_DOMAIN
docker compose up -d
echo "완료. 방화벽: TCP 80 · 443 · 8189, UDP 8890 · 8189 를 여세요."
echo "시험: https://$CAM_DOMAIN/cam/whep 에 토큰 없이 OPTIONS 를 보내면 401 이 나와야 정상입니다."
