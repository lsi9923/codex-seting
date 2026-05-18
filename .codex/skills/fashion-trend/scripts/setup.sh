#!/bin/bash
# fashion-trend 스킬 — 환경 설정 스크립트
# Scrapling 설치 확인 + PATH 탐지 + 브라우저 설치

set -e

# scrapling 바이너리 경로 탐지
find_scrapling() {
    # 1. PATH에 있는지
    if command -v scrapling &>/dev/null; then
        echo "$(command -v scrapling)"
        return 0
    fi

    # 2. pip 사용자 설치 경로 (macOS)
    local user_bin="$HOME/Library/Python/3.12/bin/scrapling"
    if [ -f "$user_bin" ]; then
        echo "$user_bin"
        return 0
    fi

    # 3. Python 3.11 경로
    local user_bin_311="$HOME/Library/Python/3.11/bin/scrapling"
    if [ -f "$user_bin_311" ]; then
        echo "$user_bin_311"
        return 0
    fi

    # 4. pip show로 찾기
    local pip_location
    pip_location=$(python3 -m pip show scrapling 2>/dev/null | grep "Location:" | awk '{print $2}')
    if [ -n "$pip_location" ]; then
        local bin_dir=$(dirname "$pip_location")/bin/scrapling
        if [ -f "$bin_dir" ]; then
            echo "$bin_dir"
            return 0
        fi
    fi

    return 1
}

# 메인 로직
ACTION="${1:-check}"

case "$ACTION" in
    check)
        # 설치 상태 확인
        SCRAPLING_BIN=$(find_scrapling 2>/dev/null) || true

        if [ -n "$SCRAPLING_BIN" ]; then
            VERSION=$("$SCRAPLING_BIN" --help 2>/dev/null | head -1 || echo "installed")
            echo "{\"installed\": true, \"path\": \"$SCRAPLING_BIN\", \"version\": \"$VERSION\"}"
        else
            echo "{\"installed\": false, \"path\": null}"
        fi
        ;;

    install)
        echo "Scrapling 설치를 시작합니다..."
        pip3 install "scrapling[all]" 2>&1 | tail -5

        SCRAPLING_BIN=$(find_scrapling 2>/dev/null) || true
        if [ -z "$SCRAPLING_BIN" ]; then
            echo "ERROR: scrapling 설치 실패"
            exit 1
        fi

        echo "브라우저 설치 중... (1~2분 소요)"
        "$SCRAPLING_BIN" install 2>&1 | tail -3

        echo "{\"installed\": true, \"path\": \"$SCRAPLING_BIN\"}"
        ;;

    path)
        # scrapling 경로만 출력
        SCRAPLING_BIN=$(find_scrapling 2>/dev/null) || true
        if [ -n "$SCRAPLING_BIN" ]; then
            echo "$SCRAPLING_BIN"
        else
            echo "NOT_FOUND"
            exit 1
        fi
        ;;
esac
