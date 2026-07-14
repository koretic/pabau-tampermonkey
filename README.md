# pabau-tampermonkey

Col·lecció d'scripts de Tampermonkey per a Pabau CRM.

## Scripts

### `TamperMonkey_documentacion_script_3.js` ✅ (recomanat)

Versió actual (`2026-07-12`). Comprova que una factura tingui **tots els
papers signats necessaris** — el LOPD general **i** el consentiment
informat (CI) de **cada tractament** de la factura — i bloqueja el
botó **"Guardar cambios"** quan en falta algun o algun ha caducat.

A més, quan l'usuari és a la **pestanya de pagaments** (3a tab de
`/financial`), bloqueja **tots els botons de mètode de pagament**
(Credit, Points, Card on File, Card Terminal, Card, Card other, Cash,
Account, Vouchers, Other) fins que tota la documentació estigui al dia.
A la resta de pestanyes (`Detall`, `Productes`, `Historial`, etc.) cap
botó és modificat.

#### Què aporta respecte a la v2

- **Mapa de tractaments incrustat** (`treatmentsConfig`) → ja no cal
  el fitxer extern `treatments_config.js` carregat amb `@require`.
- **Validació per tractament** → per a cada item de la factura es
  consulta un paper diferent (p. ex. àcid hialurònic, blefaroplastia,
  làser…). Abans només es validava el LOPD general.
- **Detecció de caducitat** → si un CI té més de N mesos des de la
  data de pujada (`document.date`), es torna a requerir.
- **Text del botó compacte** → sempre `Faltan/caducan N documentos`,
  independentment del nombre. El detall complet va al `title`, **un
  document per línia**.
- **Mode "consultant"** → mentre l'script fa les crides a l'API,
  tant el botó principal com els de pagament mostren `Consultando
  documentación...` / `Revisando documentación...`.
- **Mode preventiu** → quan l'usuari entra a la pestanya de pagaments,
  els botons de pagament ja queden `disabled` amb `Revisando
  documentación...` fins que arriba el resultat de l'API.
- **Bloqueig dels mètodes de pagament** → a banda del `Guardar
  cambios`, quan la documentació falla i l'usuari és a la pestanya de
  pagaments, es bloquegen TOTS els botons de mètode de pagament (sense
  modificar-ne el color ni el text, només `disabled` + tooltip + captura
  de click).

#### Especificacions

| Camp | Valor |
|---|---|
| **URL** | `https://app.pabau.com/*` (només actiu a `/clients/<id>/financial...` **i** pestanya de pagaments activa) |
| **API** | Pabau OAuth API (`https://api.oauth.pabau.com`) |
| **Documents requerits** | `LOPD_FIRMADO.pdf` (sempre) + CI per cada tractament de la factura |
| **Botons bloquejats** | `Guardar cambios` (a pagaments) + tots els de mètode de pagament quan hi ha issues |
| **Selector botó principal** | `button[data-testid="operation-create"]` |
| **Selector invoice** | `#invoice` |
| **Pestanya de pagaments** | `[id$="panel-2"][aria-hidden="false"]` |
| **Emmagatzematge** | Clau API xifrada per Tampermonkey (`GM_setValue`) |
| **Versió** | `2026-07-12` |

#### Instal·lació

