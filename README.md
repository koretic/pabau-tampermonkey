# pabau-tampermonkey

Col·lecció d'scripts de Tampermonkey per a Pabau CRM.

## Scripts

### `TamperMonkey_documentacion_script_3.js` ✅ (recomanat)

Versió actual (`2026-07-11`). Comprova que una factura tingui **tots els
papers signats necessaris** — el LOPD general **i** el consentiment informat
(CI) de **cada tractament** de la factura — i bloqueja el botó
**"Guardar cambios"** quan en falta algun o algun ha caducat.

#### Què aporta respecte a la v2

- **Mapa de tractaments incrustat** (`treatmentsConfig`) → ja no cal el
  fitxer extern `treatments_config.js` carregat amb `@require`. Cada
  tractament porta directament quin document signat li toca i la
  caducitat en mesos.
- **Validació per tractament** → per a cada item de la factura es consulta
  un paper diferent (p. ex. àcid hialurònic, blefaroplastia, làser…).
  Abans només es validava el LOPD general.
- **Detecció de caducitat** → si un CI té més de N mesos des de la data
  de pujada (`document.date`), es torna a requerir.
- **Text del botó compacte** → sempre `Faltan/caducan N documentos`,
  independentment del nombre. El detall complet va al `title` (tooltip
  natiu) separat per ` · `.
- **Mode "consultant"** → mentre l'script fa les crides a l'API, el botó
  mostra `Consultando documentación...` per deixar clar que no es pot
  prémer encara.

#### Especificacions

| Camp | Valor |
|---|---|
| **URL** | `https://app.pabau.com/*` (només actiu quan la ruta és `/clients/<id>/...`) |
| **API** | Pabau OAuth API (`https://api.oauth.pabau.com`) |
| **Documents requerits** | `LOPD_FIRMADO.pdf` (sempre) + CI per cada tractament de la factura |
| **Selector del botó** | `button[data-testid="operation-create"]` |
| **Selector de la invoice** | `#invoice` |
| **Emmagatzematge** | Clau API xifrada per Tampermonkey (`GM_setValue`) |
| **Versió** | `2026-07-12` |

#### Instal·lació

