@echo off
if exist "%ProgramFiles%\Git\bin\bash.exe" (
  "%ProgramFiles%\Git\bin\bash.exe" "%~dp0kstack-report" %*
  exit /b %ERRORLEVEL%
)
bash "%~dp0kstack-report" %*
exit /b %ERRORLEVEL%