1. Instal·la [Tampermonkey](https://www.tampermonkey.net/) al navegador.
2. Obre el panell de Tampermonkey → **Crea un nou script**.
3. Enganxa el contingut de `TamperMonkey_documentacion_script_3.js`.
4. Desa. La primera vegada que visitis una URL coincident et demanarà
   la **API key** de Pabau.

> ⚠️ A diferència de la v2, la v3 **ja no requereix** el fitxer
> `treatments_config.js`. Si tens la v2 instal·lada, **desinstal·la-la
> primer** per evitar duplicitats.

#### Configuració

Pots canviar la clau API en qualsevol moment des del menú de Tampermonkey:

> 🔑 Modificar API key

#### Comportament a la UI

El comportament **depèn de la pestanya activa** de `/financial`:

- **A qualsevol pestanya que NO sigui la de pagaments**: l'script no
  toca cap botó. Tot funciona amb normalitat.
- **A la pestanya de pagaments**, tres estats:

| Estat | Botó `Guardar cambios` | Botons de pagament |
|---|---|---|
| **Preventiu** (esperant API) | `Consultando documentación...`, `disabled`, vermell | Tots `disabled`, tooltip `Revisando documentación...` |
| **Tots els papers presents i vigents** | Normal, funcional | Tots habilitats |
| **Falta o ha caducat algun paper** | Vermell (`#dc3545`), `Faltan/caducan N documentos`, `disabled` | Tots `disabled`, tooltip amb el motiu |

> ⚠️ Quan l'API falla per error de xarxa, l'script **no** bloqueja
> cap botó (només logueja l'error).

Quan l'usuari **canvia de vista** dins l'app:
- Es neteja l'estat del botó anterior.
- Es torna a comprovar la nova vista (un sol cop per combinació
  `clientId + invoiceNo`).
- Si canvies de client, es buida la memòria de vistes ja comprovades.

Si el botó es torna a muntar (React el recrea), un `MutationObserver`
el torna a bloquejar automàticament amb el label/tooltip del `dataset`.

#### Format del tooltip (botó principal)

Cada issue va en una **línia pròpia** dins del `title`:

```text
[LOPD] LOPD_FIRMADO.pdf · No encontrado
[CI]  CI ACIDO HIALURONICO-ES 2026_FIRMADO.pdf · No encontrado
[CI]  CI LÁSER ES v.3.2026_FIRMADO.pdf · Caducado · subido el 15/01/2025 (hace 18 meses)
```

Prefix `[LOPD]` pel document general, `[CI]` pels de tractament. Si ha
caducat s'hi afegix la data de pujada i els mesos transcorreguts.

#### Arquitectura

El fitxer està dividit en **12 mòduls** independents + punt d'entrada
(`bootstrap`). Cada mòdul és un IIFE que exposa poques funcions públiques
i encapsula el seu estat privat.

| # | Mòdul | Responsabilitat |
|---|---|---|
| 1 | `CONFIG` | Constants i selectors (objecte congelat). Inclou `STORAGE_KEY`, `API_BASE`, `INVOICE_SELECTOR`, `BUTTON_SELECTOR`, `BLOCKED_LABEL`, `LOPD_DOCUMENT`, `CONSULTING_LABEL`, `PAYMENT_PANEL_SELECTOR`, `PAYMENT_FOOTER_SELECTOR` i `PAYMENT_BUTTON_SELECTORS`. |
| 1b | `treatmentsConfig` | Mapa de tractaments incrustat. Per cada `id`/`name` resol el paper signat i la caducitat en mesos. Exposa `resolve()`, `getById()`, `getByName()` i `list`. |
| 1c | `accents` | Passarel·la pel cercador literal de Pabau. `mangle(name)` converteix `á→a?`, `é→e?`, `í→i?`, `ó→o?`, `ú→u?`, `ü→u?`, `ñ→n?`. Idempotent. |
| 2 | `invoiceStore` | Llegeix `#invoice` amb `requestAnimationFrame` cancel·lable. Manté `invoiceNo`, `itemId` i `itemName` com a getters. Es reinicia amb `reset()` en cada canvi de vista. |
| 3 | `routerWatcher` | Detecta canvis d'URL SPA (pushState / replaceState / popstate). Subscripcions amb `subscribe(fn)` que rep `{ oldHref, newHref }`. |
| 4 | `apiKey` | Persistència de la clau amb `GM_setValue`/`GM_getValue`, prompt inicial, i menú per canviar-la. `clear()` esborra la clau si l'API retorna 401/403. |
| 5 | `documentsApi` | Consulta `GM_xmlhttpRequest` a `/clients/{id}/documents?search=...`. Aplica `accents.mangle()` internament. Retorna `found`, `documents[]` i `document` (el primer = més recent perquè l'API ja torna `DESC`). |
| 5b | `invoiceApi` | Consulta `GM_xmlhttpRequest` a `/invoices?inv_no=...`. Per cada item resol el document requerit mitjançant `treatmentsConfig`. |
| 5c | `invoiceLookup` | **Orquestra la validació completa**: 1) crida `invoiceApi`; 2) construeix llista única de papers (LOPD + 1 per base de tractament); 3) llença consultes a `documentsApi` en paral·lel; 4) avalua caducitat amb `isExpired`; 5) retorna `issues` (missing / expired). Exposa `buildRequiredFromItems`, `isExpired`, `monthsSince` i `formatDate`. |
| 6 | `buttonGuard` | Gestió visual de **dos tipus de botons**: (a) principal — color vermell `#dc3545`, text, `disabled`, `title`; (b) pagament — només `disabled` + `title` + captura de click, **sense** modificar color ni text. Exposa `block`, `blockPaymentButtons`, `unblockPaymentButtons`, `forceBlockAllPaymentButtons`, `unblockAll`. `unblockOne` restaura el text original desat a `data-lopd-original-label`. |
| 7 | `invoiceGuard` | **Orquestrador principal**: combina router + DOM observer + API + botons. Manté `processedViews` (`Set<clientId|invoiceNo>`) i `inFlight` (promesa única en vol per clau). **Només actua quan la pestanya de pagaments (`panel-2` amb `aria-hidden="false"`) està activa.** Un `tabObserver` escolta els canvis d'`aria-hidden`. |
| 8 | `bootstrap()` | Validació inicial, càrrega de l'apiKey, instal·lació del router + invoiceStore + invoiceGuard. També instal·la un observer per quan `#invoice` s'injecta més tard que el botó. |