1. Instal·la [Tampermonkey](https://www.tampermonkey.net/) al navegador.
2. Obre el panell de Tampermonkey → **Crea un nou script**.
3. Enganxa el contingut de `TamperMonkey_documentacion_script_3.js`.
4. Desa. La primera vegada que visitis una URL coincident et demanarà
   la **API key** de Pabau.

> ⚠️ A diferència de la v2, la v3 **ja no requereix** el fitxer
> `treatments_config.js`: el mapa de tractaments va incrustat dins del
> propi script. Si tens la v2 instal·lada, **desinstal·la-la primer**
> per evitar duplicitats.

#### Configuració

Pots canviar la clau API en qualsevol moment des del menú de Tampermonkey:

> 🔑 Modificar API key

#### Comportament a la UI

- **Tots els papers són presents i vigents** → el botó funciona normalment.
- **En consulta** (mentre es fan les crides a l'API) → el botó mostra
  `Consultando documentación...` i està `disabled`.
- **Falta o ha caducat algun paper** → el botó es pinta en vermell
  (`#dc3545`), mostra `Faltan/caducan N documentos` i queda `disabled`.
  En passar el ratolí per sobre (`title`), es llisten els noms dels
  documents afectats separats per ` · `:
  `[LOPD] LOPD_FIRMADO.pdf · CI ACIDO HIALURONICO-ES 2026_FIRMADO.pdf · …`
- **En canviar de vista** dins de l'app:
  - Es neteja l'estat del botó anterior.
  - Es torna a comprovar la nova vista (un sol cop per combinació
    `clientId + invoiceNo`).
  - Si canvies de client, es buida la memòria de vistes ja comprovades.
- **Si el botó es torna a muntar** (React el recrea), un `MutationObserver`
  el torna a bloquejar automàticament amb el label/tooltip del `dataset`.

#### Arquitectura

El fitxer està dividit en **11 mòduls** independents + un punt d'entrada
(`bootstrap`). Cada mòdul és un IIFE que exposa només les funcions
públiques necessàries i encapsula el seu estat privat — sense tocar
globals més enllà del que cal.

| # | Mòdul | Responsabilitat |
|---|---|---|
| 1 | `CONFIG` | Constants i selectors (objecte congelat amb `Object.freeze`). Inclou `BLOCKED_LABEL` (text per defecte), `CONSULTING_LABEL` (text durant la consulta) i `LOPD_DOCUMENT`. |
| 1b | `treatmentsConfig` | Mapa de tractaments incrustat al codi (substitueix l'antic `treatments_config.js`). Per cada `id`/`name` resol quin paper signat toca i quina caducitat en mesos té. Exposa `resolve()`, `getById()`, `getByName()` i `list`. |
| 2 | `invoiceStore` | Llegeix `#invoice` quan apareix al DOM amb `requestAnimationFrame` cancel·lable. Manté `invoiceNo`, `itemId` i `itemName` com a getters. Es reinicia amb `reset()` en cada canvi de vista. |
| 3 | `routerWatcher` | Detecta canvis d'URL SPA (pushState / replaceState / popstate). Permet subscripcions (`subscribe(fn)`) i notifica amb `{ oldHref, newHref }`. |
| 4 | `apiKey` | Persistència de la clau amb `GM_setValue` / `GM_getValue`, prompt inicial la primera vegada, i menú per canviar-la. `clear()` esborra la clau si l'API retorna 401/403. |
| 5 | `documentsApi` | Consulta `GM_xmlhttpRequest` a `/clients/{id}/documents?search=...` per obtenir el paper més recent del client. Retorna `found`, `documents[]` i `document` (el primer = més recent perquè l'API ja torna `DESC`). |
| 5b | `invoiceApi` | Consulta `GM_xmlhttpRequest` a `/invoices?inv_no=...`. Per cada item mira el `treatmentsConfig` i l'anota amb el `document` requerit + `expiryMonths`. |
| 5c | `invoiceLookup` | **Orquestra la validació completa**: 1) crida `invoiceApi` per obtenir els items; 2) construeix la llista única de papers (`LOPD` + 1 per cada `base` de tractament); 3) llença les consultes a `documentsApi` en paral·lel; 4) avalua caducitat amb `isExpired(date, expiryMonths)`; 5) retorna la llista d'`issues` (missing / expired). Exposa també `buildRequiredFromItems`, `isExpired` i `monthsSince`. |
| 6 | `buttonGuard` | Modifica el botó (color vermell `#dc3545`, text, `disabled`, `title`). Comprova l'estat **visible** (`textContent` i `title`) abans de tornar a aplicar, per evitar una doble-escriptura innecessària. `unblockAll()` reverteix tots els botons marcats. |
| 7 | `invoiceGuard` | **Orquestrador principal**: combina router + DOM observer + API + botó. Manté `processedViews` (`Set<clientId|invoiceNo>`) com a memòria cau i `buttonObservers` (`WeakMap`) per als observers de React. Controla una sola promesa en vol (`inFlight`) per evitar crides duplicades per la mateixa clau. |
| 8 | `bootstrap()` | Validació inicial, lectura de l'API key, instal·lació del router + invoiceStore + invoiceGuard i log de diagnòstic. També instal·la un observer extra per reaccionar quan `#invoice` s'injecta més tard que el botó. |

Diagrama de dependències:

```text
bootstrap
  ├── apiKey            (llegir / registrar menú)
  ├── routerWatcher     (instal·lar hooks de history)
  ├── invoiceStore      (iniciar cerca de #invoice)
  └── invoiceGuard      (instal·lar DOM observer)
        ├── routerWatcher.subscribe  → neteja estat en navegar
        ├── invoiceStore.invoiceNo   → obtenir número de factura
        ├── buttonGuard              → pintar / despintar botó
        └── invoiceLookup            → validar la factura sencera
              ├── invoiceApi           → /invoices?inv_no=…
              │     └── treatmentsConfig  → resoldre document per tractament
              └── documentsApi         → /clients/{id}/documents
```

#### El mapa `treatmentsConfig`

Cada entrada té la forma:

```javascript
{
  id: 2702512,                                          // product_id de Pabau
  name: "Marcación mandibular",                          // item_name de la factura
  category: "Ácido Hialurónico",                        // categoria (informativa)
  document: {                                           // null → no requereix CI
    base: "CI ACIDO HIALURONICO-ES 2026",
    expiryMonths: 12                                    // 0 = no caduca
  }
}
```

L'script construeix el nom final afegint `_FIRMADO.pdf` al `base`
(p. ex. `CI ACIDO HIALURONICO-ES 2026_FIRMADO.pdf`) i comprova si
existeix a la carpeta del client.

Categories cobertes actualment:

