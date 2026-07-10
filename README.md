# pabau-tampermonkey

Col·lecció d'scripts de Tampermonkey per a Pabau CRM.

## Scripts

### `TamperMonkey_documentacion_script_2.js` ✅ (recomanat)

Versió refactoritzada (`2026-07-09`). Comprova si el client té el document
`LOPD_FIRMADO.pdf` i bloqueja el botó **"Guardar cambios"** de la pantalla
de facturació quan el client no ha signat la documentació LOPD.

#### Què aporta respecte a la v1

- **Detecció de navegació SPA**: intercepta `pushState`, `replaceState` i
  `popstate` per reaccionar als canvis de vista dins de la SPA de Pabau
  (que **no** recarrega la pàgina).
- **Cerca reactiva de `#invoice`** amb `requestAnimationFrame` cancel·lable
  en lloc d'un `setTimeout` finit (no llença mai `Timeout esperant "#invoice"`).
- **Codi organitzat en 7 mòduls aïllats** (veure *Arquitectura*).
- **Memòria de vistes** (`Set`) + neteja automàtica quan canvies de client
  per evitar crides innecessàries a l'API.

#### Especificacions

| Camp | Valor |
|---|---|
| **URL** | `https://app.pabau.com/clients/*/financial*` |
| **API** | Pabau OAuth API (`https://api.oauth.pabau.com`) |
| **Document requerit** | `LOPD_FIRMADO.pdf` |
| **Selector del botó** | `button[data-testid="operation-create"]` |
| **Selector de la invoice** | `#invoice` |
| **Emmagatzematge** | Clau API xifrada per Tampermonkey (`GM_setValue`) |
| **Versió** | `2026-07-09` |

#### Instal·lació

