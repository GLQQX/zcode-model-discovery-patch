@echo off
setlocal
"%~dp0node.exe" "%~dp0install.mjs" --selftest
exit /b %ERRORLEVEL%
