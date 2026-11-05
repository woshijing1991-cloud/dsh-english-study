@echo off
rem English Study local gateway -- visible window (errors stay on screen).
rem
rem Optional AI (explain / translate). Leave both unset to stay 100% local:
rem   set "ES_API=https://your-openai-compatible-endpoint/v1/chat/completions"
rem   set "ES_MODEL=your-model-name"
rem   set "ES_KEY=your-api-key"        <- NEVER commit a real key to git
rem
rem Other knobs:
rem   set "ES_PORT=8788"               gateway port
rem   set "ES_HOST=127.0.0.1"          bind address (0.0.0.0 = also reachable from your phone)

title English Study gateway
if not defined ES_PYTHON set "ES_PYTHON=python"
cd /d "%~dp0gateway"
"%ES_PYTHON%" server.py
if errorlevel 1 pause