1. Instal·la [Tampermonkey](https://www.tampermonkey.net/) al navegador.
2. Obre el panell de Tampermonkey → **Crea un nou script**.
3. Enganxa el contingut de `TamperMonkey_documentacion_script_2.js`.
4. Desa. La primera vegada que visitis una URL coincident et demanarà
   la **API key** de Pabau.

#### Configuració

Pots canviar la clau API en qualsevol moment des del menú de Tampermonkey:

> 🔑 Canviar API key de Pabau

#### Comportament a la UI

- **Si el client té el document** → el botó funciona normalment.
- **Si NO el té** → el botó es pinta en vermell (`#dc3545`), s'etiqueta
  com a *"Falta la documentación firmada"* i queda `disabled`.
- **En canviar de vista** dins de `financial*`:
  - Es neteja l'estat del botó anterior (`data-lopd-*` + estils).
  - Es torna a consultar l'API per la nova vista (un sol cop per vista).
  - Si canvies de client, es buida la memòria de vistes ja comprovades.
- **Si el botó es torna a muntar** (React el recrea), el `MutationObserver`
  el torna a bloquejar automàticament.

#### Arquitectura

El fitxer està dividit en 7 mòduls independents + un punt d'entrada
(`bootstrap`). Cada mòdul és un IIFE que exposa només les funcions públiques
necessàries i encapsula el seu estat privat — sense tocar globals més enllà
del que cal.

| # | Mòdul | Responsabilitat |
|---|---|---|
| 1 | `CONFIG` | Constants i selectors (objecte congelat amb `Object.freeze`). |
| 2 | `invoiceStore` | Llegeix `#invoice` quan apareix al DOM amb `requestAnimationFrame` cancel·lable per cancel·lar cerques obsoletes. |
| 3 | `routerWatcher` | Detecta canvis d'URL SPA (pushState / replaceState / popstate) i notifica subscriptors. |
| 4 | `apiKey` | Persistència de la clau amb `GM_setValue` / `GM_getValue`, prompt inicial i menú per canviar-la. |
| 5 | `documentsApi` | Consulta `GM_xmlhttpRequest` a l'API de Pabau per obtenir els documents del client. |
| 6 | `buttonGuard` | Modifica el botó (color, text, `disabled`) i neteja l'estat quan es canvia de vista. |
| 7 | `invoiceGuard` | Orquestrador: combina router + DOM observer + API per decidir quan bloquejar. Manté una memòria (`Set`) de vistes ja comprovades i un `WeakMap` d'observadors per evitar fuites. |
| 8 | `bootstrap()` | Validació de la URL, lectura de l'API key i instal·lació dels mòduls. |

Diagrama de dependències:

```text
bootstrap
  ├── apiKey            (llegir / registrar menú)
  ├── routerWatcher     (instal·lar hooks de history)
  ├── invoiceStore      (iniciar cerca de #invoice)
  └── invoiceGuard      (instal·lar DOM observer)
        ├── routerWatcher.subscribe  → neteja estat en navegar
        ├── buttonGuard              → pintar / despintar botó
        └── documentsApi             → consulta LOPD_FIRMADO.pdf
```

#### Afegir funcionalitat

| Necessitat | On tocar |
|---|---|
| Validar un document addicional | `documentsApi.checkLopdDocument` retorna array; avalua tots els elements a `invoiceGuard.process`. |
| Canviar el missatge del botó | `CONFIG.BLOCKED_LABEL`. |
| Aplicar-ho a una altra URL | `@match` del header + comprovacions de `bootstrap()`. |
| Substituir la font de documents | Reescriu el mòdul `documentsApi` (única dependència externa amb `GM_xmlhttpRequest`). |

#### Missatges de la consola

L'script prefixa tots els missatges amb `[Pabau LOPD]`, per facilitar-ne
el filtrat:

```
[Pabau LOPD] Actiu per al client 25747218 (referrer=%2Fdashboard)
[Pabau LOPD] Canvi de URL: /dashboard → /clients/25747218/financial
[Pabau LOPD] Invoice obtinguda: 12345
[Pabau LOPD] Client 25747218 té LOPD_FIRMADO.pdf? false
[Pabau LOPD] Botó bloquejat: <button …>
```

Errors habituals i què fer:

| Missatge | Causa | Solució |
|---|---|---|
| `API key invàlida — s'ha esborrat` | HTTP 401/403 des de l'API | Torna a introduir la clau al menú 🔑 |
| `HTTP 5xx` | Pabau té una incidència temporal | Espera i recarrega |
| `Resposta JSON no vàlida` | Canvi d'esquema a l'API | Revisa `documentsApi.checkLopdDocument` |

---

### `TamperMonkey_documentacion_script_1.js` (legacy)

Versió inicial (`2026-07-07`). Conservada per referència. La lògica és la
mateixa però:

- No gestiona navegació SPA (només funciona a la primera càrrega).
- Fa servir `setTimeout` finit per esperar `#invoice` (pot fallar en
  connexions lentes).
- No té l'estructura modular de la v2.

Es recomana migrar a la v2.

---

## Flux funcional pas a pas

Aquesta secció descriu el comportament esperat de l'script un cop
desplegat a Pabau, sense entrar en detalls tècnics. Està pensada per
ensenyar-la al client.

### Pas 1 — L'usuari obre la fitxa del client

L'usuari navega a una URL del tipus:

```
https://app.pabau.com/clients/12345/financial?...
```

L'script detecta el patró i s'activa en segon pla.

### Pas 2 — L'script carrega la clau d'accés (només el primer cop)

- La primera vegada, l'script demana una **API key** personal.
- Aquesta clau es desa **xifrada** al navegador per Tampermonkey.
- En execucions següents ja no la torna a demanar.
- Es pot canviar des del menú **🔑 Canviar API key de Pabau**.

### Pas 3 — Detecció del número de factura

- L'script observa el camp `#invoice` del formulari.
- Quan apareix, en llegeix el valor (p. ex. `17261`) i el memoritza.
- Si l'usuari canvia de vista, es reinicia la cerca.

### Pas 4 — Consulta de la factura al servidor

- Amb el número de factura, l'script consulta:

```
GET /invoices?inv_no=17261
```

- La resposta inclou la llista de tractaments de la factura (`items[]`)
  amb camps rellevants:
  - `item_name` (p. ex. *"Marcación mandibular"*)
  - `category`  (p. ex. *"Ácido Hialurónico"*, *"Blefaroplastia"*)
  - `product_id`
  - `booking_id`

### Pas 5 — Càlcul dels papers que ha de tenir el client

A partir dels tractaments, l'script construeix la llista de papers
signats que haurien d'existir a la carpeta del client:

- **Tots els tractaments** → `LOPD_FIRMADO.pdf` *(sense caducitat)*.
- **Per cada tractament**, segons la seva categoria, s'aplica un mapa
  configurable:

| Categoria del tractament | Paper requerit | Caducitat |
|---|---|---|
| (tots) | `LOPD_FIRMADO.pdf` | Sense caducitat |
| Ácido Hialurónico | `CI ACIDO HIALURONICO-ES 2026_FIRMADO` | 12 mesos |
| Blefaroplastia | `CI BLEFAROPLASTIA-ES 2026_FIRMADO` | 12 mesos |
| *(nous tractaments)* | `CI [CATEGORIA]-ES [ANY]_FIRMADO` | configurable |

El patró del nom és:

```
CI [CATEGORIA-NORMALITZADA]-ES [ANY_ACTUAL]_FIRMADO
```

Per tant, per a la factura `17261` amb dos tractaments es comprovaran:

1. `LOPD_FIRMADO.pdf`
2. `CI ACIDO HIALURONICO-ES 2026_FIRMADO`
3. `CI BLEFAROPLASTIA-ES 2026_FIRMADO`

### Pas 6 — Comprovació a la carpeta del client

Per a cada paper requerit, l'script consulta:

```
GET /clients/{clientId}/documents?order=DESC&per_page=20&page=1
                         &search={NOM_DEL_PAPER}
```

L'API retorna tots els documents que coincideixen amb el títol,
ordenats de més recent a més antic.

### Pas 6b — Validació de la data (caducitat)

Per a la coincidència més recent es verifica:

- Si el paper **NO** té caducitat configurada → vàlid, punt.
- Si el paper **TÉ** caducitat configurada:
  - Es llegeix el camp `date` del document *(data de pujada)*.
  - Es calcula la diferència en mesos respecte la data d'avui.
  - Si la diferència és ≤ mesos configurats → **vàlid**.
  - Si la diferència és > mesos configurats → **CADUCAT**,
    i es tracta igual que si el paper no existís.

Exemple amb `LOPD_FIRMADO.pdf` (sense caducitat):

```
Títol       : LOPD_FIRMADO.pdf
Caducitat   : cap
Resultat    : vàlid (independentment de quan es va pujar)
```

Exemple amb `CI ACIDO HIALURONICO-ES 2026_FIRMADO` (12 mesos):

```
Pujat el    : 2025-01-15
Avui        : 2026-07-09
Mesos       : ~18  →  CADUCAT  →  es torna a requerir
```

### Pas 7 — Decisió final sobre el botó

**Cas A — Tots els papers requerits existeixen i no han caducat:**
el botó queda en estat normal i és funcional.

**Cas B — Falta algun paper o un ha caducat:**
el botó es pinta en vermell (`#dc3545`), queda deshabilitat i mostra
un missatge concret segons el cas:

| Situació | Missatge del botó |
|---|---|
| Falta un paper | `Falta: {nom_del_paper}` |
| Un paper existeix però ha caducat | `Caducat: {nom_del_paper} (pujat fa X mesos)` |
| En falten / caduquen dos o més | `Falten/caducen 2 documents: paper1, paper2` |

### Pas 8 — Robustesa en navegació SPA

Cada vegada que l'usuari canvia de pantalla dins Pabau (sense
recarregar la pàgina), l'script:

