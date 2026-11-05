@echo off
rem English Study local gateway -- hidden/startup path (no console, no pause).
rem The DSH plugin calls this file automatically when the gateway is down.
rem No key is stored here: set ES_API / ES_MODEL / ES_KEY in your environment
rem (user or system variables) if you want AI; otherwise it runs local-only.
setlocal
if not defined ES_PYTHON set "ES_PYTHON=python"
cd /d "%~dp0gateway"
"%ES_PYTHON%" server.py
