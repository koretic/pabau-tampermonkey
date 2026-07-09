# pabau-tampermonkey

Col·lecció d'scripts de Tampermonkey per a Pabau CRM.

## Scripts

### `TamperMonkey_documentacion_script.js`

Comprova si el client té el document `LOPD_FIRMADO.pdf` i bloqueja el botó **"Guardar cambios"** de la pantalla de facturació quan el client no ha signat la documentació LOPD.

- **URL:** `https://app.pabau.com/clients/*/financial*`
- **API:** Pabau OAuth API (`https://api.oauth.pabau.com`)
- **Emmagatzematge:** la clau API es desa xifrada per Tampermonkey (`GM_setValue`)

#### Instal·lació

1. Instal·la [Tampermonkey](https://www.tampermonkey.net/) al navegador.
2. Obre el panell de Tampermonkey → **Crea un nou script**.
3. Enganxa el contingut de `TamperMonkey_documentacion_script.js`.
4. Desa. La primera vegada que visitis una URL coincident et demanarà la **API key** de Pabau.

#### Configuració

Pots canviar la clau API en qualsevol moment des del menú de Tampermonkey:

> 🔑 Canviar API key de Pabau

## Documentació

- `Logicas CI tratamientos con PABAU.xlsx` — lògiques de tractaments amb Pabau.