@echo off
rem DSH 整合包独立安装器（Windows）。需要 Node 20+；没有 Node 时按 README.txt 里的手工步骤装。
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo 没找到 node。可以：
  echo   1. 安装 Node 20+ 后重跑本脚本；
  echo   2. 或按 README.txt 的「方式 B」手工执行 dsh plugin add。
  pause
  exit /b 3
)
node "%~dp0install.mjs" %*
set code=%errorlevel%
pause
exit /b %code%
