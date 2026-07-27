@echo off
rem Start the VOICEVOX engine in the foreground.
rem Close this window or press Ctrl+C to stop the engine.
rem
rem Messages are ASCII only on purpose: a .cmd file must match the console
rem code page, and non-ASCII text breaks when the file encoding differs.

setlocal
set "ENGINE=C:\Program Files\VOICEVOX\vv-engine\run.exe"
set "OPTIONS=--use_gpu"

if not exist "%ENGINE%" (
    echo.
    echo VOICEVOX engine not found:
    echo   %ENGINE%
    echo.
    echo Edit this file and set ENGINE to the correct path.
    echo.
    pause
    exit /b 1
)

echo Starting VOICEVOX engine ...
echo Close this window or press Ctrl+C to stop it.
echo.

"%ENGINE%" %OPTIONS%

echo.
echo Engine stopped.
pause
