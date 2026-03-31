@echo off
:: Habilita UTF-8 e cores ANSI no terminal
chcp 65001 > nul 2>&1
reg add "HKCU\Console" /v VirtualTerminalLevel /t REG_DWORD /d 1 /f > nul 2>&1

:: Passa o arquivo/URL arrastado (ou nenhum argumento) para o menu Node.js
node "%~dp0src\menu.mjs" %*
