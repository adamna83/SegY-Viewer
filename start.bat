@echo off
setlocal
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found on PATH.
  echo Install Python 3, or open index.html directly in the browser.
  pause
  exit /b 1
)
echo Starting SEG-Y Studio on http://127.0.0.1:8765 ...
python serve.py %*
if errorlevel 1 pause
endlocal