Diagrama de dependències:

```text
bootstrap
  ├── apiKey            (llegir / registrar menú)
  ├── routerWatcher     (instal·lar hooks de history)
  ├── invoiceStore      (iniciar cerca de #invoice)
  └── invoiceGuard      (instal·lar DOM observer + tabObserver)
        ├── routerWatcher.subscribe   → neteja estat en navegar
        ├── tabObserver              → neteja quan es surt de pagaments
        ├── invoiceStore.invoiceNo   → obtenir número de factura
        ├── buttonGuard              → pintar / despintar botons
        └── invoiceLookup            → validar la factura
              ├── invoiceApi           → /invoices?inv_no=…
              │     └── treatmentsConfig → resoldre document per tractament
              ├── documentsApi         → /clients/{id}/documents
              │     └── accents.mangle → adaptar accents del cercador
              └── buttonGuard.blockPaymentButtons
                                          → bloqueig preventiu i final
```

#### El mapa `treatmentsConfig`

Cada entrada:

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

L'script construeix el nom final afegint `_FIRMADO.pdf` al `base`.

Categories cobertes actualment:

| Categoria | Paper requerit | Caducitat |
|---|---|---|
| *(tots)* | `LOPD_FIRMADO.pdf` | No caduca |
| Ácido Hialurónico | `CI ACIDO HIALURONICO-ES 2026_FIRMADO.pdf` | 12 mesos |
| Blefaroplastia | `CI BLEFAROPLASTIA-ES 2026_FIRMADO.pdf` | 12 mesos |
| Exosomas y Biología | `Consent. Exosomas autólogos ES 2026_FIRMADO.pdf`, `CI Polinucleotidos universal ES 2026_FIRMADO.pdf`, `CI HIALURONIDASA ES 2026_FIRMADO.pdf` | 12 mesos |
| Neuromoduladores | `CI TOXINA BOTULINICA ES 2026_FIRMADO.pdf` | 12 mesos |
| Inductores de colágeno (Sculptra / Radiesse) | `CI INDUCTOR DE COLÁGENO ES 2026_FIRMADO.pdf` | 12 mesos |
| Láser Rejuvenecimiento | `CI LÁSER ES v.3.2026_FIRMADO.pdf` | 12 mesos |
| Láser Vascular y Pigmentación | `CI LÁSER ES v.3.2026_FIRMADO.pdf` (excepte `Eliminar tattoo` → `CI ELIMINACIÓN DE TATUAJES-ES 2026_FIRMADO.pdf`) | 12 mesos |
| Mesoterapia / PRGF / PRP | `CI MESOTERAPIA CON VITAMINAS ES 2026_FIRMADO.pdf`, `CI PRGF ES 2026_FIRMADO.pdf` o `CI PRP ES 2026_FIRMADO.pdf` | 12 mesos |
| Marketing | `CI USO IMAGENES SONIDO ES 2026_FIRMADO.pdf` | 12 mesos |
| Refractiva | *(cap — `document: null`)* | — |
| Tratamientos Faciales — Reverso | `CI RADIOFRECUENCIA CON MICROAGUJAS` | 12 mesos |
| Tratamientos Faciales — Microneedling | `CI MICRONEEDLING ES 2026_FIRMADO.pdf` | 12 mesos |
| Tratamientos Faciales — Peeling | `PEELING ES 2026_FIRMADO.pdf` | 12 mesos |
| Tratamientos Faciales — Hydrafacial | `CI HYDRAFACIAL ES 2026_FIRMADO.pdf` | 12 mesos |
| Ultrasonidos HIFU (Ultraformer) | `CI ULTRAFORMER ES 2026_FIRMADO.pdf` | 12 mesos |