| Categoria | Paper requerit | Caducitat |
|---|---|---|
| *(tots els tractaments)* | `LOPD_FIRMADO.pdf` | No caduca |
| Ácido Hialurónico | `CI ACIDO HIALURONICO-ES 2026_FIRMADO.pdf` | 12 mesos |
| Blefaroplastia | `CI BLEFAROPLASTIA-ES 2026_FIRMADO.pdf` | 12 mesos |
| Exosomas y Biología | `Consent. Exosomas autólogos ES 2026_FIRMADO.pdf`, `CI Polinucleotidos universal ES 2026_FIRMADO.pdf`, `CI HIALURONIDASA ES 2026_FIRMADO.pdf` | 12 mesos |
| Neuromoduladores | `CI TOXINA BOTULINICA ES 2026_FIRMADO.pdf` | 12 mesos |
| Inductores de colágeno (Sculptra / Radiesse) | `CI INDUCTOR DE COLÁGENO ES 2026_FIRMADO.pdf` | 12 mesos |
| Láser Rejuvenecimiento | `CI LÁSER ES v.3.2026_FIRMADO.pdf` | 12 mesos |
| Láser Vascular y Pigmentación | `CI LÁSER ES v.3.2026_FIRMADO.pdf` (excepte `Eliminar tattoo` → `CI ELIMINACIÓN DE TATUAJES-ES 2026_FIRMADO.pdf`) | 12 mesos |
| Mesoterapia / PRGF / PRP | `CI MESOTERAPIA NTCF 135 HA-ES 2026_FIRMADO.pdf` o `CI PRGF ES 2026_FIRMADO.pdf` | 12 mesos |
| Marketing | `CI USO IMAGENES SONIDO ES 2026_FIRMADO.pdf` | 12 mesos |
| Refractiva | *(cap — `document: null`)* | — |
| Tratamientos Faciales — Reverso | *(cap — `document: null`)* | — |
| Tratamientos Faciales — Microneedling | `CI MICRONEEDLING ES 2026_FIRMADO.pdf` | 12 mesos |
| Tratamientos Faciales — Peeling | `PEELING ES 2026_FIRMADO.pdf` | 12 mesos |
| Tratamientos Faciales — Hydrafacial | `CI HYDRAFACIAL ES 2026_FIRMADO.pdf` | 12 mesos |
| Ultrasonidos HIFU (Ultraformer) | `CI ULTRAFORMER ES 2026_FIRMADO.pdf` | 12 mesos |

#### Afegir / modificar tractaments

Totes les dades estan dins del IIFE de `treatmentsConfig`. Per afegir un
tractament nou:

1. Afegeix una entrada a l'array `TREATMENTS` amb el `id` (de
   Pabau), `name`, `category` i el `document` corresponent.
2. Si la categoria és nova, tria un `base` consistent amb la resta
   (`CI <CATEGORIA>-ES <ANY>_FIRMADO`).
3. Recarrega la pàgina. L'script ja el reconeixerà per `id` o per `name`
   (case-insensitive).

Si vols que un tractament **no** requereixi cap CI (p. ex. els de
*Refractiva*), posa `document: null` i l'script simplement l'ignorarà
a l'hora de calcular els papers requerits. El LOPD_FIRMADO.pdf es
continua validant igualment.

#### Afegir funcionalitat

| Necessitat | On tocar |
|---|---|
| Validar un document addicional independent dels tractaments | Afegir-lo a `buildRequiredFromItems` dins de `invoiceLookup`. |
| Canviar el missatge del botó | `CONFIG.BLOCKED_LABEL` (text per defecte) o `CONSULTING_LABEL` (durant la consulta). |
| Personalitzar el resum del botó/tooltip | Funcions `buildLabel` i `buildTooltip` dins de `invoiceGuard`. |
| Aplicar-ho a una altra URL | `@match` del header + comprovacions de `bootstrap()`. |
| Substituir la font de documents | Reescriure el mòdul `documentsApi` (única dependència externa amb `GM_xmlhttpRequest`). |
| Substituir el mapa de tractaments | Reescriure el mòdul `treatmentsConfig` mantenint la interfície `resolve(key)`. |

#### Missatges de la consola

L'script prefixa tots els missatges amb `[Pabau LOPD]`, per facilitar-ne
el filtrat:

```
[Pabau LOPD] Bootstrap iniciat a https://app.pabau.com/clients/25747218/financial
[Pabau LOPD] Canvi de URL: /dashboard → /clients/25747218/financial
[Pabau LOPD] Invoice obtinguda: {invoiceNo: "17261", itemId: null, itemName: null}
[Pabau LOPD] Botó bloquejat: Consultando documentación...
[Pabau LOPD] Client 25747218 · factura 17261 →
  { items: ["Marcación mandibular", "Blefaroplastia inferior"],
    issues: 3,
    label: "Faltan/caducan 3 documentos",
    tooltip: "[LOPD] LOPD_FIRMADO.pdf · CI ACIDO HIALURONICO-ES 2026_FIRMADO.pdf · CI BLEFAROPLASTIA-ES 2026_FIRMADO.pdf" }
[Pabau LOPD] Botó bloquejat: Faltan/caducan 3 documentos
```

