@echo off
rem dsh-purge 一键安装（Windows，双击即可）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 pause
