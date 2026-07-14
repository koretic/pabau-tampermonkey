#!/usr/bin/env python3
# =============================================================
#  build_deploy.py
#  Genera deploy.bat amb el TamperMonkey_documentacion_script.user.js
#  incrustat en base64. Self-contained: no depen de cap plantilla.
#
#  US:
#    1. Edita TamperMonkey_documentacion_script.js
#    2. python3 build_deploy.py
#    3. Distribueix deploy.bat als 19 PCs
#
#  Requereix: Python 3.6+ (pot ser Windows, Linux o Mac)
# =============================================================

import base64
import datetime
import pathlib
import re
import sys

# -------------------------------------------------------------
# CONFIGURACIO
# -------------------------------------------------------------
SRC = "TamperMonkey_documentacion_script.user.js"   # entrada
OUT = "deploy.bat"                                     # sortida (a distribuir)

# -------------------------------------------------------------
# PLANTILLA DEL .BAT (self-contained)
# Els placeholders {SRC}, {SRC_KB}, {B64_KB}, {GENERATED} i
# {B64_PAYLOAD} es substitueixen a la linia "build()".
# -------------------------------------------------------------
TEMPLATE = r"""@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title Instal·lador Pabau LOPD - Tampermonkey
color 0B

REM ============================================================
REM  deploy.bat - AUTO-GENERAT per build_deploy.py
REM  Font:        {SRC}
REM  Tamany font: {SRC_KB} KB
REM  Tamany b64:  {B64_KB} KB
REM  Generat:     {GENERATED}
REM ============================================================

set "SCRIPT_NAME=TamperMonkey_documentacion_script.user.js"
set "DEST=%USERPROFILE%\Downloads\%SCRIPT_NAME%"
set "DECODED=%TEMP%\script_inline_%RANDOM%.user.js"

echo.
echo  ============================================================
echo    Instal·lador Pabau LOPD per Tampermonkey
echo    Dispositiu: %COMPUTERNAME%  ^|  Usuari: %USERNAME%
echo  ============================================================
echo.

REM --- 1. Comprovacio Tampermonkey ------------------------------
echo [1/4] Comprovant si Tampermonkey ja esta instal·lat...
set "TM_FOUND=0"
if exist "%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\Extensions\dhdgffkkebhmkfjojejmpbldmpobfkfo" set "TM_FOUND=1"
if exist "%LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions\dhdgffkkebhmkfjojejmpbldmpobfkfo" set "TM_FOUND=1"
if exist "%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data\Default\Extensions\dhdgffkkebhmkfjojejmpbldmpobfkfo" set "TM_FOUND=1"

if "%TM_FOUND%"=="0" (
    echo.
    echo   ! ATENCIO: No sha detectat Tampermonkey al perfil per defecte.
    echo   ! Instal·la l'extensio des de la botiga del teu navegador:
    echo       - Edge:   https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd
    echo       - Chrome: https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo
    echo.
    echo   Prem una tecla QUAN L'HAGIS INSTAL·LAT...
    pause >nul
)
echo       OK
echo.

REM --- 2. Extreu i desxifra el base64 incrustat ----------------
REM     El PowerShell CONSTRUEIX els marcadors concatenant chars
REM     ($G*5 + $B + $L*5) per evitar que la cadena completa
REM     aparegui literalment al codi font del .bat.
echo [2/4] Desxifrant script incrustat (base64)...

powershell -NoProfile -ExecutionPolicy Bypass -Command "$G='>';$L='<';$B='PABAU_LOPD_B64_BEGIN';$E='PABAU_LOPD_B64_END';$S=$G*5+$B+$L*5;$T=$G*5+$E+$L*5;$src=Get-Content -Path '%~f0' -Raw -Encoding ASCII;$i=$src.IndexOf($S);if($i -lt 0){Write-Host '[ERROR] Marcador inici no trobat' -ForegroundColor Red;exit 2};$j=$src.IndexOf($T,$i+1);if($j -lt 0){Write-Host '[ERROR] Marcador final no trobat' -ForegroundColor Red;exit 2};$b64=$src.Substring($i+$S.Length,$j-$i-$S.Length) -replace '\s','';try{$bytes=[Convert]::FromBase64String($b64);[System.IO.File]::WriteAllBytes('%DECODED%',$bytes);exit 0}catch{Write-Host ('[ERROR] Base64 invalid: '+$_.Exception.Message) -ForegroundColor Red;exit 3}"

if errorlevel 1 (
    echo.
    echo   ! ERROR: No sha pogut desxifrar el base64.
    pause
    exit /b 1
)
echo       Desxifrat correctament
echo.

REM --- 3. Copia a Downloads ------------------------------------
echo [3/4] Copiant a Downloads...
copy /Y "%DECODED%" "%DEST%" >nul
if not exist "%DEST%" (
    echo   ! ERROR: No sha pogut copiar a Downloads.
    pause
    exit /b 1
)
echo       Copiat a: %DEST%
echo.

REM --- 4. Obre al navegador ------------------------------------
echo [4/4] Obrint al navegador perque Tampermonkey el detecti...
set "OPENED=0"
if "%OPENED%"=="0" if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "%DEST%" & set "OPENED=1")
if "%OPENED%"=="0" if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"   (start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"   "%DEST%" & set "OPENED=1")
if "%OPENED%"=="0" if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe"      (start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe"      "%DEST%" & set "OPENED=1")
if "%OPENED%"=="0" if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"(start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%DEST%" & set "OPENED=1")
if "%OPENED%"=="0" (start "" "%DEST%")

echo.
echo  ============================================================
echo    Quan Tampermonkey mostri la pestanya d'instal·lacio:
echo        1) Fes clic a "Instal·lar"
echo        2) Recarrega la pagina de Pabau
echo        3) A la primera execucio, introdueix la teva API key
echo  ============================================================
echo.
pause
endlocal

REM ============================================================
REM  PAYLOAD BASE64 (no editar manualment!)
REM  Per regenerar: python3 build_deploy.py
REM ============================================================
{B64_PAYLOAD}
"""

