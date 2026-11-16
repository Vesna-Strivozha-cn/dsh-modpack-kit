#!/bin/sh
# DSH 整合包独立安装器（macOS / Linux）。需要 Node 20+。
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "没找到 node。安装 Node 20+ 后重跑，或按 README.txt 的「方式 B」手工执行 dsh plugin add。"
  exit 3
fi
exec node ./install.mjs "$@"
