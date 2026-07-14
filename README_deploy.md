# Desplegament massiu del script Pabau LOPD

Sistema per distribuir el **TamperMonkey documentacion script 3** a 19
dispositius Windows amb un sol fitxer `.bat` autosuficient.

## Estructura

| Fitxer | Què és | Cal? |
|---|---|---|
| `TamperMonkey_documentacion_script_3.js` | El codi font. Aquí edites. | ✅ |
| `TamperMonkey_documentacion_script.user.js` | Còpia amb extensió `.user.js` (que Tampermonkey intercepta). | ✅ (entrada del build) |
| **`build_deploy.py`** | L'única eina. Converteix `.user.js` → base64 → incrustat al `.bat`. Self-contained (no depèn de cap plantilla externa). | ✅ |
| **`deploy.bat`** | **El fitxer que es distribueix als 19 PCs.** Tot el `.js` és dins, en base64. | ✅ (sortida) |
| `README_deploy.md` | Aquest document. | 🟡 Recomanable |

**Resum**: només necessites **2 fitxers** per al desplegament (`build_deploy.py` + `deploy.bat`). La resta són inputs/outputs.

## Ús

### Distribuir a un nou PC

1. Copia `deploy.bat` al PC destí (USB, xarxa, OneDrive, etc.).
2. Fes-hi doble clic.
3. El `.bat`:
   - Comprova que Tampermonkey estigui instal·lat (si no, et porta a la botiga).
   - Extreu el `.js` incrustat (base64) i el desxifra.
   - El copia a `Downloads` amb extensió `.user.js`.
   - L'obre al navegador perquè Tampermonkey detecti la instal·lació.
4. A la pestanya que s'obre, fes clic a **Instal·lar**.
5. A la primera execució del script a Pabau, introdueix la teva API key.

### Quan modifiquis el `.js` (per a la v4)

Cada cop que canviïs el codi de `TamperMonkey_documentacion_script_3.js`:

```bash
# 1. (opcional) Fes còpia amb extensió .user.js
cp TamperMonkey_documentacion_script_3.js TamperMonkey_documentacion_script.user.js

# 2. Regenera el deploy.bat
python3 build_deploy.py

# 3. Torna a distribuir deploy.bat als 19 PCs
```

El `deploy.bat` queda actualitzat amb el base64 de la nova versió.

## Com funciona tècnicament

1. `build_deploy.py` conté la plantilla del `.bat` com a string Python. Llegeix el `.user.js`, el codifica en base64 (línies de 76 chars).
2. Substitueix els placeholders `{SRC}`, `{SRC_KB}`, `{B64_KB}`, `{GENERATED}` i `{B64_PAYLOAD}` de la plantilla, encerclant el payload amb els marcadors `>>>>>>>>>PABAU_LOPD_B64_BEGIN/END<<<<<<<<<`.
3. **Auto-valida** que el base64 desxifrat coincideixi byte a byte amb el `.js` original.
4. Escriu el resultat a `deploy.bat`.
5. Quan l'usuari executa `deploy.bat` a Windows, una comanda PowerShell incrustada:
   - Llegeix el propi `.bat` com a text.
   - Construeix els marcadors concatenant chars (`$G*5 + $B + $L*5`) per evitar que la cadena completa aparegui literalment al codi font.
   - Extreu el substring entre els dos marcadors, neteja espais i decodifica base64.
   - Escriu el `.user.js` resultant a `%TEMP%`.
6. El `.bat` copia el `.user.js` a `Downloads` i l'obre al navegador. Tampermonkey intercepta el protocol `.user.js` i mostra la UI d'instal·lació.

## Avantatges d'aquest sistema

- **Offline**: el `.bat` no depèn de cap servidor extern.
- **Un sol fitxer**: només cal distribuir `deploy.bat`.
- **Editable**: la plantilla permet canviar passos del `.bat` sense tocar el `.js`.
- **Idempotent**: re-executar `build_deploy.py` regenera el `.bat` des de zero.
- **Validat**: cada build comprova que el base64 desxifrat coincideixi byte a byte amb el `.js` original (MD5).

## Diagnòstic

Si alguna cosa falla a Windows:

- **"Marcador inici no trobat"** → el `deploy.bat` s'ha trencat (obert amb un editor que ha tocat la codificació). Regenera'l amb `python3 build_deploy.py`.
- **"Base64 invalid"** → el `.bat` té salts de línia malmesos. Regenera'l.
- **Tampermonkey no detecta el fitxer** → comprova que l'extensió sigui `.user.js` (no `.js`).
- **No s'obre res al navegador** → el PC pot tenir un navegador per defecte que no gestiona `.user.js`. Canvia l'associació de fitxers o obre manualment el fitxer des de `Downloads`.

## Workflow recomanat per a la v4

```text
1. Editar TamperMonkey_documentacion_script_3.js
2. cp TamperMonkey_documentacion_script_3.js TamperMonkey_documentacion_script.user.js
3. python3 build_deploy.py        # genera deploy.bat nou
4. (opcional) Validar round-trip:
       python3 -c "import base64,pathlib,hashlib; \
         data=pathlib.Path('deploy.bat').read_text(); \
         i=data.find('>>>>>PABAU_LOPD_B64_BEGIN<<<<<'); \
         j=data.find('>>>>>PABAU_LOPD_B64_END<<<<<',i); \
         d=base64.b64decode(data[i+29:j].replace(chr(10),'').replace(chr(13),'').replace(' ','')); \
         o=pathlib.Path('TamperMonkey_documentacion_script.user.js').read_bytes(); \
         print('OK' if d==o else 'FAIL')"
5. Distribuir deploy.bat als 19 PCs
```