#### Afegir / modificar tractaments

1. Afegeix una entrada a l'array `TREATMENTS` amb `id`, `name`,
   `category` i `document`.
2. Si la categoria és nova, tria un `base` consistent
   (`CI <CATEGORIA>-ES <ANY>_FIRMADO`).
3. Recarrega la pàgina. L'script el reconeixerà per `id` o per
   `name` (case-insensitive).

Perquè un tractament **no** requereixi cap CI, posa `document: null`
(els de *Refractiva* n són un exemple). El `LOPD_FIRMADO.pdf` es
continua validant igualment.

#### Afegir funcionalitat

| Necessitat | On tocar |
|---|---|
| Validar un document addicional | Afegir-lo a `buildRequiredFromItems` dins de `invoiceLookup`. |
| Canviar el text per defecte del botó | `CONFIG.BLOCKED_LABEL` / `CONFIG.CONSULTING_LABEL`. |
| Personalitzar el format del tooltip | Funció `fmtIssue` dins de `invoiceGuard`. |
| Afegir un altre mètode de pagament a bloquejar | Afegir el selector a `CONFIG.PAYMENT_BUTTON_SELECTORS`. |
| Aplicar-ho a una altra URL | `@match` del header. |

#### Tractament de noms amb accents (mòdul `accents`)

Pabau **desatitza** els fitxers pujats substituint cada caràcter
accentuat per la **vocal/n lletja + `?`**. El seu cercador
`/clients/{id}/documents?search=...` és **literal**: si li passes
el nom amb accents NO troba res.

Exemple:

| Forma | Resultat a l'API |
|---|---|
| `search=CI ELIMINACIÓN DE TATUAJES-ES 2026_FIRMADO.pdf` | 0 resultats |
| `search=CI ELIMINACIO?N DE TATUAJES-ES 2026_FIRMADO.pdf` | 1 resultat |

`accents.mangle(name)` converteix `á→a?`, `é→e?`, `í→i?`,
`ó→o?`, `ú→u?`, `ü→u?`, `ñ→n?`. La conversió és idempotent.
`documentsApi.findDocument` l'aplica abans de cercar i accepta
**tres variants** com a coincidència vàlida:

1. Nom original amb accents.
2. Nom mangled (lletja + `?`).
3. Nom mangled sense `?` (stripped).

Documents afectats (14-07-2026):

