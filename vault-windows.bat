@echo off
:: -ExecutionPolicy Bypass temporarily allows the setup script to run on Windows
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "%~dp0scripts\_windows-setup.ps1"
if %ERRORLEVEL% neq 0 pause
