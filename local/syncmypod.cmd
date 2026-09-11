@echo off
rem Launcher, so running this from a source checkout does not mean remembering
rem where the virtualenv went. Double-clicking it opens the window; passing
rem arguments runs any other command.
rem
rem This is a development convenience. The packaged build is a single .exe and
rem needs none of it.

setlocal

rem The virtualenv is deliberately kept outside the project directory: the
rem project lives in OneDrive, and a venv is thousands of files that would all
rem be synced for no reason.
set "VENV=%USERPROFILE%\.venvs\syncmypod\Scripts\syncmypod.exe"

if exist "%VENV%" (
    set "RUNNER=%VENV%"
) else (
    rem No virtualenv: fall back to whatever Python is on PATH, which works if
    rem the package was installed with `pip install -e .` globally.
    set "RUNNER=python -m syncmypod_local"
)

rem No arguments means someone double-clicked it, and the window is the thing
rem they wanted. `cmd /k` keeps the console open afterwards so the address and
rem any error stay readable rather than vanishing with the window.
if "%~1"=="" (
    %RUNNER% gui
    if errorlevel 1 pause
) else (
    %RUNNER% %*
)

endlocal
