#!/usr/bin/env bash
# 一键构建并推送 Store Layout Map 镜像
# 用法：./build.sh [image_tag]
# 例如：./build.sh latest-arm64
#       ./build.sh 1.2.0

set -euo pipefail

# ─── 读取镜像名 ────────────────────────────────────────────────────────────
# 优先使用命令行参数，其次读 .env / .env.deploy，最后用默认值
ENV_FILE=".env"
[[ ! -f "$ENV_FILE" ]] && ENV_FILE=".env.deploy"

BASE_IMAGE=$(grep -E '^IMAGE=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '[:space:]')
BASE_IMAGE="${BASE_IMAGE:-ccr.ccs.tencentyun.com/clobotics/labelstudio-storelayout:latest-amd64}"
timestamp=$(date +%Y%m%d%H%M%S)
# 去掉原有 tag，换成时间戳 tag
DEFAULT_IMAGE="${BASE_IMAGE%:*}:$timestamp"

IMAGE="${1:-$DEFAULT_IMAGE}"

echo "========================================"
echo "  Store Layout Map — 一键打包"
echo "  镜像: $IMAGE"
echo "  平台: linux/amd64"
echo "========================================"

cd "$(dirname "$0")"

# ─── 构建加速 ─────────────────────────────────────────────────────────────
# 默认开启 buildx 本地缓存；反复构建时可复用 yarn / poetry / webpack 等层缓存。
# 如需完全干净构建：BUILD_CACHE=0 ./build.sh [image_tag]
export DOCKER_BUILDKIT=1
BUILD_CACHE="${BUILD_CACHE:-1}"
BUILD_CACHE_DIR="${BUILD_CACHE_DIR:-.buildx-cache}"
BUILD_CACHE_NEXT_DIR="${BUILD_CACHE_DIR}.new"
BUILDX_BUILDER="${BUILDX_BUILDER:-storebev-buildx}"

CACHE_ARGS=()
BUILDER_ARGS=()
if [[ "$BUILD_CACHE" != "0" ]]; then
    # Docker Desktop 默认的 docker driver 不支持 --cache-to 导出本地缓存。
    # 使用 docker-container builder 可支持本地缓存导入/导出，并且仍可配合 --load 使用。
    if ! docker buildx inspect "$BUILDX_BUILDER" >/dev/null 2>&1; then
        echo "▶ 创建 buildx builder：$BUILDX_BUILDER"
        if ! docker buildx create --name "$BUILDX_BUILDER" --driver docker-container >/dev/null; then
            echo "⚠ 创建 buildx 缓存 builder 失败，自动退回无缓存构建"
            BUILD_CACHE=0
        fi
    fi

    BUILDX_DRIVER=$(docker buildx inspect "$BUILDX_BUILDER" 2>/dev/null | awk '/^Driver:/ { print $2; exit }' || true)
    if [[ "$BUILD_CACHE" != "0" && "$BUILDX_DRIVER" != "docker-container" ]]; then
        echo "⚠ buildx builder '$BUILDX_BUILDER' 使用 $BUILDX_DRIVER driver，不支持本地缓存导出，自动退回无缓存构建"
        BUILD_CACHE=0
    fi

    if [[ "$BUILD_CACHE" != "0" ]] && docker buildx inspect "$BUILDX_BUILDER" --bootstrap >/dev/null 2>&1; then
        mkdir -p "$BUILD_CACHE_DIR"
        rm -rf "$BUILD_CACHE_NEXT_DIR"
        BUILDER_ARGS=(--builder "$BUILDX_BUILDER")
        CACHE_ARGS=(
            --cache-from "type=local,src=$BUILD_CACHE_DIR"
            --cache-to "type=local,dest=$BUILD_CACHE_NEXT_DIR,mode=max"
        )
        echo "▶ 已启用 buildx 本地缓存：$BUILD_CACHE_DIR"
    else
        echo "⚠ 无法启动 buildx 缓存 builder，自动退回无缓存构建"
        BUILD_CACHE=0
    fi
fi

# ─── 同步 .env ─────────────────────────────────────────────────────────────
# 始终用 .env.deploy 覆盖 .env，确保配置一致
if [[ -f ".env.deploy" ]]; then
    cp .env.deploy .env
    echo "▶ 已同步 .env.deploy → .env"
fi

# ─── 构建 ──────────────────────────────────────────────────────────────────
echo ""
echo "▶ 开始构建..."
docker buildx build \
    "${BUILDER_ARGS[@]}" \
    --platform linux/amd64 \
    --tag "$IMAGE" \
    --load \
    "${CACHE_ARGS[@]}" \
    .

if [[ "$BUILD_CACHE" != "0" && -d "$BUILD_CACHE_NEXT_DIR" ]]; then
    rm -rf "$BUILD_CACHE_DIR"
    mv "$BUILD_CACHE_NEXT_DIR" "$BUILD_CACHE_DIR"
fi

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
