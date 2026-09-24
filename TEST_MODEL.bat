@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title GLB Model Test

set "EXITCODE=1"
set "SOURCE=%~f1"
set "BAT_DIR=%~dp0"
set "LOG_DIR=%~dp0logs"
set "LOG_FILE=%LOG_DIR%\test-model-last.log"
set "TEST_MODEL_LOG=%LOG_FILE%"

if not exist "%LOG_DIR%" md "%LOG_DIR%" >nul 2>&1
>"%LOG_FILE%" echo Timestamp: %DATE% %TIME%
>>"%LOG_FILE%" echo Received file: "%~1"
>>"%LOG_FILE%" echo Resolved file: "%SOURCE%"
>>"%LOG_FILE%" echo Repo path: "%BAT_DIR%"
>>"%LOG_FILE%" echo Initial current directory: "%CD%"

echo BAT STARTED
echo ARG1=["%~1"]
echo BAT DIR=["%BAT_DIR%"]
echo CURRENT DIR=["%CD%"]
echo Diagnostic log: "%LOG_FILE%"
echo.

if "%~1"=="" (
  set "ERROR_MESSAGE=No file received. Drag a .glb file onto TEST_MODEL.bat."
  goto ERROR
)

if /I not "%~x1"==".glb" (
  set "ERROR_MESSAGE=The received file must use the .glb extension."
  goto ERROR
)

if not exist "%SOURCE%" (
  set "ERROR_MESSAGE=File not found: %SOURCE%"
  goto ERROR
)

where node.exe >nul 2>&1
if errorlevel 1 (
  set "ERROR_MESSAGE=Node.js was not found in PATH. Install or repair Node.js."
  goto ERROR
)

pushd "%BAT_DIR%" >nul 2>&1
if errorlevel 1 (
  set "ERROR_MESSAGE=Could not change to the project directory: %BAT_DIR%"
  goto ERROR
)

echo File received:
echo "%SOURCE%"
echo.
>>"%LOG_FILE%" echo Current directory before Node: "%CD%"
>>"%LOG_FILE%" echo Node version:
node.exe --version >>"%LOG_FILE%" 2>&1
>>"%LOG_FILE%" echo Command: call node.exe --max-old-space-size=8192 "%BAT_DIR%scripts\test-model.mjs" "%SOURCE%"

call node.exe --max-old-space-size=8192 "%BAT_DIR%scripts\test-model.mjs" "%SOURCE%"
set "EXITCODE=%ERRORLEVEL%"
>>"%LOG_FILE%" echo Node exit code: %EXITCODE%
popd

echo.
echo Node exit code: %EXITCODE%
if not "%EXITCODE%"=="0" (
  set "ERROR_MESSAGE=TEST_MODEL stopped because the Node workflow returned an error."
  goto ERROR
)

echo Preview stopped normally. Nothing was deployed to GitHub.
goto END

:ERROR
echo.
echo ============================================================
echo ERROR
echo "%ERROR_MESSAGE%"
echo See diagnostic log: "%LOG_FILE%"
echo ============================================================
>>"%LOG_FILE%" echo BAT error: "%ERROR_MESSAGE%"

:END
echo.
echo Final exit code: %EXITCODE%
echo Press any key to close.
pause >nul
endlocal & exit /b %EXITCODE%
