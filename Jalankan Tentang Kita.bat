@echo off
title Tentang Kita - Pembelian dan Persediaan
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0backend\run.ps1"
if errorlevel 1 (
  echo.
  echo Aplikasi berhenti kerana terjadi kesalahan. Baca pesan di atas.
  pause
)
