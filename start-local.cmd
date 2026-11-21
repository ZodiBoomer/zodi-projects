@echo off
setlocal
cd /d "%~dp0.."
set ZODI_LOCAL_PC=1
set ZODI_UI=0
set NODE_ENV=development
set ELECTRON_RUN_AS_NODE=
set "ELECTRON_CLI=%CD%\node_modules\electron\cli.js"
set "ELECTRON_MAIN=%CD%\electron\main.js"
echo %date% %time% - start-local.cmd lance electron cli.js >> "electron\ui.log"
if not exist "%ELECTRON_CLI%" (
  echo %date% %time% - electron cli introuvable: %ELECTRON_CLI% >> "electron\ui.log"
  exit /b 1
)
node "%ELECTRON_CLI%" "%ELECTRON_MAIN%" >> "electron\ui.log" 2>&1