Errors habituals i què fer:

| Missatge | Causa | Solució |
|---|---|---|
| `API key invàlida — s'ha esborrat` | HTTP 401/403 des de l'API | Torna a introduir la clau al menú 🔑 |
| `HTTP 5xx` | Pabau té una incidència temporal | Espera i recarrega |
| `Resposta JSON no vàlida` | Canvi d'esquema a l'API | Revisa `documentsApi` / `invoiceApi` |
| `Error de xarxa` | No s'ha pogut contactar amb l'API | L'script **no bloqueja** el botó; torna-ho a provar més tard |

---

### `TamperMonkey_documentacion_script_2.js` (legacy)

Versió anterior (`2026-07-09`). Comportava la mateixa estructura modular
que la v3 però **només validava el LOPD general**, sense comprovar el CI
de cada tractament ni la caducitat. Feia servir el fitxer extern
`treatments_config.js` carregat amb `@require`.

Es recomana migrar a la v3.

### `TamperMonkey_documentacion_script_1.js` (legacy)

Versió inicial (`2026-07-07`). Conservada per referència. La lògica és la
mateixa però:

- No gestiona navegació SPA (només funciona a la primera càrrega).
- Fa servir `setTimeout` finit per esperar `#invoice` (pot fallar en
  connexions lentes).
- No té l'estructura modular de la v2/v3.

Es recomana migrar a la v3.

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

L'script detecta el patró i s'activa en segon pla. També s'activa a
qualsevol URL de Pabau, però **només actua** quan la ruta és
`/clients/<id>/...` (ho gestiona internament `invoiceGuard`).

### Pas 2 — L'script carrega la clau d'accés (només el primer cop)

- La primera vegada, l'script demana una **API key** personal.
- Aquesta clau es desa **xifrada** al navegador per Tampermonkey.
- En execucions següents ja no la torna a demanar.
- Es pot canviar des del menú **🔑 Modificar API key**.

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

### Pas 5 — Càlcul dels papers que ha de tenir el client

A partir dels tractaments, l'script construeix la llista de papers
signats que haurien d'existir a la carpeta del client:

- **Tots els tractaments** → `LOPD_FIRMADO.pdf` *(sense caducitat)*.
- **Per cada tractament**, segons el seu `id` o `name` dins del mapa
  `treatmentsConfig`, s'associa un paper i una caducitat:
  - *Ácido Hialurónico* → `CI ACIDO HIALURONICO-ES 2026_FIRMADO.pdf` (12 mesos)
  - *Blefaroplastia* → `CI BLEFAROPLASTIA-ES 2026_FIRMADO.pdf` (12 mesos)
  - *Láser* → `CI LÁSER ES v.3.2026_FIRMADO.pdf` (12 mesos)
  - … *(veure la taula completa més amunt)*
- Els papers deduplicats per `base` (un sol CI per categoria).

Exemple: per a la factura `17261` amb dos tractaments
(*"Marcación mandibular"* + *"Blefaroplastia inferior"*) es comprovaran:

1. `LOPD_FIRMADO.pdf` *(sempre, sense caducitat)*
2. `CI ACIDO HIALURONICO-ES 2026_FIRMADO.pdf` *(12 mesos)*
3. `CI BLEFAROPLASTIA-ES 2026_FIRMADO.pdf` *(12 mesos)*

### Pas 6 — Comprovació a la carpeta del client

Per a cada paper requerit, l'script consulta:

```
GET /clients/{clientId}/documents?order=DESC&per_page=50&page=1
                         &search={NOM_DEL_PAPER}
```

L'API retorna tots els documents que coincideixen amb el títol,
ordenats de més recent a més antic. L'script es queda amb el primer
(resultat més recent) i avalua si està caducat.

> Les consultes es fan **en paral·lel** amb `Promise.all`, de manera
> que el temps total és el del paper més lent, no la suma de tots.

### Pas 6b — Validació de la data (caducitat)

Per a la coincidència més recent es verifica:

- Si el paper **NO** té caducitat configurada (`expiryMonths <= 0`) →
  vàlid, punt.
- Si el paper **TÉ** caducitat configurada:
  - Es llegeix el camp `date` del document *(data de pujada)*.
  - Es calcula `date + expiryMonths` i es compara amb la data d'avui.
  - Si la data actual és ≤ `date + expiryMonths` → **vàlid**.
  - Si la data actual és > `date + expiryMonths` → **CADUCAT**,
    i es tracta igual que si el paper no existís.