- Neteja l'estat del botó anterior.
- Si ha canviat de client, buida la memòria cau.
- Torna a aplicar la comprovació a la nova vista.

Si React remunta el botó mentre l'estat és *"bloquejat"*, un observer
intern el torna a bloquejar automàticament.

### Pas 9 — Memòria cau per vista

L'script recorda quines vistes ja ha comprovat
(clau: `clientId + pathname + search`).

Tornar a la mateixa vista **NO** repeteix les crides a l'API: només
reaplica l'estat del botó a partir del resultat emmagatzemat.

### Taula resum de comportaments

| Situació | Resultat del botó |
|---|---|
| Tots els papers signats i vigents | Normal, funcional |
| Falta un paper | Vermell: `Falta: <nom>` |
| Un paper existeix però ha caducat | Vermell: `Caducat: <nom> (fa X mesos)` |
| En falten / caduquen dos o més | Vermell: `Falten/caducen N documents: …` |
| L'API retorna error (xarxa, auth…) | Es mostra al log; el botó no es modifica |
| L'usuari canvia de client | Memòria cau buida; nova comprovació completa |
| L'usuari navega enrere / endavant | Es reaplica l'estat del botó segons memòria |

## Documentació

- `Logicas CI tratamientos con PABAU.xlsx` — lògiques de tractaments amb Pabau.

## Notes

- L'script **no** bloqueja cap altra funcionalitat de Pabau; només desactiva
  el botó *"Guardar cambios"* quan manca el document LOPD.
- Si vols desactivar temporalment l'script, usa el commutador de Tampermonkey
  (icona de l'extensió → pestanya *Dashboard* → ON/OFF).
- Si canvies d'empresa o de compte Pabau, esborra la clau emmagatzemada
  des del menú de l'script i torna-la a introduir.