| Tractament | Nom lògic (amb accents) | Nom a Pabau (mangled) |
|---|---|---|
| Exosomas autólogos | `Consent. Exosomas autólogos ES 2026_FIRMADO.pdf` | `Consent. Exosomas auto?logos ES 2026_FIRMADO.pdf` |
| Sculptra / Radiesse | `CI INDUCTOR DE COLÁGENO ES 2026_FIRMADO.pdf` | `CI INDUCTOR DE COLA?GENO ES 2026_FIRMADO.pdf` |
| Láser | `CI LÁSER ES v.3.2026_FIRMADO.pdf` | `CI LA?SER ES v.3.2026_FIRMADO.pdf` |
| Eliminar tattoo | `CI ELIMINACIÓN DE TATUAJES-ES 2026_FIRMADO.pdf` | `CI ELIMINACIO?N DE TATUAJES-ES 2026_FIRMADO.pdf` |

#### Missatges de la consola

L'script prefixa tots amb `[Pabau LOPD]`:

```
[Pabau LOPD] Actiu a /clients/25747218/financial (client 25747218)
[Pabau LOPD] forceBlockAllPaymentButtons: 10 botons desactivats (footer)
[Pabau LOPD] Botó bloquejat: Consultando documentación...
[Pabau LOPD] Client 25747218 · factura 17261 →
  { items: ["Marcación mandibular", "Blefaroplastia inferior"],
    issues: 3,
    label: "Faltan/caducan 3 documentos" }
[Pabau LOPD] unblockPaymentButtons: total=10, restored=8, skipped(Pabau-disabled)=2
```

Errors i solucions:

| Missatge | Causa | Solució |
|---|---|---|
| `API key invàlida — s'ha esborrat` | HTTP 401/403 | Torna a introduir la clau al menú 🔑 |
| `HTTP 5xx` | Incidència temporal de Pabau | Espera i recarrega |
| `Resposta JSON no vàlida` | Canvi d'esquema a l'API | Revisa `documentsApi` / `invoiceApi` |
| `Error de xarxa` | No es contacta l'API | L'script **no bloqueja** cap botó; torna-ho a provar |

---

### `TamperMonkey_documentacion_script_2.js` (legacy)

Versió anterior (`2026-07-09`). **Només validava el LOPD general**, sense
comprovar el CI de cada tractament ni la caducitat. Feia servir el fitxer
extern `treatments_config.js` carregat amb `@require`. Es recomana migrar
a la v3.

### `TamperMonkey_documentacion_script_1.js` (legacy)

Versió inicial (`2026-07-07`). Sense navegació SPA, `setTimeout` finit
per esperar `#invoice`, i sense estructura modular. Es recomana migrar a
la v3.

---

## Flux funcional pas a pas

### Pas 1 — L'usuari obre la fitxa del client

```
https://app.pabau.com/clients/12345/financial?...
```

L'script s'activa però **només actúa** quan la ruta és
`/clients/<id>/...` **i** la pestanya de pagaments està activa.

### Pas 2 — Càrrega de la clau API (només el primer cop)

- Primera vegada: demana l'**apiKey** personal.
- Es desa **xifrada** per Tampermonkey.
- Es pot canviar des del menú **🔑 Modificar apiKey**.

### Pas 3 — Detecció del número de factura

- L'script observa el camp `#invoice`.
- Quan apareix, en llegeix el valor (p. ex. `17261`).
- Si l'usuari canvia de vista, es reinicia la cerca.

### Pas 4 — Consulta de la factura

```
GET /invoices?inv_no=17261
```

La resposta conté els `items[]` amb `item_name`, `category` i `product_id`.

### Pas 5 — Càlcul dels papers requerits

- **Tots** → `LOPD_FIRMADO.pdf` (sense caducitat).
- **Per cada tractament**, segons `treatmentsConfig`, s'associa un paper
  i una caducitat (p. ex. àcid hialurònic → 12 mesos, refractiva → cap).

Exemple per a factura amb *"Marcación mandibular"* + *"Blefaroplastia inferior"*:

1. `LOPD_FIRMADO.pdf` (sempre)
2. `CI ACIDO HIALURONICO-ES 2026_FIRMADO.pdf` (12 mesos)
3. `CI BLEFAROPLASTIA-ES 2026_FIRMADO.pdf` (12 mesos)