Exemple amb `LOPD_FIRMADO.pdf` (sense caducitat):

```
Títol       : LOPD_FIRMADO.pdf
Caducitat   : cap
Resultat    : vàlid (independentment de quan es va pujar)
```

Exemple amb `CI ACIDO HIALURONICO-ES 2026_FIRMADO.pdf` (12 mesos):

```
Pujat el    : 2025-01-15
Caducitat   : 2026-01-15
Avui        : 2026-07-09  →  CADUCAT  →  es torna a requerir
```

### Pas 7 — Decisió final sobre el botó

**Cas A — Tots els papers requerits existeixen i no han caducat:**
el botó queda en estat normal i és funcional. L'script neteja els
seus `data-lopd-*` per deixar-lo exactament com estava.

**Cas B — Falta algun paper o un ha caducat:**
el botó es pinta en vermell (`#dc3545`), queda deshabilitat i mostra
un missatge compacte:

| Situació | Text del botó | Exemple de `title` (tooltip) |
|---|---|---|
| Falta 1 paper | `Faltan/caducan 1 documentos` | `CI ACIDO HIALURONICO-ES 2026_FIRMADO.pdf` |
| Falta 1 paper LOPD | `Faltan/caducan 1 documentos` | `[LOPD] LOPD_FIRMADO.pdf` |
| En falten / caduquen N | `Faltan/caducan N documentos` | `[LOPD] LOPD_FIRMADO.pdf · CI … _FIRMADO.pdf · CI … _FIRMADO.pdf` |
| Un paper existeix però ha caducat | `Faltan/caducan 1 documentos` | `CI … _FIRMADO.pdf (caducado, subido hace 18 meses)` |

> 💡 El **text del botó** sempre és el recompte compacte. El detall
> complet (quins papers, quin ha caducat i quan es va pujar) va al
> **tooltip** (`title` del botó), separat per ` · `.

### Pas 8 — Robustesa en navegació SPA

Cada vegada que l'usuari canvia de pantalla dins Pabau (sense
recarregar la pàgina), l'script:

- Neteja l'estat del botó anterior.
- Si ha canviat de client, buida la memòria cau.
- Torna a aplicar la comprovació a la nova vista.

Si React remunta el botó mentre l'estat és *"bloquejat"*, un observer
intern el torna a bloquejar automàticament amb el label/tooltip desat
al `dataset`.

### Pas 9 — Memòria cau per vista

L'script recorda quines combinacions `clientId + invoiceNo` ja ha
comprovat. Tornar a la mateixa combinació **NO** repeteix les crides
a l'API: només reaplica l'estat del botó a partir del resultat
emmagatzemat.

A més, durant la consulta es bloquegen les repeticions concurrents:
si el DOM observer detecta el botó diverses vegades mentre s'estan
fent les crides, totes esperen la **mateixa** promesa en vol.

### Taula resum de comportaments

| Situació | Resultat del botó |
|---|---|
| Tots els papers signats i vigents | Normal, funcional |
| Crides a l'API en curs | `Consultando documentación...`, disabled |
| Falta un paper | Vermell: `Faltan/caducan 1 documentos` + tooltip amb el nom |
| Un paper existeix però ha caducat | Vermell: `Faltan/caducan 1 documentos` + tooltip `… (caducado, subido hace X meses)` |
| En falten / caduquen dos o més | Vermell: `Faltan/caducan N documentos` + tooltip amb tots els noms |
| L'API retorna error (xarxa, auth…) | Es mostra al log; el botó **no** es modifica |
| L'usuari canvia de client | Memòria cau buida; nova comprovació completa |
| L'usuari navega enrere / endavant | Es reaplica l'estat del botó segons memòria |
| React remunta el botó | Es torna a bloquejar amb l'estat del `dataset` |

## Documentació

- `Logicas CI tratamientos con PABAU.xlsx` — lògiques de tractaments amb Pabau.

## Notes

- L'script **no** bloqueja cap altra funcionalitat de Pabau; només desactiva
  el botó *"Guardar cambios"* quan manca algun paper requerit.
- Si vols desactivar temporalment l'script, usa el commutador de Tampermonkey
  (icona de l'extensió → pestanya *Dashboard* → ON/OFF).
- Si canvies d'empresa o de compte Pabau, esborra la clau emmagatzemada
  des del menú de l'script i torna-la a introduir.
- El mapa de tractaments és un snapshot de l'any 2026; quan canviï
  l'any (o s'afegeixin categories noves), caldrà actualitzar les
  cadenes `base` dins de `treatmentsConfig` dins del propi script.