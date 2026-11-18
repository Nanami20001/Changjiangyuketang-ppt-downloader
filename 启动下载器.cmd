@echo off
setlocal
pushd "%~dp0" || exit /b 1

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo Node.js 22.12 or newer is required to run from source.
  echo Install Node.js and double-click this file again, or use the portable EXE.
  goto failed
)

if not exist "node_modules\electron\dist\electron.exe" goto install
if not exist "node_modules\.bin\electron.cmd" goto install
if not exist "node_modules\pdf-lib\package.json" goto install
goto launch

:install
echo Installing dependencies for the first launch...
call npm.cmd ci --include=dev
if errorlevel 1 goto failed

:launch
call npm.cmd start
if errorlevel 1 goto failed
popd
exit /b 0

:failed
echo The downloader could not start. See the message above.
pause
popd
exit /b 1
