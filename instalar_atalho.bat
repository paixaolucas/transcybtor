@echo off
:: Cria atalho do Transcybtor na Area de Trabalho com icone correto
chcp 65001 > nul 2>&1
setlocal EnableDelayedExpansion

:: Detecta a pasta onde este .bat esta localizado (caminho absoluto)
set "PASTA=%~dp0"
if "!PASTA:~-1!"=="\" set "PASTA=!PASTA:~0,-1!"

set "BAT=!PASTA!\transcribe.bat"
set "ICO=!PASTA!\assets\transcribe.ico"
set "DESKTOP=%USERPROFILE%\Desktop"
set "LNK=!DESKTOP!\Transcybtor.lnk"

echo.
echo   Criando atalho do Transcybtor na Area de Trabalho...
echo.

:: Grava script PowerShell temporario com caminhos absolutos
set "PS_TEMP=%TEMP%\criar_atalho_transcybtor.ps1"
(
  echo $ws = New-Object -ComObject WScript.Shell
  echo $sc = $ws.CreateShortcut("!LNK:\=\\!")
  echo $sc.TargetPath = "!BAT:\=\\!"
  echo $sc.IconLocation = "!ICO:\=\\!,0"
  echo $sc.WorkingDirectory = "!PASTA:\=\\!"
  echo $sc.Description = "Transcybtor - YouTube, TikTok, Instagram, MP3"
  echo $sc.WindowStyle = 1
  echo $sc.Save^(^)
) > "!PS_TEMP!"

powershell -NoProfile -ExecutionPolicy Bypass -File "!PS_TEMP!" > nul 2>&1
del "!PS_TEMP!" > nul 2>&1

if exist "!LNK!" (
  echo   OK  Atalho criado com sucesso!
  echo.
  echo   Local: !LNK!
  echo.
) else (
  echo   ERRO  Nao foi possivel criar o atalho.
  echo         Verifique se o arquivo existe:
  echo         !BAT!
  echo.
)

pause
