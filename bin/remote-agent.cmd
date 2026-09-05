@echo off
rem Windows launcher for the CLI; Scoop shims this onto PATH.
bun "%~dp0..\src\cli\main.ts" %*