### Pas 6 — Comprovació a la carpeta del client

```
GET /clients/{clientId}/documents?order=DESC&per_page=50&page=1
                         &search={NOM_DEL_PAPER_MANGLED}
```

Les consultes es fan **en paral·lel** amb `Promise.all`.

### Pas 6b — Validació de caducitat

- Si `expiryMonths <= 0` → vàlid.
- Si `date + expiryMonths < avui` → **CADUCAT** (es tracta com si
  manqués).

### Pas 7 — Decisió final (pestanya de pagaments activa)

**Cas A — Tots els papers correctes:**
- Botó `Guardar cambios`: text original, habilitat.
- Tots els botons de pagament: habilitats.

**Cas B — Falta o ha caducat algun paper:**
- Botó `Guardar cambios`: vermell (`#dc3545`), `disabled`,
  text `Faltan/caducan N documentos`.
- Botons de pagament: tots `disabled` amb tooltip.

| Situació | Text botó | Tooltip |
|---|---|---|
| Falta 1 paper LOPD | `Faltan/caducan 1 documentos` | `[LOPD] LOPD_FIRMADO.pdf · No encontrado` |
| Falta 1 paper CI | `Faltan/caducan 1 documentos` | `[CI] CI ACIDO HIALURONICO-ES 2026_FIRMADO.pdf · No encontrado` |
| Paper caducat | `Faltan/caducan 1 documentos` | `[CI] CI … · Caducado · subido el DD/MM/YYYY (hace N meses)` |
| En falten/caduquen N | `Faltan/caducan N documentos` | Un `[LOPD]/[CI] nom · …` per línia |

### Pas 7b — Mode preventiu

Quan l'usuari **entra** a la pestanya de pagaments, mentre l'API
respon:
- Botó principal: `Consultando documentación...`, vermell, `disabled`.
- Botons de pagament: `Revisando documentación...`, `disabled`.

Quan arriba la resposta:
- Si OK → tots s'habiliten.
- Si hi ha issues → es mantenen bloquejats amb el missatge del Cas B.

### Pas 8 — Robustesa en navegació SPA

Cada canvi de pantalla dins Pabau (sense recarregar):
- Es neteja l'estat del botó anterior.
- Si canvia de client, es buida la memòria cau.
- Es torna a aplicar la comprovació a la nova vista.

Tornar a la mateixa combinació `clientId + invoiceNo` **no** repeteix
les crides a l'API: només reaplica l'estat del botó des de memòria.

Durant la consulta, les repeticions concurrents esperen la **mateixa**
promesa en vol per evitar crides duplicades.

Si React remunta el botó mentre l'estat és "bloquejat", un observer
intern el torna a bloquejar automàticament amb l'estat desat al
`dataset`.

### Taula resum

| Situació | Resultat |
|---|---|
| Tots els papers signats i vigents | Botons normals, funcionals |
| Crides a l'API en curs | `Consultando documentación...` / `Revisando documentación...`, disabled |
| Falta un paper | Vermell, `Faltan/caducan 1 documentos` + tooltip |
| Paper caducat | Vermell, `Faltan/caducan 1 documentos` + tooltip amb data |
| En falten / caduquen dos o més | Vermell, `Faltan/caducan N documentos` + tooltip amb tots |
| Error de xarxa / API | Log a consola; cap botó modificat |
| Canvi de client | Memòria cau buida; comprovació completa |
| Navegació enrere / endavant | Reaplica estat segons memòria |
| React remunta el botó | Es torna a bloquejar amb l'estat del `dataset` |
| Fora de la pestanya de pagaments | Cap botó modificat |

---

## Notes

- L'script **no** modifica cap altra funcionalitat de Pabau.
- Per desactivar'l temporalment: icona de Tampermonkey → Dashboard →
  ON/OFF.
- Si canvies d'empresa o compte, esborra la clau des del menú de
  l'script i torna-la a introduir.
- El mapa de tractaments és un snapshot de 2026; quan canviï l'any,
  actualitza les cadenes `base` dins de `treatmentsConfig`.
