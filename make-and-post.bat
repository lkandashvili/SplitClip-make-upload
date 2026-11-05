@echo off
REM Render a split-screen captioned clip, then publish it.
REM Same arguments as make-and-post.ps1 - see .\make-and-post.ps1 -?
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-and-post.ps1" %*
echo.
pause
