#!/bin/sh
# 采集 + 构建。首次约 3-5 分钟，之后走缓存。
set -e
cd "$(dirname "$0")/.."
echo "== 采集 =="
python3 tools/collect.py
echo "== 构建 =="
python3 tools/build.py
echo "== 完成：index.html =="
