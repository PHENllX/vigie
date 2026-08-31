@echo off
setlocal
title Vigie - construction de l'installateur

echo ============================================
echo   Vigie - construction du .exe
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] Node.js n'est pas installe.
  echo Installe-le depuis https://nodejs.org ^(version LTS^), puis relance ce script.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do echo Node.js detecte : %%v
echo.

echo [1/2] Installation des dependances ^(quelques minutes la premiere fois^)...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo [ERREUR] L'installation des dependances a echoue.
  pause
  exit /b 1
)

echo.
echo [2/2] Construction de l'installateur Windows...
call npm run dist
if errorlevel 1 (
  echo.
  echo [ERREUR] La construction a echoue.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   Termine !
echo ============================================
echo.
echo L'installateur se trouve dans :
echo   %CD%\dist\
echo.
echo Fichier : "Vigie Setup 1.0.0.exe"
echo.
echo Copie-le sur les deux PC et lance-le.
echo.
pause
