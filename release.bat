@echo off
setlocal enabledelayedexpansion
title Vigie - publier une mise a jour

echo ============================================
echo   Vigie - publication d'une mise a jour
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] Node.js n'est pas installe.
  pause
  exit /b 1
)

if "%GH_TOKEN%"=="" (
  echo [ERREUR] La variable GH_TOKEN n'est pas definie.
  echo.
  echo Il faut un jeton GitHub pour publier la Release :
  echo   1. Va sur https://github.com/settings/tokens
  echo   2. "Generate new token" ^(classic^)
  echo   3. Coche uniquement la portee "repo"
  echo   4. Copie le jeton
  echo.
  echo Puis dans CETTE fenetre, avant de relancer le script :
  echo   set GH_TOKEN=colle_ton_jeton_ici
  echo.
  echo Pour ne plus avoir a le refaire a chaque fois :
  echo   setx GH_TOKEN colle_ton_jeton_ici
  echo   ^(puis ouvre une nouvelle fenetre^)
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -p "require('./package.json').version"') do set CURRENT=%%v
echo Version installee actuellement : !CURRENT!
echo.
echo   patch  = correction        ^(1.0.0 -^> 1.0.1^)
echo   minor  = nouveaute         ^(1.0.0 -^> 1.1.0^)
echo   major  = changement majeur ^(1.0.0 -^> 2.0.0^)
echo.
set /p BUMP="Type de version [patch] : "
if "!BUMP!"=="" set BUMP=patch

echo.
echo [1/3] Increment de la version...
call npm version !BUMP! --no-git-tag-version
if errorlevel 1 (
  echo [ERREUR] L'increment a echoue.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -p "require('./package.json').version"') do set NEWVER=%%v

echo.
echo [2/3] Installation des dependances...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo [ERREUR] npm install a echoue.
  pause
  exit /b 1
)

echo.
echo [3/3] Construction et publication de la version !NEWVER!...
call npm run release
if errorlevel 1 (
  echo.
  echo [ERREUR] La publication a echoue.
  echo Verifie que le depot github.com/PHENllX/vigie existe et est public.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   Version !NEWVER! publiee
echo ============================================
echo.
echo Les deux PC la proposeront automatiquement :
echo   - au demarrage de Vigie
echo   - puis toutes les 6 heures
echo   - ou tout de suite via l'icone barre systeme -^> Verifier les mises a jour
echo.
echo N'oublie pas d'enregistrer le changement de version :
echo   git add package.json package-lock.json
echo   git commit -m "v!NEWVER!"
echo   git push
echo.
pause
