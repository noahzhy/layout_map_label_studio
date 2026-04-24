#!/usr/bin/env bash
# 一键构建并推送 Label Studio 镜像
# 用法：./build.sh [image_tag]
# 例如：./build.sh latest-arm64
#       ./build.sh 1.2.0

set -euo pipefail

# ─── 读取镜像名 ────────────────────────────────────────────────────────────
# 优先使用命令行参数，其次读 .env / .env.deploy，最后用默认值
ENV_FILE=".env"
[[ ! -f "$ENV_FILE" ]] && ENV_FILE=".env.deploy"

DEFAULT_IMAGE=$(grep -E '^IMAGE=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '[:space:]')
DEFAULT_IMAGE="${DEFAULT_IMAGE:-ccr.ccs.tencentyun.com/clobotics/labelstudio-storelayout:latest-amd64}"

IMAGE="${1:-$DEFAULT_IMAGE}"

echo "========================================"
echo "  Label Studio — 一键打包"
echo "  镜像: $IMAGE"
echo "  平台: linux/amd64"
echo "========================================"

cd "$(dirname "$0")"

# ─── 构建 ──────────────────────────────────────────────────────────────────
echo ""
echo "▶ 开始构建..."
docker buildx build \
    --platform linux/amd64 \
    --tag "$IMAGE" \
    --load \
    .

echo ""
echo "▶ 构建成功：$IMAGE"

# ─── 推送 ──────────────────────────────────────────────────────────────────
read -rp "是否推送到镜像仓库？[y/N] " PUSH
if [[ "$PUSH" =~ ^[Yy]$ ]]; then
    echo "▶ 推送中..."
    docker push "$IMAGE"
    echo "▶ 推送完成：$IMAGE"
fi

echo ""
echo "========================================"
echo "  完成！启动命令："
echo "  docker compose -f docker-compose.deploy.yml up -d"
echo "========================================"
