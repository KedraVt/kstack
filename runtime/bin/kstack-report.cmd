@echo off
REM %ERRORLEVEL% must be read AFTER the block — inside one it is expanded
REM at parse time (always 0) and the CLI's exit code would be lost.
if exist "%ProgramFiles%\Git\bin\bash.exe" (
  "%ProgramFiles%\Git\bin\bash.exe" "%~dp0kstack-report" %*
) else (
  bash "%~dp0kstack-report" %*
)
exit /b %ERRORLEVEL%
