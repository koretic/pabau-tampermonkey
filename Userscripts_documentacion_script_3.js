// ==UserScript==
// @name         Block invoice Pabau - LOPD check (Userscripts/iOS)
// @namespace    https://github.com/quoid/userscripts
// @version      2026-07-12
// @description  Comprova els papers requerits (LOPD + CI per tractament) pels items d'una factura Pabau — VERSIÓ PER A USERScripts (iOS Safari).
// @author       Alex Rodriguez
// @match        https://app.pabau.com/*
// @match        https://app.pabau.com/clients/*/financial*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=pabau.com
// @grant        none
// @run-at       document-end
// @noframes
// ==/UserScript==

/* ===========================================================================
 * NOTA IMPORTANT — AQUESTA VERSIÓ ESTÀ ADAPTADA PER A "USERScripts"
 * ---------------------------------------------------------------------------
 * Diferències respecte la versió Tampermonkey:
 *
 *   1. NO utilitza les APIs GM_* (GM_setValue, GM_getValue,
 *      GM_xmlhttpRequest, GM_registerMenuCommand, GM_info).
 *
 *      A Userscripts ≥ 1.2.1 (iOS Safari), les APIs GM_* ja NO estan
 *      exposades ni al page context ni al content context — és una
 *      breaking change de l'API de l'extensió. Veure:
 *        https://github.com/quoid/userscripts/issues/265
 *
 *      Per aquesta raó, tot el que la versió Tampermonkey fa amb GM_*
 *      aquí es fa amb APIs natives del navegador que sempre estan
 *      disponibles al **page context** (on Userscripts injecta amb
 *      `@grant none`):
 *
 *        | Tampermonkey (GM_*)        | Userscripts (nadiu)               |
 *        | -------------------------- | --------------------------------- |
 *        | GM_setValue / GM_getValue  | localStorage.setItem / .getItem   |
 *        | GM_xmlhttpRequest          | fetch() (amb credentials)         |
 *        | GM_registerMenuCommand     | (no disponible — veure menú propi |
 *        |                            |  a sota)                          |
 *        | GM_info                    | (no disponible — es llegeix       |
 *        |                            |  `navigator.userAgent` o s'infereix |
 *        |                            |  per presència d'usuari Safari)    |
 *
 *   2. Persistència de l'API key: localStorage del navegador Safari.
 *      A iOS, localStorage és persistent entre sessions dins de la
 *      mateixa instal·lació de l'app Userscripts.
 *
 *   3. No utilitza `unsafeWindow` ni cap API interna del navegador.
 *      Tot l'accés al DOM és estàndard (querySelector, addEventListener).
 *
 *   4. S'afegeix `@noframes` perquè Userscripts (i Tampermonkey) només
 *      s'injectin al frame principal de Pabau.
 *
 * LIMITACIONS CONEGUDES A iOS:
 *   - L'API key queda emmagatzemada a localStorage en text pla (no
 *     xifrada). És un risc similar al que tindria una "user script
 *     clàssica" sense sandbox.
 *   - No hi ha menú de l'extensió. Per canviar l'API key cal navegar
 *     a un altre client — el primer cop que l'script troba a faltar
 *     la clau torna a mostrar el `prompt()`.
 *
 * Si tens Tampermonkey instal·lat (Mac/Chrome/Edge/Firefox), usa la
 * versió `TamperMonkey_documentacion_script_3.js`. Aquesta versió
 * és l'única opció per a iOS Safari amb l'extensió Userscripts ≥ 1.2.1.
 * ===========================================================================
 */

/**
 * Estructura del fitxer:
 *
 *   1. Constants i selectors
 *   2. Mòdul `invoiceStore`     -> gestiona el valor de #invoice de forma reactiva
 *   3. Mòdul `routerWatcher`   -> detecta canvis d'URL a la SPA
 *   4. Mòdul `apiKey`          -> lectura/escriptura de la clau desada
 *   5. Mòdul `documentsApi`    -> consulta de LOPD_FIRMADO.pdf a l'API
 *   6. Mòdul `buttonGuard`     -> bloqueig visual del botó "Guardar cambios"
 *   7. Mòdul `invoiceGuard`    -> orquestrador: lliga router + DOM + botó + API
 *   8. Bootstrap               -> punt d'entrada
 *
 * Cada mòdul exposa poques funcions i no toca globals més enllà del
 * necessari. Així, si més endavant cal afegir funcionalitat (p.ex.
 * validar més documents), cada part es toca de forma aïllada.
 */
