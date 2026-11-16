#!/bin/sh
# 重新生成并推送到 GitHub Pages（推送后 Pages 约 30 秒自动重建）
#   ./tools/deploy.sh            只重新构建页面并推送
#   ./tools/deploy.sh --refresh  先重抓频道数据，再构建推送
set -e
cd "$(dirname "$0")/.."

if [ "$1" = "--refresh" ]; then
  echo "== 采集频道数据 =="
  python3 tools/collect.py
fi

echo "== 构建 index.html =="
python3 tools/build.py

if [ -z "$(git status --porcelain)" ]; then
  echo "没有变化，无需推送。"
  exit 0
fi

git add -A
git commit -m "更新索引：$(date '+%Y-%m-%d %H:%M')"
git push origin main

# 从 remote 推出 Pages 地址，避免把账号名写死在文件里
slug=$(git config --get remote.origin.url | sed -e 's#.*github\.com[:/]##' -e 's#\.git$##')
owner=$(printf '%s' "$slug" | cut -d/ -f1 | tr 'A-Z' 'a-z')
repo=$(printf '%s' "$slug" | cut -d/ -f2)
echo "== 已推送，Pages 约 30 秒后生效 =="
echo "   https://$owner.github.io/$repo/"