# -------------------------------------------------------------
# Validacio + lectura
# -------------------------------------------------------------
here = pathlib.Path(__file__).resolve().parent
src_path = here / SRC
out_path = here / OUT

if not src_path.exists():
    print(f"[ERROR] No trobo '{SRC}'.")
    print(f"        Ha d'estar a la mateixa carpeta que aquest script.")
    sys.exit(1)

# -------------------------------------------------------------
# 1. Codifica a base64
# -------------------------------------------------------------
print(f"[1/3] Codificant '{SRC}' a base64...")
raw_bytes = src_path.read_bytes()
b64_str   = base64.b64encode(raw_bytes).decode("ascii")

# Linies de 76 chars (millor llegibilitat; no afecta el .bat)
LINE_WIDTH = 76
b64_lines = "\r\n".join(
    b64_str[i:i+LINE_WIDTH] for i in range(0, len(b64_str), LINE_WIDTH)
)

src_kb    = round(len(raw_bytes) / 1024, 1)
b64_kb    = round(len(b64_str)   / 1024, 1)
generated = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

# -------------------------------------------------------------
# 2. Substitueix placeholders i escriu el .bat
# -------------------------------------------------------------
print(f"[2/3] Generant '{OUT}'...")

payload_block = (
    ">>>>>>>>>" + "PABAU_LOPD_B64_BEGIN" + "<<<<<<<<<\r\n"
    + b64_lines + "\r\n"
    + ">>>>>>>>>" + "PABAU_LOPD_B64_END"   + "<<<<<<<<<"
)

content = TEMPLATE
content = content.replace("{SRC}",        SRC)
content = content.replace("{SRC_KB}",     f"{src_kb}")
content = content.replace("{B64_KB}",     f"{b64_kb}")
content = content.replace("{GENERATED}",  generated)
content = content.replace("{B64_PAYLOAD}", payload_block)

out_path.write_text(content, encoding="utf-8", newline="")
bat_kb = round(out_path.stat().st_size / 1024, 1)

# -------------------------------------------------------------
# 3. Validacio de round-trip (comprova que es desxifra be)
# -------------------------------------------------------------
print(f"[3/3] Validant round-trip base64...")

S = ">>>>>>>>>" + "PABAU_LOPD_B64_BEGIN" + "<<<<<<<<<"
T = ">>>>>>>>>" + "PABAU_LOPD_B64_END"   + "<<<<<<<<<"
i = content.find(S)
j = content.find(T, i + 1)
assert i >= 0 and j >= 0, "Marcadors base64 no trobats al deploy.bat generat!"

extracted = content[i+len(S):j]
decoded   = base64.b64decode(re.sub(r"\s", "", extracted))

if decoded != raw_bytes:
    print("  ✗ FAIL: el base64 desxifrat no coincideix amb l'original!")
    sys.exit(2)

# -------------------------------------------------------------
# 4. Resultat
# -------------------------------------------------------------
print()
print(f"  ✓ Exit. S'ha generat '{OUT}' correctament.")
print()
print(f"  Tamany del .user.js:    {src_kb} KB")
print(f"  Tamany del base64:      {b64_kb} KB")
print(f"  Tamany del deploy.bat:  {bat_kb} KB")
print(f"  MD5 validacio:          OK (base64 desxifra perfectament)")
print()
print("  >>> Per a la v4: edita el .js i torna a executar-me.")
print("  >>> Per distribuir: copia deploy.bat als 19 PCs.")