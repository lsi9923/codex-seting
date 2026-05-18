#!/bin/bash
# fashion-trend 스킬 — KREAM 크롤링 실행 스크립트
# Usage: crawl.sh <scrapling_path> <url> <output_file> [timeout]

SCRAPLING_BIN="$1"
URL="$2"
OUTPUT_FILE="$3"
TIMEOUT="${4:-40000}"
WAIT="${5:-5000}"

if [ -z "$SCRAPLING_BIN" ] || [ -z "$URL" ] || [ -z "$OUTPUT_FILE" ]; then
    echo '{"success": false, "error": "MISSING_ARGS", "message": "사용법: crawl.sh <scrapling경로> <URL> <출력파일> [타임아웃] [대기시간]"}'
    exit 1
fi

# 크롤링 실행 (--wait로 JS 렌더링 완료 대기)
"$SCRAPLING_BIN" extract stealthy-fetch \
    "$URL" \
    "$OUTPUT_FILE" \
    --network-idle \
    --timeout "$TIMEOUT" \
    --wait "$WAIT" 2>&1

# 결과 검증
if [ ! -f "$OUTPUT_FILE" ]; then
    echo '{"success": false, "error": "NO_OUTPUT", "message": "크롤링 결과 파일이 생성되지 않았습니다."}'
    exit 1
fi

FILE_SIZE=$(wc -c < "$OUTPUT_FILE" | tr -d ' ')

if [ "$FILE_SIZE" -lt 1000 ]; then
    # 차단 감지 (정상 페이지는 최소 수십KB)
    if grep -qi "akamai\|blocked\|access denied\|bot detect" "$OUTPUT_FILE" 2>/dev/null; then
        echo "{\"success\": false, \"error\": \"BLOCKED\", \"message\": \"KREAM 봇 차단에 걸렸습니다. 잠시 후 다시 시도해주세요.\", \"file_size\": $FILE_SIZE}"
        exit 1
    fi
    echo "{\"success\": false, \"error\": \"EMPTY_RESULT\", \"message\": \"크롤링 결과가 비어있습니다. 페이지 로딩에 실패했을 수 있습니다.\", \"file_size\": $FILE_SIZE}"
    exit 1
fi

echo "{\"success\": true, \"file\": \"$OUTPUT_FILE\", \"file_size\": $FILE_SIZE}"