(function () {
    "use strict";

    /* =========================================================================
     * 0. DETECCIÓ DE PLATAFORMA
     * ----------------------------------------------------------------------
     * Com que GM_info tampoc està disponible a Userscripts ≥ 1.2.1,
     * detectem el context pel `userAgent` de Safari i per la presència
     * de window.safari (indicador de l'API de l'extensió Userscripts).
     * Aquesta detecció és NOMÉS informativa per als missatges de consola
     * i no afecta el comportament de l'script.
     * ======================================================================= */
    const IS_USERScripts =
        typeof navigator !== "undefined" &&
        /Safari/.test(navigator.userAgent) &&
        !/Chrome|Chromium|Android/.test(navigator.userAgent);

    /* =========================================================================
     * 1. CONSTANTS I SELECTORS
     * ======================================================================= */
    const CONFIG = Object.freeze({
        STORAGE_KEY: "pabau_api_key",
        API_BASE: "https://api.oauth.pabau.com",
        INVOICE_SELECTOR: "#invoice",
        BUTTON_SELECTOR: 'button[data-testid="operation-create"]',
        BLOCKED_LABEL: "Falta la documentación firmada",
        LOPD_DOCUMENT: "LOPD_FIRMADO.pdf", // sempre requerit
        // Text que es mostra al botó mentre s'està consultant l'API.
        // El botó ja queda disabled; el text és purament informatiu.
        CONSULTING_LABEL: "Consultando documentación...",
        // Panel de pagaments (3a pestanya de /financial, índex 2).
        // El bloqueig del botó "Guardar cambios" NOMÉS s'aplica quan
        // aquest panel està actiu (aria-hidden="false"). Si no existeix
        // encara, el MutationObserver del bootstrap segueix escoltant
        // fins que aparegui (no és un push a una altra pàgina, són
        // tabs dins la mateixa pàgina).
        PAYMENT_PANEL_SELECTOR: '[id$="panel-2"][aria-hidden="false"]',
        // Contenidor que allotja TOTS els botons de mètode de pagament
        // (Credit, Points, Card on File, Card Terminal, Card, Card other,
        // Cash, Account, Vouchers, Other). És únic dins el panel-2 i ens
        // serveix de "gate" per bloquejar tota la fila de cop.
        PAYMENT_FOOTER_SELECTOR:
            'div[class*="Tabs_invoiceTabPaymentActionFooterRow__"]',
        // Selectors individuals dels botons de pagament. Tots queden
        // dins de PAYMENT_FOOTER_SELECTOR; els llistem igual per si
        // en algun moment es renderitza algun botó fora del footer.
        PAYMENT_BUTTON_SELECTORS: [
            'button[data-testid="credit-payment-button"]',
            'button[data-testid="loyalty-payment-button"]',
            'button[data-testid="card-file-button"]',
            'button[aria-label="visa-card-button-payment"]',
            'button[aria-label="card-button"]',
            'button[data-cy="cardOtherButton"]',
            'button[aria-label="cash-button"]',
            'button[aria-label="account-payment"]',
            'button[data-testid="voucher-payment-button"]',
            'button[data-testid="other-payments"]',
        ].join(","),
    });

    /* =========================================================================
     * 1b. MÒDUL: treatmentsConfig
     * ----------------------------------------------------------------------
     * Mapa de tractaments incrustat directament (substitueix l'antic
     * `treatments_config.js` carregat amb @require). Permet resoldre quin
     * document signat toca per a cada tractament de la factura.
     *
     * IMPORTANT: Cada entrada amb `document !== null` genera una entrada
     * adicional a la llista de documents requerits. A més, LOPD_FIRMADO.pdf
     * (CONFIG.LOPD_DOCUMENT) es valida SEMPRE, independentment del tractament.
     * ======================================================================= */

    const treatmentsConfig = (() => {
        const TREATMENTS = [
            // ============ Ácido Hialurónico ============
            { id: 2702512, name: "Marcación mandibular",                category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
            { id: 2702513, name: "Proyección de mentón",                 category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
            { id: 2702514, name: "Proyección de pómulos",                category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
            { id: 2702515, name: "Corrección surco nasogeniano",         category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
            { id: 2702516, name: "Corrección líneas de marioneta",       category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
            { id: 2702517, name: "Corrección sonrisa gingival",          category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
            { id: 2702518, name: "Relleno fosa temporal",                category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
            { id: 2702519, name: "Código de barras",                     category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
            { id: 2702520, name: "Corrección de ojeras",                 category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
            { id: 2702521, name: "Diseño de labios",                     category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
            { id: 2702522, name: "Rinomodelación",                       category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
            { id: 2702523, name: "Rinomodelación con cirugía previa",    category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },

            // ============ Blefaroplastia ============
            { id: 2702542, name: "Blefaroplastia superior",              category: "Blefaroplastia",      document: { base: "CI BLEFAROPLASTIA-ES 2026",     expiryMonths: 12 } },
            { id: 2702543, name: "Blefaroplastia inferior",              category: "Blefaroplastia",      document: { base: "CI BLEFAROPLASTIA-ES 2026",     expiryMonths: 12 } },
            { id: 2702544, name: "Blefaroplastia 4 párpados",            category: "Blefaroplastia",      document: { base: "CI BLEFAROPLASTIA-ES 2026",     expiryMonths: 12 } },

            // ============ Exosomas y Biología ============
            { id: 2702545, name: "Exosomas autólogos",                   category: "Exosomas y Biología", document: { base: "Consent. Exosomas autólogos ES 2026", expiryMonths: 12 } },
            { id: 2702546, name: "Polinucleótidos",                      category: "Exosomas y Biología", document: { base: "CI Polinucleotidos universal ES 2026", expiryMonths: 12 } },
            { id: 2702547, name: "Hialuronidasa",                        category: "Exosomas y Biología", document: { base: "CI HIALURONIDASA ES 2026",      expiryMonths: 12 } },

            // ============ Neuromoduladores ============
            { id: 2702524, name: "Neuromoduladores – 1 zona",            category: "Neuromoduladores",    document: { base: "CI TOXINA BOTULINICA ES 2026",   expiryMonths: 12 } },
            { id: 2702525, name: "Neuromoduladores – 2 zonas",           category: "Neuromoduladores",    document: { base: "CI TOXINA BOTULINICA ES 2026",   expiryMonths: 12 } },
            { id: 2702526, name: "Neuromoduladores – 3 zonas",           category: "Neuromoduladores",    document: { base: "CI TOXINA BOTULINICA ES 2026",   expiryMonths: 12 } },
            { id: 2702527, name: "Neuromoduladores tercio inferior",     category: "Neuromoduladores",    document: { base: "CI TOXINA BOTULINICA ES 2026",   expiryMonths: 12 } },
            { id: 2702528, name: "Bruxismo",                             category: "Neuromoduladores",    document: { base: "CI TOXINA BOTULINICA ES 2026",   expiryMonths: 12 } },
            { id: 2702529, name: "Hiperhidrosis",                        category: "Neuromoduladores",    document: { base: "CI TOXINA BOTULINICA ES 2026",   expiryMonths: 12 } },

            // ============ Inductores de colágeno (Sculptra / Radiesse) ============
            { id: 2702531, name: "Sculptra cuello",                      category: "Inductores",          document: { base: "CI INDUCTOR DE COLÁGENO ES 2026", expiryMonths: 12 } },
            { id: 2702530, name: "Sculptra cara",                        category: "Inductores",          document: { base: "CI INDUCTOR DE COLÁGENO ES 2026", expiryMonths: 12 } },
            { id: 2702532, name: "Radiesse Cara",                        category: "Inductores",          document: { base: "CI INDUCTOR DE COLÁGENO ES 2026", expiryMonths: 12 } },
            { id: 2702533, name: "Radiesse cuello",                      category: "Inductores",          document: { base: "CI INDUCTOR DE COLÁGENO ES 2026", expiryMonths: 12 } },
            { id: 2702597, name: "Inductores de colágeno",               category: "Inductores",          document: { base: "CI INDUCTOR DE COLÁGENO ES 2026", expiryMonths: 12 } },

            // ============ Láser Rejuvenecimiento ============
            { id: 2702560, name: "ResurFX rejuvenecimiento",                       category: "Láser Rejuvenecimiento",       document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
            { id: 2702561, name: "Láser Pico rejuvenecimiento / manchas / melasma", category: "Láser Rejuvenecimiento",       document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
            { id: 2702562, name: "CO2 Panfacial completo",                         category: "Láser Rejuvenecimiento",       document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
            { id: 2702563, name: "CO2 Tercio medio",                               category: "Láser Rejuvenecimiento",       document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
            { id: 2702564, name: "CO2 Periocular",                                 category: "Láser Rejuvenecimiento",       document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
            { id: 2702565, name: "CO2 Cuello",                                     category: "Láser Rejuvenecimiento",       document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
            { id: 2702566, name: "CO2 Cara y cuello",                              category: "Láser Rejuvenecimiento",       document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
            { id: 2702567, name: "CO2 Cara, cuello y escote",                      category: "Láser Rejuvenecimiento",       document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
            { id: 2702568, name: "CO2 Escote",                                     category: "Láser Rejuvenecimiento",       document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
            { id: 2702569, name: "CO2 Verrugas",                                   category: "Láser Rejuvenecimiento",       document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },

            // ============ Láser Vascular y Pigmentación ============
            { id: 2702570, name: "IPL manchas faciales",                           category: "Láser Vascular y Pigmentación", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
            { id: 2702571, name: "IPL periocular",                                 category: "Láser Vascular y Pigmentación", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
            { id: 2702572, name: "Nd-Yag vascular",                                category: "Láser Vascular y Pigmentación", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
            { id: 2702573, name: "Eliminar tattoo",                                category: "Láser Vascular y Pigmentación", document: { base: "CI ELIMINACIÓN DE TATUAJES-ES 2026", expiryMonths: 12 } },
            { id: 2702591, name: "Nd-Yag Puntos rubi x1",                          category: "Láser Vascular y Pigmentación", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
            { id: 2702592, name: "Nd-Yag Puntos rubi de 5 a 15",                   category: "Láser Vascular y Pigmentación", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
            { id: 2702593, name: "Nd-Yag Puntos rubi más de 15",                   category: "Láser Vascular y Pigmentación", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
            { id: 2702594, name: "Nd-Yag Arañas Vasculares x1",                    category: "Láser Vascular y Pigmentación", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
            { id: 2702595, name: "Nd-Yag Arañas Vasculares de 5 a 15",             category: "Láser Vascular y Pigmentación", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
            { id: 2702596, name: "Nd-Yag Arañas Vasculares más de 15",             category: "Láser Vascular y Pigmentación", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
            { id: 2702574, name: "Nd-Yag Venas Prioculares",                       category: "Láser Vascular y Pigmentación", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },

            // ============ Mesoterapia / PRGF / PRP ============
            { id: 2702554, name: "Vitaminas NCTF 135 AH rostro",                   category: "Mesoterapia", document: { base: "CI MESOTERAPIA CON VITAMINAS ES 2026", expiryMonths: 12 } },
            { id: 2702555, name: "Vitaminas NCTF 135 AH periocular",               category: "Mesoterapia", document: { base: "CI MESOTERAPIA CON VITAMINAS ES 2026", expiryMonths: 12 } },
            { id: 2702556, name: "PRGF Facial",                                    category: "Mesoterapia", document: { base: "CI PRGF ES 2026",                    expiryMonths: 12 } },
            { id: 2702557, name: "PRGF Capilar",                                   category: "Mesoterapia", document: { base: "CI PRGF ES 2026",                    expiryMonths: 12 } },
            { id: 2702558, name: "PRGF COLIRIO",                                   category: "Mesoterapia", document: { base: "CI PRGF ES 2026",                    expiryMonths: 12 } },
            { id: 2702559, name: "Pack Vitaminas + PRGF",                          category: "Mesoterapia", document: { base: "CI PRGF ES 2026",                    expiryMonths: 12 } },
            { id: 2702616, name: "PRP Facial",                                     category: "Mesoterapia", document: { base: "CI PRP ES 2026",                    expiryMonths: 12 } },
            { id: 2702617, name: "PRP Capilar",                                    category: "Mesoterapia", document: { base: "CI PRP ES 2026",                    expiryMonths: 12 } },
            { id: 2702618, name: "Pack Vitaminas + PRP",                           category: "Mesoterapia", document: { base: "CI PRP ES 2026",                    expiryMonths: 12 } },

            // ============ Marketing ============
            { id: 2702615, name: "Colaboración",                                   category: "Marketing",   document: { base: "CI USO IMAGENES SONIDO ES 2026",     expiryMonths: 12 } },

            // ============ Refractiva (sense document definit) ============
            { id: 2702548, name: "Láser FemtoLasik – por ojo",                     category: "Refractiva",  document: null },
            { id: 2702549, name: "Láser PRK – por ojo",                            category: "Refractiva",  document: null },
            { id: 2702550, name: "Lentes ICL esférica – por ojo",                  category: "Refractiva",  document: null },
            { id: 2702551, name: "Lentes ICL tórica – por ojo",                    category: "Refractiva",  document: null },

            // ============ Tratamientos Faciales ============
            { id: 2702611, name: "Reverso",                                        category: "Tratamientos Faciales", document: { base: "CI RADIOFRECUENCIA CON MICROAGUJAS", expiryMonths: 12 } },
            { id: 2702538, name: "Microneedling con exosomas vegetales",           category: "Tratamientos Faciales", document: { base: "CI MICRONEEDLING ES 2026", expiryMonths: 12 } },
            { id: 2702539, name: "Peeling médico cara",                            category: "Tratamientos Faciales", document: { base: "PEELING ES 2026",          expiryMonths: 12 } },
            { id: 2702537, name: "Microneedling cara y cuello",                    category: "Tratamientos Faciales", document: { base: "CI MICRONEEDLING ES 2026", expiryMonths: 12 } },
            { id: 2702540, name: "Hydrafacial Signature",                          category: "Tratamientos Faciales", document: { base: "CI HYDRAFACIAL ES 2026",   expiryMonths: 12 } },
            { id: 2702541, name: "Hydrafacial Deluxe",                             category: "Tratamientos Faciales", document: { base: "CI HYDRAFACIAL ES 2026",   expiryMonths: 12 } },

            // ============ Ultrasonidos HIFU ============
            { id: 2702534, name: "Ultraformer MPT – Cara",                         category: "Tratamientos Faciales", document: { base: "CI ULTRAFORMER ES 2026",   expiryMonths: 12 } },
            { id: 2702535, name: "Ultraformer MPT – Cuello / Papada",              category: "Tratamientos Faciales", document: { base: "CI ULTRAFORMER ES 2026",   expiryMonths: 12 } },
            { id: 2702536, name: "Ultraformer MPT – Cara y cuello completo",       category: "Tratamientos Faciales", document: { base: "CI ULTRAFORMER ES 2026",   expiryMonths: 12 } },
        ];

        const BY_ID   = new Map();
        const BY_NAME = new Map();
        for (const t of TREATMENTS) {
            if (t.id)   BY_ID.set(Number(t.id), t);
            if (t.name) BY_NAME.set(String(t.name).toLowerCase().trim(), t);
        }

        function getById(id)   { return BY_ID.get(Number(id)) || null; }
        function getByName(n)  { return n ? BY_NAME.get(String(n).toLowerCase().trim()) || null : null; }

        /**
         * Resol quin document + caducitat toca per un tractament.
         * @param {{id?: number|string, name?: string}} key
         * @returns {{ documentName: string, expiryMonths: number } | null}
         */
        function resolve(key) {
            const entry =
                (key.id != null && key.id !== "" && getById(key.id)) ||
                (key.name && getByName(key.name));
            if (!entry || !entry.document) return null;
            return {
                documentName: `${entry.document.base}_FIRMADO.pdf`,
                expiryMonths: entry.document.expiryMonths,
            };
        }

        return Object.freeze({
            resolve,
            getById,
            getByName,
            list: Object.freeze(TREATMENTS),
        });
    })();

    /* =========================================================================
     * 1c. MÒDUL: accents
     * ----------------------------------------------------------------------
     * Pabau desatitza els noms de fitxer pujats substituint cada caràcter
     * accentuat per la vocal/n lletja + "?". Com que el cercador
     * /clients/{id}/documents?search=... és LITERAL, li hem de passar
     * el nom amb aquesta mateixa conversió perquè trobi coincidències.
     *
     * Exemple: "ELIMINACIÓN DE TATUAJES-ES 2026_FIRMADO.pdf" (accentuat,
     * no el troba) → "ELIMINACIO?N DE TATUAJES-ES 2026_FIRMADO.pdf"
     * (mangled, sí el troba).
     *
     * La conversió és idempotent: si el nom no té accents, es retorna
     * exactament igual.
     * ======================================================================= */
    const accents = (() => {
        /** Substitueix vocals/n accentuats per la versió lletja + "?". */
        function mangle(str) {
            if (!str) return "";
            const map = {
                "á": "a?", "Á": "A?",
                "é": "e?", "É": "E?",
                "í": "i?", "Í": "I?",
                "ó": "o?", "Ó": "O?",
                "ú": "u?", "Ú": "U?",
                "ü": "u?", "Ü": "U?",
                "ñ": "n?", "Ñ": "N?",
            };
            return String(str).replace(
                /[áÁéÉíÍóÓúÚüÜñÑ]/g,
                (ch) => map[ch] || ch,
            );
        }

        return { mangle };
    })();

    /* =========================================================================
     * 2. MÒDUL: invoiceStore
     * ----------------------------------------------------------------------
     * Llegeix `#invoice` quan apareix al DOM i manté el seu valor a la
     * variable `current`. Com que la SPA el munta/desmunta en cada
     * vista, fem servir `requestAnimationFrame` en bucle (en lloc d'un
     * `setTimeout` finit) i cancel·lem la cerca quan arriba una nova.
     * ======================================================================= */

    const invoiceStore = (() => {
        let currentInvoiceNo = null; // número de factura (p. ex. "17261")
        let currentItemId = null;    // fallback: si #invoice fos un <select> d'items
        let currentItemName = null;
        let watchId = 0;

        /**
         * Comença a buscar l'element. Si ja n'existeix un cicle actiu,
         * l'invalida (compara `myId` amb `watchId`).
         */
        function start() {
            watchId += 1;
            const myId = watchId;
            tick(myId);
        }

        /** Reinicia el valor quan l'usuari canvia de vista. */
        function reset() {
            currentInvoiceNo = null;
            currentItemId = null;
            currentItemName = null;
            start();
        }

        function tick(myId) {
            if (myId !== watchId) return; // algú ha cancel·lat aquesta cerca
            const el = document.querySelector(CONFIG.INVOICE_SELECTOR);
            if (el) {
                currentInvoiceNo = el.value;
                if (el.options && el.options[el.selectedIndex]) {
                    currentItemName = el.options[el.selectedIndex].text;
                    currentItemId = el.value;
                }
                return;
            }
            // Tornem-ho a provar al pròxim frame; es cancel·la amb start().
            requestAnimationFrame(() => tick(myId));
        }

        return {
            start,
            reset,
            get invoiceNo() {
                return currentInvoiceNo;
            },
            get itemId() {
                return currentItemId;
            },
            get itemName() {
                return currentItemName;
            },
        };
    })();

    /* =========================================================================
     * 3. MÒDUL: routerWatcher
     * ----------------------------------------------------------------------
     * La SPA de Pabau navega sense recarregar. Capturem:
     *   - history.pushState / replaceState (ho fa servir React Router)
     *   - popstate (botons endavant/enrere del navegador)
     * Cada cop que la URL canvia, notifiquem una subscripció.
     * ======================================================================= */

    const routerWatcher = (() => {
        let lastHref = location.href;
        const listeners = new Set();

        function notify() {
            const oldHref = lastHref;
            const newHref = location.href;
            if (newHref === oldHref) return;
            lastHref = newHref;
            console.log("[Pabau LOPD] Canvi de URL:", oldHref, "→", newHref);
            listeners.forEach((fn) => fn({ oldHref, newHref }));
        }

        function install() {
            ["pushState", "replaceState"].forEach((fnName) => {
                const original = history[fnName];
                history[fnName] = function (...args) {
                    const result = original.apply(this, args);
                    notify();
                    return result;
                };
            });
            window.addEventListener("popstate", notify);
        }

        function subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        }

        return { install, subscribe };
    })();

    /* =========================================================================
     * 4. MÒDUL: apiKey
     * ----------------------------------------------------------------------
     * Emmagatzema la clau d'API a localStorage del navegador.
     *
     * NOTA iOS Safari / Userscripts ≥ 1.2.1: les APIs GM_setValue / GM_getValue
     * ja no estan exposades (veure capçalera). En el seu lloc usem
     * localStorage, que és persistent dins la mateixa instal·lació
     * de l'extensió Userscripts a Safari.
     *
     * A canvi, no hi ha `GM_registerMenuCommand` — l'usuari pot canviar
     * la clau navegant a una URL /clients/<id>/?__change_lopd_key=1 (veure
     * `changeKeyShortcut()` més avall).
     * ======================================================================= */

    const apiKey = (() => {
        /** Prefix per evitar col·lisions amb altres scripts al mateix localStorage. */
        const LS_KEY = `pabau_lopd.${CONFIG.STORAGE_KEY}`;

        function get() {
            let key = "";
            try {
                key = window.localStorage.getItem(LS_KEY) || "";
            } catch (e) {
                // localStorage pot estar desactivat en mode privat de Safari.
                console.warn("[Pabau LOPD] localStorage no accessible:", e);
            }
            if (!key) {
                key = prompt(
                    "Introdueix la teva API key de Pabau (es desarà localment):",
                );
                if (key) {
                    try {
                        window.localStorage.setItem(
                            LS_KEY,
                            key.trim(),
                        );
                    } catch (e) {
                        console.error(
                            "[Pabau LOPD] No s'ha pogut desar la clau:",
                            e,
                        );
                    }
                }
            }
            return key;
        }

        function clear() {
            try {
                window.localStorage.removeItem(LS_KEY);
            } catch (e) {
                /* noop */
            }
        }

        /**
         * Com que Userscripts no ofereix menú propi (GM_registerMenuCommand
         * tampoc funciona a iOS), afegim un "trigger" per URL: si la URL
         * conté `?__change_lopd_key=1`, obrim un prompt per canviar-la.
         * Es pot cridar manualment des de la consola:
         *
         *   location.search = '?__change_lopd_key=1';
         *
         * o afegint un bookmarklet:
         *
         *   javascript:location.search='?__change_lopd_key=1';
         */
        function changeKeyShortcut() {
            const url = new URL(location.href);
            if (url.searchParams.get("__change_lopd_key") !== "1") return;
            url.searchParams.delete("__change_lopd_key");
            history.replaceState(null, "", url.toString());
            const next = prompt(
                "Nova API key de Pabau (deixa buit per mantenir l'actual):",
                "",
            );
            if (next && next.trim()) {
                try {
                    window.localStorage.setItem(LS_KEY, next.trim());
                    alert("API key actualitzada. Recarrega la pàgina.");
                } catch (e) {
                    alert("Error desant la clau: " + e);
                }
            }
        }

        function registerMenu() {
            // No-op a Userscripts. Es delega en `changeKeyShortcut()`.
            changeKeyShortcut();
        }

        return { get, clear, registerMenu };
    })();

    /* =========================================================================
     * 5. MÒDUL: documentsApi
     * ----------------------------------------------------------------------
     * Encapsula la consulta a l'API de Pabau per saber si el client té
     * LOPD_FIRMADO.pdf. Usa `fetch` natiu (no GM_xmlhttpRequest) per
     * compatibilitat amb Userscripts ≥ 1.2.1 a iOS Safari.
     *
     * NOTA CORS: la pàgina https://app.pabau.com NO és el mateix origen
     * que https://api.oauth.pabau.com, per la qual cosa `fetch` rebrà
     * una resposta amb CORS. Si Pabau no envia
     * `Access-Control-Allow-Origin: https://app.pabau.com`, el `fetch`
     * fallarà amb "TypeError: Failed to fetch".
     *
     * En aquest cas l'script LOGUEJARÀ l'error i no bloquejarà cap botó
     * (la política del README és "error de xarxa → no bloqueig"). Si es
     * dóna aquest cas a iOS, caldrà revisar el tractament CORS del
     * servidor — una alternativa seria afegir `?callback=...` JSONP, però
     * Pabau no l'ofereix. En cas de necessitat, es pot tornar a la
     * versió Tampermonkey o obrir un túnel.
     * ======================================================================= */

    const documentsApi = (() => {
        function fetchPabau(url) {
            // IMPORTANT: NO usem `credentials: "include"`. Pabau retorna
            // `Access-Control-Allow-Origin: *` (com un CDN públic) i el
            // navegador rebutja la petició si s'envien credencials
            // ("Cannot use wildcard in Access-Control-Allow-Origin when
            // credentials flag is true"). L'autenticació ja va a la URL
            // (l'API key és part del path), per la qual cosa NO cal
            // cap cookie ni credential.
            return fetch(url, {
                method: "GET",
                mode: "cors",
                credentials: "omit",
                redirect: "follow",
                headers: { Accept: "application/json" },
            });
        }

        /**
         * Cerca un document pel títol exacte dins els documents del client.
         * Retorna TOTS els resultats (ordenats DESC per l'API) perquè el
         * caller pugui decidir quin fer servir (p. ex. el més recent).
         * @returns {Promise<{found: boolean, documents: Array, document: object|null}>}
         */
        async function findDocument({ apiKey: key, clientId, documentName }) {
            // Pabau desatitza els noms pujats substituint cada caràcter
            // accentuat per la vocal/n lletja + "?". El seu cercador
            // /clients/{id}/documents?search=... és LITERAL, per la qual
            // cosa li hem de passar el nom amb aquesta mateixa conversió
            // (si no, no trobarà cap coincidència). Veure mòdul `accents`.
            const searchTerm = accents.mangle(documentName);

            const url =
                `${CONFIG.API_BASE}/${encodeURIComponent(key)}` +
                `/clients/${clientId}/documents` +
                `?order=DESC&per_page=50&page=1` +
                `&search=${encodeURIComponent(searchTerm)}`;

            let res;
            try {
                res = await fetchPabau(url);
            } catch (err) {
                // Error de xarxa o de CORS — no podem distingir-los des
                // d'aquí. Política: NO bloquegem cap botó. Loguem el
                // detall per facilitar el diagnòstic a iOS.
                console.warn(
                    `[Pabau LOPD] Fetch fallit per a ${documentName}. ` +
                    `Si és un error CORS, Pabau pot estar retornant ` +
                    `Access-Control-Allow-Origin: * amb credentials rebutjats. ` +
                    `Comprova que la clau API és correcta i que Pabau ` +
                    `permet l'origen https://app.pabau.com.`,
                    err,
                );
                throw new Error("Error de xarxa o CORS: " + err.message);
            }

            if (res.status === 200) {
                try {
                    const data = await res.json();
                    const list =
                        data.documents || data.results || data.data || [];
                    const target = documentName.toLowerCase();
                    // Acceptem coincidència contra:
                    //   - El nom ORIGINAL amb accents (si un dia Pabau
                    //     corregeix la sanitització).
                    //   - El nom MANGLED que Pabau ha desat.
                    //   - La variant MANGLED sense "?" (per si algun cop
                    //     es queda sense "?" però encara sense accents).
                    const targetMangled =
                        accents.mangle(documentName).toLowerCase();
                    const targetStripped =
                        targetMangled.replace(/\?/g, "");
                    const matches = list.filter((d) => {
                        const name = (
                            d.photo_title ||
                            d.name ||
                            d.filename ||
                            d.title ||
                            ""
                        ).toLowerCase();
                        return (
                            name === target ||
                            name === targetMangled ||
                            name === targetStripped
                        );
                    });
                    return {
                        found: matches.length > 0,
                        documents: matches,
                        document: matches[0] || null,
                    };
                } catch (e) {
                    throw new Error("Resposta JSON no vàlida");
                }
            } else if (res.status === 401 || res.status === 403) {
                apiKey.clear();
                throw new Error("API key invàlida — s'ha esborrat");
            } else {
                throw new Error(
                    `HTTP ${res.status}: ${res.statusText || ""}`,
                );
            }
        }

        return { findDocument };
    })();

    /* =========================================================================
     * 5b. MÒDUL: invoiceApi
     * ----------------------------------------------------------------------
     * Consulta el detall d'una factura a partir del seu número
     * (`inv_no`) i retorna els items normalitzats amb el document
     * requerit ja resolt pel mapa `treatmentsConfig`.
     * ======================================================================= */
    const invoiceApi = (() => {
        function fetchPabau(url) {
            // Veure justificació a documentsApi.fetchPabau — NO credentials.
            return fetch(url, {
                method: "GET",
                mode: "cors",
                credentials: "omit",
                redirect: "follow",
                headers: { Accept: "application/json" },
            });
        }

        /**
         * @returns {Promise<{found: boolean, items: Array, raw: object|null}>}
         */
        async function getByInvoiceNo({ apiKey: key, invoiceNo }) {
            const url =
                `${CONFIG.API_BASE}/${encodeURIComponent(key)}` +
                `/invoices?inv_no=${encodeURIComponent(invoiceNo)}`;

            let res;
            try {
                res = await fetchPabau(url);
            } catch (err) {
                throw new Error("Error de xarxa o CORS: " + err.message);
            }

            if (res.status === 200) {
                let data;
                try {
                    data = await res.json();
                } catch (e) {
                    throw new Error(
                        "Resposta /invoices no vàlida: " + e.message,
                    );
                }
                const list = data.invoices || [];
                if (list.length === 0) {
                    return { found: false, items: [], raw: data };
                }
                const inv = list[0];
                const rawItems = Array.isArray(inv.items) ? inv.items : [];
                const items = rawItems.map((it) => {
                    const tx =
                        treatmentsConfig.getById(it.product_id) ||
                        treatmentsConfig.getByName(it.item_name);
                    return {
                        product_id: it.product_id,
                        item_name: it.item_name,
                        category: it.category,
                        document:
                            tx && tx.document
                                ? {
                                      base: tx.document.base,
                                      expiryMonths:
                                          tx.document.expiryMonths,
                                  }
                                : null,
                    };
                });
                return { found: true, items, raw: inv };
            } else if (res.status === 401 || res.status === 403) {
                apiKey.clear();
                throw new Error("API key invàlida — s'ha esborrat");
            } else {
                throw new Error(`HTTP ${res.status}: ${res.statusText || ""}`);
            }
        }

        return { getByInvoiceNo };
    })();

    /* =========================================================================
     * 5c. MÒDUL: invoiceLookup
     * ----------------------------------------------------------------------
     * Per a una factura donada:
     *   1. Crida /invoices?inv_no=...
     *   2. Construeix el llistat ÚNIC de documents requerits:
     *        - LOPD_FIRMADO.pdf (sempre, sense caducitat)
     *        - Els documents associats als tractaments, deduplicats per base
     *   3. Per cada document requerit consulta /clients/{id}/documents i es
     *      queda amb la coincidència més nova (ordenada DESC per l'API).
     *   4. Avalua caducitat sobre `documents[0].date`.
     * ======================================================================= */
    const invoiceLookup = (() => {
        /** Formata una data de l'API ("YYYY-MM-DD HH:MM:SS") a "DD/MM/YYYY". */
        function formatDate(dateStr) {
            if (!dateStr) return null;
            const d = new Date(String(dateStr).replace(" ", "T"));
            if (Number.isNaN(d.getTime())) return null;
            const day = String(d.getDate()).padStart(2, "0");
            const month = String(d.getMonth() + 1).padStart(2, "0");
            return `${day}/${month}/${d.getFullYear()}`;
        }

        /** Comprova si el document està caducat. expiryMonths<=0 = no caduca. */
        function isExpired(dateStr, expiryMonths) {
            if (!expiryMonths || expiryMonths <= 0) return false;
            if (!dateStr) return true;
            // Format esperat: "2026-07-02 18:03:05" → cal substituir l'espai per "T"
            const d = new Date(String(dateStr).replace(" ", "T"));
            if (Number.isNaN(d.getTime())) return true;
            const expiry = new Date(d);
            expiry.setMonth(expiry.getMonth() + Number(expiryMonths));
            return new Date() > expiry;
        }

        /** Diferència en mesos entre dues dates (enter positiu). */
        function monthsSince(dateStr) {
            if (!dateStr) return null;
            const d = new Date(String(dateStr).replace(" ", "T"));
            if (Number.isNaN(d.getTime())) return null;
            const now = new Date();
            return (
                (now.getFullYear() - d.getFullYear()) * 12 +
                (now.getMonth() - d.getMonth())
            );
        }

        /** Constrou el llistat ÚNIC de papers: LOPD 1 cop + 1 per base de tractament. */
        function buildRequiredFromItems(items) {
            const byBase = new Map();
            for (const it of items) {
                if (!it.document) continue;
                const { base, expiryMonths } = it.document;
                if (byBase.has(base)) continue;
                byBase.set(base, {
                    base,
                    documentName: `${base}_FIRMADO.pdf`,
                    expiryMonths,
                });
            }
            return [
                {
                    documentName: CONFIG.LOPD_DOCUMENT,
                    base: CONFIG.LOPD_DOCUMENT,
                    expiryMonths: 0,
                    kind: "lopd",
                },
                ...[...byBase.values()].map((d) => ({
                    ...d,
                    kind: "treatment",
                })),
            ];
        }

        /**
         * Fa tota la validació d'una factura.
         * @returns {Promise<{
         *   found: boolean,
         *   items: Array,
         *   required: Array,
         *   issues: Array<{kind: string, name: string, scope: string, createdAt: string|null, monthsOld: number|null}>,
         *   raw: object|null
         * }>}
         */
        async function checkInvoice({ apiKey: key, clientId, invoiceNo }) {
            const { found, items, raw } = await invoiceApi.getByInvoiceNo({
                apiKey: key,
                invoiceNo,
            });
            if (!found) {
                return {
                    found,
                    items: [],
                    required: [],
                    issues: [
                        {
                            kind: "missing",
                            name: `Factura ${invoiceNo}`,
                            scope: "invoice",
                            createdAt: null,
                            monthsOld: null,
                        },
                    ],
                    raw,
                };
            }

            const required = buildRequiredFromItems(items);

            // Una sola crida per paper requerit, en paral·lel.
            const checks = await Promise.all(
                required.map(async (req) => {
                    try {
                        const r = await documentsApi.findDocument({
                            apiKey: key,
                            clientId,
                            documentName: req.documentName,
                        });
                        // El caller es queda amb la coincidència més nova
                        // (l'API ja torna DESC).
                        const top = r.document || null;
                        const createdAt = top ? top.date || null : null;
                        const expired =
                            !!top && isExpired(createdAt, req.expiryMonths);
                        return {
                            req,
                            doc: top,
                            found: !!top,
                            expired,
                            createdAt,
                        };
                    } catch (err) {
                        console.error(
                            `[Pabau LOPD] Error consultant ${req.documentName}:`,
                            err,
                        );
                        return {
                            req,
                            doc: null,
                            found: false,
                            expired: false,
                            createdAt: null,
                            error: err,
                        };
                    }
                }),
            );

            const issues = checks
                .filter(({ found, expired }) => !found || expired)
                .map(({ req, found, expired, createdAt }) => ({
                    kind: !found ? "missing" : "expired",
                    name: req.documentName,
                    scope: req.kind, // "lopd" | "treatment"
                    createdAt,
                    monthsOld: monthsSince(createdAt),
                }));

            return { found: true, items, required, issues, raw };
        }

        return { checkInvoice, buildRequiredFromItems, isExpired, monthsSince, formatDate };
    })();

    /* =========================================================================
     * 6. MÒDUL: buttonGuard
     * ----------------------------------------------------------------------
     * Fa la part visual: pintar el botó en vermell i deshabilitar-lo.
     * També ofereix la neteja (revertir a l'estat original) quan l'usuari
     * canvia de vista.
     * ======================================================================= */

    const buttonGuard = (() => {
        /**
         * Bloqueja UN sol botó (selector configurable). Aplica el color
         * vermell, desactiva, posa tooltip i desa l'estat als datasets.
         *
         * @param {string} selector - selector CSS del botó
         * @param {string} [customLabel] - Text a mostrar al botó
         * @param {string} [tooltip]     - Text per l'atribut `title`
         * @param {string} [key]         - Identificador (ex. "main" | "payment")
         */
        function blockOne(selector, customLabel, tooltip, key) {
            const btn = document.querySelector(selector);
            if (!btn) return false;

            const label = btn.querySelector("p") || btn;
            const finalLabel = customLabel || CONFIG.BLOCKED_LABEL;
            const finalTooltip = tooltip || "";
            const blockKey = key || "main";

            // Idempotència: si ja està bloquejat AMB el text/title visibles
            // correctes, no hi tornem.
            if (
                btn.dataset.lopdBlocked === "true" &&
                label.textContent === finalLabel &&
                btn.title === finalTooltip
            ) {
                return true;
            }

            // IMPORTANT: capturem el text ORIGINAL del <p> la primera vegada
            // que bloquegem, per poder restaurar-lo quan tota la documentació
            // estigui correcta. Sense això, el botó es queda amb el text
            // "Consultando documentación..." / "Falta la documentación firmada"
            // per sempre.
            if (!btn.dataset.lopdOriginalLabel) {
                btn.dataset.lopdOriginalLabel = label.textContent || "";
            }

            label.textContent = finalLabel;
            btn.title = finalTooltip;

            Object.assign(btn.style, {
                backgroundColor: "#dc3545",
                borderColor: "#dc3545",
                color: "#ffffff",
                opacity: "0.85",
                cursor: "not-allowed",
            });

            btn.disabled = true;
            btn.dataset.lopdBlocked = "true";
            btn.dataset.lopdLabel = finalLabel;
            btn.dataset.lopdTooltip = finalTooltip;
            btn.dataset.lopdKey = blockKey;
            return true;
        }

        /** Reverteix l'estat d'un botó bloquejat per aquest script. */
        function unblockOne(btn) {
            if (!btn) return;

            // IMPORTANT: restaurem el text ORIGINAL del <p> que hem desat
            // a `data-lopd-original-label` la primera vegada que es va
            // bloquejar. Si mai no es va arribar a bloquejar (perquè la
            // documentació ja estava OK de bon principi), no fem res amb
            // el text.
            const labelEl = btn.querySelector("p") || btn;
            if (btn.dataset.lopdOriginalLabel != null) {
                labelEl.textContent = btn.dataset.lopdOriginalLabel;
            }

            delete btn.dataset.lopdBlocked;
            delete btn.dataset.lopdLabel;
            delete btn.dataset.lopdTooltip;
            delete btn.dataset.lopdKey;
            // NOTA: NO esborrem `lopdOriginalLabel` perquè si l'usuari
            // canvia de tractament/items i torna a haver-hi issues,
            // puguem tornar a bloquejar i restaurar correctament.
            // (Sempre mantenim el primer text original capturat.)
            btn.title = "";
            btn.disabled = false;
            btn.style.cssText = "";
        }

        /**
         * Bloqueja el botó principal "Guardar cambios".
         * @param {string} [customLabel]
         * @param {string} [tooltip]
         */
        function block(customLabel, tooltip) {
            return blockOne(
                CONFIG.BUTTON_SELECTOR,
                customLabel,
                tooltip,
                "main",
            );
        }

        /**
         * Bloqueja TOTS els botons de mètode de pagament dins del
         * panell de pagaments. NOMÉS els desactiva + posa tooltip
         * (no toquem el text intern ni els estils del botó).
         *
         * @param {string} [tooltip]
         * @returns {number} nombre de botons bloquejats
         */
        function blockPaymentButtons(tooltip) {
            const tt =
                tooltip ||
                "No es pot cobrar fins que la documentació estigui al dia";
            const btns = document.querySelectorAll(
                CONFIG.PAYMENT_BUTTON_SELECTORS,
            );
            let n = 0;
            for (const b of btns) {
                // Seguretat: només bloquejem els que viuen dins del
                // panell de pagaments (no toquem cap botó que estigui
                // fora per error de selector).
                const inFooter = b.closest(CONFIG.PAYMENT_FOOTER_SELECTOR);
                if (!inFooter) continue;
                if (blockPaymentOnNode(b, tt)) n += 1;
            }
            return n;
        }

        /**
         * Versió "lleugera" del bloqueig: només `disabled` + `title`,
         * sense alterar el contingut del botó ni els seus estils.
         * A més, captura el `click` per si React o un altre listener
         * re-activa el botó: encara que quedi enabled, el clic es
         * neutralitza.
         *
         * IMPORTANT: NO posem `cursor: not-allowed` ni cap altre style
         * per no modificar l'aspecte del botó. Només el bloquegem
         * funcionalment.
         */
        function blockPaymentOnNode(btn, tooltip) {
            if (!btn) return false;
            const tt = tooltip || "";

            // Idempotència: si ja està bloquejat amb el mateix title, no hi tornem.
            if (
                btn.dataset.lopdBlocked === "true" &&
                btn.title === tt
            ) {
                return true;
            }

            // Capturem l'estat de `disabled` ABANS de tocar res per saber,
            // quan fem unblock, si el botó ja estava desactivat per Pabau
            // (i per tant NO l'hem de reactivar) o si l'hem desactivat nosaltres.
            if (btn.dataset.lopdWasDisabled == null) {
                btn.dataset.lopdWasDisabled = btn.disabled ? "true" : "false";
            }

            btn.disabled = true;
            btn.title = tt;
            btn.dataset.lopdBlocked = "true";
            btn.dataset.lopdTooltip = tt;
            btn.dataset.lopdKey = "payment";
            // NO apliquem cap style.* per no canviar l'aspecte.

            // Reforç: interceptar clics per si la reactivitat de
            // React torna a activar el botó entre cridades de l'observer.
            if (!btn.dataset.lopdGuard) {
                btn.dataset.lopdGuard = "1";
                btn.addEventListener(
                    "click",
                    (ev) => {
                        if (btn.dataset.lopdBlocked === "true") {
                            ev.preventDefault();
                            ev.stopPropagation();
                            ev.stopImmediatePropagation();
                        }
                    },
                    true, // capture: interceptem ABANS que React
                );
            }
            return true;
        }

        /**
         * Habilita els botons de pagament (perquè tota la documentació
         * està OK). Fa la inversa exacta de `blockPaymentButtons`.
         *
         * IMPORTANT: NOMÉS restablim els botons que HEM BLOQUEJAT
         * NOSALTRES (els que tenen `data-lopd-blocked="true"`). Si
         * un botó ja estava `disabled` ABANS que l'script hi toqués
         * (p. ex. perquè Pabau el desactiva segons algun estat intern
         * — saldo, validació de targeta, etc.), NO l'hem d'activar
         * nosaltres: només restaurem els que hem tocat.
         *
         * No exigim que visquin dins del PAYMENT_FOOTER_SELECTOR per
         * la mateixa raó d'abans: quan l'usuari CANVIA DE TAB el
         * panell queda `aria-hidden="true"` però els botons continuen
         * sent al DOM; els que estaven bloquejats els desbloquegem
         * aquí per deixar el DOM net.
         *
         * També esborrem `data-lopd-key` i `data-lopd-guard` per
         * garantir que quan es torni a bloquejar, el listener de
         * seguretat es tornarà a afegir (idempotentment gràcies a
         * la comprovació de `lopdGuard`).
         */
        function unblockPaymentButtons() {
            // Només actuem sobre els botons que havíem marcat NOSALTRES
            // amb `data-lopd-blocked="true"`. D'aquests, restablim
            // `disabled=false` NOMÉS si nosaltres l'havíem activat
            // (`data-lopd-was-disabled === "false"`); si ja estava
            // disabled quan el vam trobar (Pabau el desactiva per
            // saldo/validació/etc.) el deixem tal com estava.
            const btns = document.querySelectorAll(
                `${CONFIG.PAYMENT_BUTTON_SELECTORS}[data-lopd-blocked="true"]`,
            );
            let restored = 0;
            let skipped = 0;
            for (const b of btns) {
                const wasOurs =
                    b.dataset.lopdWasDisabled === "false";

                // En tots dos casos Netegem els marcadors i el `title`.
                delete b.dataset.lopdBlocked;
                delete b.dataset.lopdTooltip;
                delete b.dataset.lopdKey;
                b.title = "";

                if (!wasOurs) {
                    // Ja estava disabled abans del nostre bloqueig:
                    // deixem `disabled=true` (Pabau ho volia així).
                    skipped += 1;
                    continue;
                }

                // L'havíem desactivat nosaltres: el reactivem.
                b.disabled = false;
                restored += 1;
            }
            if (btns.length > 0) {
                console.log(
                    `[Pabau LOPD] unblockPaymentButtons: total=${btns.length}, restored=${restored}, skipped(botons-que-Pabau-tenia-disabled)=${skipped}`,
                );
            }
        }

        /**
         * Versió "instantània" del bloqueig: sense comprovar idempotència,
         * sense canviar el text. Pensada per ser cridada des d'un
         * MutationObserver que acaba de detectar que els botons acaben
         * de ser muntats al DOM.
         *
         * CRUCIAL: NO modifiquem NI EL COLOR NI EL text INTERN del botó.
         * Només fem `disabled=true` + `title` (per al tooltip) + capture
         * del click. Així, quan l'usuari surti del panel, els botons
         * continuen tenint el seu color i forma originals de Pabau.
         */
        function forceBlockAllPaymentButtons(tooltip) {
            const tt = tooltip || "Revisando documentación...";
            const btns = document.querySelectorAll(
                CONFIG.PAYMENT_BUTTON_SELECTORS,
            );
            let touched = 0;
            for (const b of btns) {
                // Seguretat: només toquem els que estan DINS del footer
                // del panel de pagaments (no toquem CSS fora d'aquí).
                const inFooter = b.closest(CONFIG.PAYMENT_FOOTER_SELECTOR);
                if (!inFooter) continue;

                // Capturem l'estat inicial de `disabled` per si Pabau
                // el tenia ja desactivat; així quan fem unblock sabem
                // si l'hem de reactivar o no.
                if (b.dataset.lopdWasDisabled == null) {
                    b.dataset.lopdWasDisabled = b.disabled ? "true" : "false";
                }

                // NO modifiquem: backgroundColor, color, borderColor,
                // opacity, ni el text intern del botó.
                b.disabled = true;
                b.title = tt;
                b.dataset.lopdBlocked = "true";
                b.dataset.lopdTooltip = tt;
                b.dataset.lopdKey = "payment";
                // NO posem style.cursor ni style.cssText: volem que el
                // botó conservi el seu aspecte original de Pabau.

                // Listener de seguretat (idempotent)
                if (!b.dataset.lopdGuard) {
                    b.dataset.lopdGuard = "1";
                    b.addEventListener(
                        "click",
                        (ev) => {
                            if (b.dataset.lopdBlocked === "true") {
                                ev.preventDefault();
                                ev.stopPropagation();
                                ev.stopImmediatePropagation();
                            }
                        },
                        true,
                    );
                }
                touched += 1;
            }
            console.log(
                `[Pabau LOPD] forceBlockAllPaymentButtons: ${touched} botons desactivats (footer)`,
            );
        }

        function unblockAll() {
            // 1) Botó principal (text + estils vermells)
            const main = document.querySelector(
                `${CONFIG.BUTTON_SELECTOR}[data-lopd-blocked]`,
            );
            if (main) unblockOne(main);

            // 2) Botons de pagament: els DESBLOQUEGEM sempre. Abans
            //    els manteníem bloquejats per defecte ("Revisando..."),
            //    però ara sabem que quan l'usuari surt del panell de
            //    pagaments ja no té sentit mantenir-los deshabilitats:
            //    la propera vegada que entri al panell, `process()`
            //    tornarà a bloquejar els que toqui (preventiu o per
            //    issues reals).
            unblockPaymentButtons();

            // 3) IMPORTANT: netejar TOTS els marcadors de lopd al DOM,
            //    no només als elements actualment bloquejats. Si el botó
            //    principal ja no té [data-lopd-blocked] però encara té
            //    [data-lopd-checked] o [data-lopd-key], la propera
            //    crida a process() pensarà que ja està processat i NO
            //    tornarà a bloquejar res quan l'usuari torni al panel.
            document
                .querySelectorAll(
                    `${CONFIG.BUTTON_SELECTOR}[data-lopd-key], ${CONFIG.BUTTON_SELECTOR}[data-lopd-checked]`,
                )
                .forEach((b) => {
                    delete b.dataset.lopdKey;
                    delete b.dataset.lopdChecked;
                    delete b.dataset.lopdLabel;
                    delete b.dataset.lopdTooltip;
                });
        }

        return {
            block,
            unblockOne,
            blockPaymentButtons,
            unblockPaymentButtons,
            forceBlockAllPaymentButtons,
            unblockAll,
        };
    })();

    /* =========================================================================
     * 7. MÒDUL: invoiceGuard
     * ----------------------------------------------------------------------
     * Orquestrador: per a cada vista de la SPA, decideix si cal bloquejar
     * el botó "Guardar cambios". Manté una memòria de vistes ja comprovades
     * (Set indexat per `clientId|pathname+search`) per no repetir crides
     * a l'API innecessàriament.
     *
     * Flux:
     *   1. Router notifica un canvi d'URL.
     *   2. Netejem l'estat del botó anterior.
     *   3. Si hem canviat de client, buidem la memòria.
     *   4. El MutationObserver del DOM detecta quan apareix el botó i
     *      crida `process()`. Si la vista ja s'ha processat, només
     *      reaplica el bloqueig; si no, consulta l'API un sol cop.
     * ======================================================================= */

    const invoiceGuard = (() => {
        const processedViews = new Set(); // memo: clientId|invoiceNo
        let inFlight = null; // Promise de la validació en curs (per evitar duplicats)
        let tabObserver = null; // MutationObserver dedicat als panels rc-tabs

        /**
         * Comprova si el panel de pagaments (3a pestanya de la pàgina
         * /financial) està actualment actiu. Retorna true NOMÉS quan
         * el div existeix I té aria-hidden="false".
         *
         * Si el panel no existeix (p. ex. l'usuari està en una altra
         * pestanya o la pàgina encara no ha renderitzat les tabs),
         * retornem false. El MutationObserver de `install()` ens
         * tornarà a cridar quan el DOM canviï, de manera que el
         * script segueix "funcionant" fins que troba el panel.
         */
        function isPaymentTabActive() {
            return (
                document.querySelectorAll(CONFIG.PAYMENT_PANEL_SELECTOR)
                    .length > 0
            );
        }

        /**
         * Retorna TOTS els elements `*-panel-N` que existeixin al DOM
         * (independint del seu aria-hidden). Serveix per saber a quins
         * panels hem de subscriure'ns amb l'observer de tabs.
         */
        function allTabPanels() {
            return Array.from(
                document.querySelectorAll('[id$="panel-0"], [id$="panel-1"], [id$="panel-2"], [id$="panel-3"], [id$="panel-4"]'),
            );
        }

        function clientIdFromPath(pathname) {
            const m = pathname.match(/^\/clients\/(\d+)\//);
            return m ? m[1] : null;
        }

        /** Neteja estats quan es canvia de vista o de client. */
        function handleNavigation({ oldHref }) {
            buttonGuard.unblockAll();
            invoiceStore.reset();

            const oldClient = clientIdFromPath(new URL(oldHref).pathname);
            const newClient = clientIdFromPath(location.pathname);
            if (oldClient !== newClient) processedViews.clear();
        }

        /**
         * S'ha canviat la pestanya activa. Si hem SORTIT del panel de
         * pagaments → desbloquegem TOT immediatament (botons de pagament
         * inclosos). Si hem ENTRAT al panel de pagaments → el `process()`
         * ja s'encarregarà a través de l'observer del `install()`.
         */
        function handleTabChange() {
            if (!isPaymentTabActive()) {
                buttonGuard.unblockAll();
            }
        }

        /** Format amigable d'un issue per al tooltip. */
        function fmtIssue(i) {
            const tag = i.scope === "lopd" ? "[LOPD] " : "[CI] ";

            if (i.kind === "missing") {
                // No tenim cap registre d'aquest document al client.
                return `${tag}${i.name} · No encontrado`;
            }

            // kind === "expired": el document existeix però ha caducat.
            const date = invoiceLookup.formatDate(i.createdAt);
            const when = date ? `subido el ${date}` : "fecha de subida desconocida";
            const months = i.monthsOld != null ? ` (hace ${i.monthsOld} meses)` : "";
            return `${tag}${i.name} · Caducado · ${when}${months}`;
        }

        /**
         * Text curt que es mostra al botó.
         * SEMPRE té el format "Faltan/caducan N documentos" (independentment
         * del nombre d'issues). El detall va al tooltip.
         */
        function buildLabel(result) {
            const issues = (result && result.issues) || [];
            if (issues.length === 0) return null;
            return `Faltan/caducan ${issues.length} documentos`;
        }

        /**
         * Text llarg que es mostra al `title` del botó (tooltip natiu).
         * Cada issue va en una LÍNIA nova (`\n`); els navegadors moderns
         * (Chrome/Firefox/Edge/Safari) respecten els salts de línia al
         * tooltip natiu i els mostren com a línies separades.
         */
        function buildTooltip(result) {
            const issues = (result && result.issues) || [];
            if (issues.length === 0) return null;
            return issues.map(fmtIssue).join("\n");
        }

        /**
         * Punt d'entrada del DOM observer; idempotent.
         * Flux:
         *   1. Si no tenim #invoice → esperem.
         *   2. Calculem cacheKey = clientId|invoiceNo.
         *   3. Bloquegem el botó AMB CONSULTA (evita que l'usuari cliqui
         *      mentre es fan les crides a l'API).
         *   4. Si ja tenim el resultat en memòria → reapliquem el botó.
         *   5. Si ja hi ha una consulta en vol per la mateixa clau → esperem-la.
         *   6. Sinó: invoquem invoiceLookup.checkInvoice.
         */
        async function process({ apiKey: key, clientId }) {
            const btn = document.querySelector(CONFIG.BUTTON_SELECTOR);
            if (!btn) return;

            // Només actuem quan el panel de pagaments està actiu.
            // Si no existeix o no està visible, NO fem res — el
            // MutationObserver del bootstrap ens tornarà a cridar
            // quan el DOM canviï (canvi de tab, muntatge inicial, etc.).
            if (!isPaymentTabActive()) return;

            const invoiceNo = invoiceStore.invoiceNo;
            if (!invoiceNo) return; // encara no tenim número de factura

            const cacheKey = `${clientId}|${invoiceNo}`;

            // 1) Ja estem processant aquesta combinació en aquest botó
            //    concret → no fem res. Usem `lopdChecked` (no pas
            //    `lopdKey`) perquè l'`unblockAll()` esborra TOTS els
            //    marcadors en sortir del panel, de manera que quan
            //    l'usuari TORN al panel, `lopdChecked` és undefined i
            //    podem tornar a aplicar el bloqueig.
            if (btn.dataset.lopdChecked === cacheKey) return;

            // 2) Ja tenim el resultat a memòria → reapliquem (no cal consultar).
            if (processedViews.has(cacheKey)) {
                btn.dataset.lopdChecked = cacheKey;
                // Distingim "OK" vs "amb issues" mirant si hi havia cap
                // label desat. Les factures OK es guarden amb lopdLabel=""
                // i les que tenen issues amb lopdLabel="Faltan/caducan N".
                const hadIssues = !!btn.dataset.lopdLabel;
                if (hadIssues) {
                    buttonGuard.block(
                        btn.dataset.lopdLabel,
                        btn.dataset.lopdTooltip || "",
                    );
                    buttonGuard.blockPaymentButtons(
                        btn.dataset.lopdTooltip || "",
                    );
                } else {
                    // La factura estava OK → restaurem el text ORIGINAL
                    // del botó (no pas el text per defecte "Falta la
                    // documentación firmada") i habilitem els pagaments.
                    buttonGuard.unblockOne(btn);
                    buttonGuard.unblockPaymentButtons();
                }
                return;
            }

            // 3) Bloquegem immediatament amb el text de "consultant"
            //    perquè l'usuari no pugui prémer el botó durant les crides.
            //    També bloquegem els botons de pagament (sempre deshabilitats
            //    per defecte; només s'habilitaran si la validació és OK).
            //    Marquem el botó amb el cacheKey per evitar duplicar feina.
            buttonGuard.block(CONFIG.CONSULTING_LABEL, "");
            buttonGuard.blockPaymentButtons(CONFIG.CONSULTING_LABEL);
            btn.dataset.lopdChecked = cacheKey;
            btn.dataset.lopdLabel = CONFIG.CONSULTING_LABEL;
            btn.dataset.lopdTooltip = "";

            // 4) Si ja hi ha una validació en curs per la mateixa combinació
            //    → esperem-la i reapliquem el resultat.
            if (inFlight && inFlight.key === cacheKey) {
                await inFlight.promise;
                const hadIssues = !!btn.dataset.lopdLabel;
                if (hadIssues) {
                    buttonGuard.block(
                        btn.dataset.lopdLabel,
                        btn.dataset.lopdTooltip || "",
                    );
                    buttonGuard.blockPaymentButtons(
                        btn.dataset.lopdTooltip || "",
                    );
                } else {
                    buttonGuard.unblockOne(btn);
                    buttonGuard.unblockPaymentButtons();
                }
                return;
            }

            // 5) Llancem la validació.
            const p = (async () => {
                try {
                    return await invoiceLookup.checkInvoice({
                        apiKey: key,
                        clientId,
                        invoiceNo,
                    });
                } catch (err) {
                    console.error(
                        "[Pabau LOPD] Error consultant la factura:",
                        err,
                    );
                    // Política del README: error de xarxa → NO bloquegem.
                    return { found: false, items: [], required: [], issues: [], error: err };
                }
            })();
            inFlight = { key: cacheKey, promise: p };
            const result = await p;
            inFlight = null;

            processedViews.add(cacheKey);

            const label = buildLabel(result);
            const tooltip = buildTooltip(result);
            console.log(
                `[Pabau LOPD] Client ${clientId} · factura ${invoiceNo} →`,
                {
                    items: (result.items || []).map((it) => it.item_name),
                    issues: (result.issues || []).length,
                    label,
                },
            );

            if (label) {
                btn.dataset.lopdLabel = label;
                btn.dataset.lopdTooltip = tooltip || "";
                buttonGuard.block(label, tooltip);

                // També bloquegem tots els botons de mètode de pagament
                // (Credit, Points, Card, Cash, Vouchers, etc.) del
                // panell de pagaments. Només els desactivem + tooltip,
                // SENSE tocar el text intern ni els estils del botó.
                buttonGuard.blockPaymentButtons(
                    tooltip ||
                        "No es pot cobrar fins que la documentació estigui al dia",
                );
                // NOTA: NO creem cap MutationObserver intern aquí.
                // L'únic observer que ens interessa és el del `install()`,
                // que ja torna a cridar `process()` quan canvii el DOM.
                // Si en creéssim un, reblocaríem el botó encara que
                // l'usuari hagi canviat a una altra tab (el panel
                // rc-tabs-*-panel-2 segueix sent al DOM, només ha canviat
                // el seu aria-hidden).
            } else {
                // Tota la documentació és correcta → habilitem els
                // botons de pagament (fins ara estaven deshabilitats
                // per defecte). El botó principal ha de tornar al seu
                // text ORIGINAL (p. ex. "Guardar cambios"), NO pas al
                // "Consultando documentación..." que hem posat mentre
                // consultàvem l'API.
                //
                // Marquem explícitament `lopdLabel=""` per distingir
                // aquesta factura de les que tenen issues en el replay
                // (veure branca `processedViews.has(cacheKey)` dins
                // `process()`).
                btn.dataset.lopdLabel = "";
                btn.dataset.lopdTooltip = "";
                buttonGuard.unblockOne(btn);
                buttonGuard.unblockPaymentButtons();
            }
        }

        /**
         * Instal·la el routerWatcher i el DOM observer.
         */
        function install({ apiKey: key }) {
            routerWatcher.subscribe(handleNavigation);

            // Reaccionar a qualsevol muntatge/desmuntatge del botó o del #invoice.
            const ensureDom = () => {
                const clientId = clientIdFromPath(location.pathname);
                if (!clientId) return;

                // CAS 1: NO estem al panel de pagaments.
                // → Els botons tornen al seu color/estat originals de
                //   Pabau (no els hem tocat mai CSS) i netegem markers.
                if (!isPaymentTabActive()) {
                    buttonGuard.unblockPaymentButtons();
                    return;
                }

                // CAS 2: Panel actiu.
                // Bloquegem preventivament NOMÉS una vegada (quan encara
                // no tenim el resultat de l'API en memòria). Després,
                // `process()` ja s'encarrega de mantenir l'estat correcte.
                //
                // IMPORTANT: hem d'evitar re-bloquejar cada vegada que
                // l'observer es dispara (passa centenars de vegades per
                // segon). Per això comprovem `processedViews.has(cacheKey)`.
                const invoiceNo = invoiceStore.invoiceNo;
                const cacheKey =
                    invoiceNo != null ? `${clientId}|${invoiceNo}` : null;
                const alreadyProcessed =
                    cacheKey != null && processedViews.has(cacheKey);

                if (!alreadyProcessed) {
                    buttonGuard.forceBlockAllPaymentButtons(
                        "Revisando documentación...",
                    );
                }

                process({ apiKey: key, clientId });
            };

            if (document.readyState === "loading") {
                document.addEventListener("DOMContentLoaded", ensureDom);
            } else {
                ensureDom();
            }
            const mo = new MutationObserver(ensureDom);
            mo.observe(document.body, { childList: true, subtree: true });

            // Observer específic per detectar canvis de tab dins de
            // /financial. Quan l'aria-hidden d'un panel canvia,
            // mirem si estem al panel de pagaments o no.
            const subscribeTabPanels = () => {
                if (tabObserver) tabObserver.disconnect();
                tabObserver = new MutationObserver(handleTabChange);
                for (const panel of allTabPanels()) {
                    tabObserver.observe(panel, {
                        attributes: true,
                        attributeFilter: ["aria-hidden", "class"],
                    });
                }
            };
            subscribeTabPanels();

            // Re-subscriure quan el body canviï (per si React remunta
            // les tabs, cosa que passa sovint a la SPA).
            const tabResub = new MutationObserver(() => {
                const panels = allTabPanels();
                if (panels.length === 0) return;
                // Comprovem si ja estem observant tots els panels.
                // Si n'hi ha cap de nou, re-subscriure.
                const current = tabObserver ? tabObserver.takeRecords() : [];
                if (current.length > 0) return;
                subscribeTabPanels();
            });
            tabResub.observe(document.body, { childList: true, subtree: true });
        }

        return { install };
    })();

    /* =========================================================================
     * 8. BOOTSTRAP
     * ----------------------------------------------------------------------
     * Punt d'entrada: valida la URL, carrega l'API key i connecta tots
     * els mòduls. Si la pàgina no conté `?referrer=...`, no fem res.
     * ======================================================================= */

    function bootstrap() {
        // El @match cobreix tota l'app Pabau, però el bloqueig del botó
        // només s'aplica quan location.pathname és /clients/<id>/...
        // (ho gestiona invoiceGuard.process → clientIdFromPath).
        // Per tant NO fem return aquí: hem d'instal·lar sempre el
        // routerWatcher i l'invoiceGuard per reaccionar a la navegació SPA.

        const key = apiKey.get();
        if (!key) {
            console.error("[Pabau LOPD] No s'ha proporcionat API key.");
            return;
        }

        apiKey.registerMenu();
        routerWatcher.install();

        // Llancem la cerca inicial del #invoice quan el body existeixi.
        if (document.body) {
            invoiceStore.start();
        } else {
            document.addEventListener("DOMContentLoaded", () =>
                invoiceStore.start(),
            );
        }

        invoiceGuard.install({ apiKey: key });
        const initialClientId = location.pathname.match(/^\/clients\/(\d+)\//);
        const handlerLabel = IS_USERScripts
            ? "Userscripts (iOS Safari)"
            : "Userscript";
        console.log(
            `%c[Pabau LOPD] Actiu a ${location.pathname}${
                initialClientId ? ` (client ${initialClientId[1]})` : ""
            } · ${handlerLabel}`,
            "background:#28a745;color:#fff;padding:2px 6px;border-radius:3px;",
        );
        // Reaccionar també a canvis de valor de #invoice un cop muntat
        // (Pabau pot injectar-lo més tard que el #operation-create).
        const invoiceObserver = new MutationObserver(() => {
            const el = document.querySelector(CONFIG.INVOICE_SELECTOR);
            if (el && el.value && !el.dataset.lopdWatched) {
                el.dataset.lopdWatched = "1";
                el.dispatchEvent(new Event("change", { bubbles: true }));
            }
        });
        invoiceObserver.observe(document.body, {
            childList: true,
            subtree: true,
        });
    }

    bootstrap();
})();
