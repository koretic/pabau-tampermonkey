// ==UserScript==
// @name         Block invoice Pabau - LOPD check
// @namespace    http://tampermonkey.net/
// @version      1.0.5
// @description  Comprova els papers requerits (LOPD + CI per tractament) pels items d'una factura Pabau
// @author       Alex Rodriguez
// @homepageURL  https://github.com/koretic/pabau-tampermonkey
// @downloadURL  https://raw.githubusercontent.com/koretic/pabau-tampermonkey/main/TamperMonkey_documentacion_script_3.js
// @updateURL    https://raw.githubusercontent.com/koretic/pabau-tampermonkey/main/TamperMonkey_documentacion_script_3.js
// @match        https://app.pabau.com/*
// @match        https://app.pabau.com/clients/*/financial*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=pabau.com
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.oauth.pabau.com
// @run-at       document-end
// @sandbox      JavaScript
// ==/UserScript==

/**
 * Estructura del fitxer:
 *
 *   1. Constants i selectors
 *   2. Mòdul `invoiceStore`     -> gestiona el valor de #invoice de forma reactiva
 *   3. Mòdul `routerWatcher`   -> detecta canvis d'URL a la SPA
 *   4. Mòdul `apiKey`          -> lectura/escriptura de la clau desada
 *   5. Mòdul `documentsApi`    -> consulta de LOPD_FIRMADO.pdf a l'API
 *   5b. Mòdul `invoiceApi`     -> consulta del detall d'una factura per número
 *   5c. Mòdul `invoiceLookup`  -> orquestra invoiceApi + documentsApi per factura
 *   5d. Mòdul `modalInvoiceExtractor` -> helpers per detectar el modal
 *       d'edició de factura obert des del calendari i extreure'n
 *       el número de factura del DOM.
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
     * 1. CONSTANTS I SELECTORS
     * ======================================================================= */
    const CONFIG = Object.freeze({
        STORAGE_KEY: "pabau_api_key",
        API_BASE: "https://api.oauth.pabau.com",
        INVOICE_SELECTOR: "#invoice",
        BUTTON_SELECTOR: 'button[data-testid="operation-create"]',
        BLOCKED_LABEL: "Falta la documentación firmada",
        LOPD_DOCUMENT: "LOPD_FIRMADO.pdf", // sempre requerit
        // === DEBUG ===========================================================
        // Per defecte, el panell de debug està DESACTIVAT. Pots activar-lo:
        //   1. Canviant DEBUG_DEFAULT a `true` i tornant a carregar l'script.
        //   2. Des del menú de Tampermonkey → 🔍 Debug: ON/OFF.
        //   3. Amb el shortcut de teclat Ctrl+Shift+D.
        // L'estat es desa entre sessions amb GM_setValue.
        DEBUG_DEFAULT: false,
        DEBUG_STORAGE_KEY: "pabau_debug_enabled",
        // Shortcut per fer toggle del panell de debug ràpidament.
        // Format: Ctrl+Shift+D (D de Debug).
        DEBUG_SHORTCUT: { ctrl: true, shift: true, key: "D" },
        // ====================================================================
        // Text que es mostra al botó mentre s'està consultant l'API.
        // El botó ja queda disabled; el text és purament informatiu.
        CONSULTING_LABEL: "Consultando documentación...",
        // Modal d'edició de factura que Pabau obre quan es clica sobre
        // un event/cita al calendari (/calendar). Aquest modal s'obre
        // DINS la pàgina /calendar (no canvia la URL), per la qual cosa
        // el clientId s'obté SEMPRE via API /invoices (consultant el
        // camp `client[0].contact_id`), NO del pathname.
        // Veure mòdul `modalInvoiceExtractor` i la lògica unificada a
        // `invoiceGuard.process`.
        EDIT_INVOICE_MODAL_SELECTOR:
            '[class*="EditInvoice_editInvoiceModal"]',
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
            'button[aria-label="card-other-button"]',
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
            // Caducitat temporal d'1 dia per provar la detecció de documents caducats.
            { id: 2702512, name: "Marcación mandibular",                category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO", expiryMonths: 12 } },
            { id: 2702513, name: "Proyección de mentón",                 category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO", expiryMonths: 12 } },
            { id: 2702514, name: "Proyección de pómulos",                category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO", expiryMonths: 12 } },
            { id: 2702515, name: "Corrección surco nasogeniano",         category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO", expiryMonths: 12 } },
            { id: 2702516, name: "Corrección líneas de marioneta",       category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO", expiryMonths: 12 } },
            { id: 2702517, name: "Corrección sonrisa gingival",          category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO", expiryMonths: 12 } },
            { id: 2702518, name: "Relleno fosa temporal",                category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO", expiryMonths: 12 } },
            { id: 2702519, name: "Código de barras",                     category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO", expiryMonths: 12 } },
            { id: 2702520, name: "Corrección de ojeras",                 category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO", expiryMonths: 12 } },
            { id: 2702521, name: "Diseño de labios",                     category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO", expiryMonths: 12 } },
            { id: 2702522, name: "Rinomodelación",                       category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO", expiryMonths: 12 } },
            { id: 2702523, name: "Rinomodelación con cirugía previa",    category: "Ácido Hialurónico",   document: { base: "CI ACIDO HIALURONICO", expiryMonths: 12 } },

            // ============ Blefaroplastia ============
            { id: 2702542, name: "Blefaroplastia superior",              category: "Blefaroplastia",      document: { base: "CI BLEFAROPLASTIA",     expiryMonths: 12 } },
            { id: 2702543, name: "Blefaroplastia inferior",              category: "Blefaroplastia",      document: { base: "CI BLEFAROPLASTIA",     expiryMonths: 12 } },
            { id: 2702544, name: "Blefaroplastia 4 párpados",            category: "Blefaroplastia",      document: { base: "CI BLEFAROPLASTIA",     expiryMonths: 12 } },

            // ============ Exosomas y Biología ============
            { id: 2702547, name: "Hialuronidasa",                        category: "Exosomas y Biología", document: { base: "CI HIALURONIDASA", expiryMonths: 12 } },
            { id: 2702545, name: "Exosomas autólogos",                   category: "Exosomas y Biología", document: { base: "CONSENTIMIENTO EXOSOMAS AUTOLOGOS", expiryMonths: 12 } },
            { id: 2702625, name: "Polinucleótidos",                      category: "Exosomas y Biología", document: { base: "CI POLINUCLEOTIDOS UNIVERSAL", expiryMonths: 12 } },
            { id: 2702619, name: "Polinucleótidos Facial",               category: "Exosomas y Biología", document: { base: "CI POLINUCLEOTIDOS UNIVERSAL", expiryMonths: 12 } },
            { id: 2702546, name: "Polinucleótidos Ojeras",               category: "Exosomas y Biología", document: { base: "CI POLINUCLEOTIDOS UNIVERSAL", expiryMonths: 12 } },

            // ============ Inductores de colágeno (Sculptra / Radiesse) ============
            { id: 2702531, name: "Sculptra cuello",                      category: "Inductores",          document: { base: "CI INDUCTOR DE COLAGENO", expiryMonths: 12 } },
            { id: 2702530, name: "Sculptra cara",                        category: "Inductores",          document: { base: "CI INDUCTOR DE COLAGENO", expiryMonths: 12 } },
            { id: 2702532, name: "Radiesse Cara",                        category: "Inductores",          document: { base: "CI INDUCTOR DE COLAGENO", expiryMonths: 12 } },
            { id: 2702533, name: "Radiesse cuello",                      category: "Inductores",          document: { base: "CI INDUCTOR DE COLAGENO", expiryMonths: 12 } },
            { id: 2702597, name: "Inductores de colágeno",               category: "Inductores",          document: { base: "CI INDUCTOR DE COLAGENO", expiryMonths: 12 } },
            { id: 2702622, name: "Radiesse Glúteo",                      category: "Inductores",          document: { base: "CI INDUCTOR DE COLAGENO", expiryMonths: 12 } },
            { id: 2702621, name: "Sculptra Glúteo",                      category: "Inductores",          document: { base: "CI INDUCTOR DE COLAGENO", expiryMonths: 12 } },
            // Sense product_id a Pabau (encara no apareix a cap factura);
            // el match es fa per NOM. Si Pabau retorna un altre ID per
            // aquest nom, cal afegir-lo aquí.
            {                                          name: "Inductores de colágeno Manos",           category: "Inductores",   document: { base: "CI INDUCTOR DE COLAGENO", expiryMonths: 12 } },

            // ============ Láser Rejuvenecimiento ============
            // NOTA: Alguns tractaments tenen DOS documents vàlids (OR):
            //   - CI LASER_FIRMADO.pdf
            //   - CI LASER PICO (EN)_FIRMADO.pdf
            // Si en té un dels dos, és vàlid.
            { id: 2702561, name: "Láser Pico rejuvenecimiento / manchas / melasma", category: "Láser Rejuvenecimiento",   documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702560, name: "ResurFX rejuvenecimiento",                       category: "Láser Rejuvenecimiento",       documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702562, name: "CO2 Panfacial completo",                         category: "Láser Rejuvenecimiento",       documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702563, name: "CO2 Tercio medio",                               category: "Láser Rejuvenecimiento",       documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702564, name: "CO2 Periocular",                                 category: "Láser Rejuvenecimiento",       documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702565, name: "CO2 Cuello",                                     category: "Láser Rejuvenecimiento",       documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702566, name: "CO2 Cara y cuello",                              category: "Láser Rejuvenecimiento",       documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702567, name: "CO2 Cara, cuello y escote",                      category: "Láser Rejuvenecimiento",       documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702568, name: "CO2 Escote",                                     category: "Láser Rejuvenecimiento",       documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702569, name: "CO2 Verrugas",                                   category: "Láser Rejuvenecimiento",       documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702620, name: "CO2 Perioral",                                   category: "Láser Rejuvenecimiento",       documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702626, name: "Resurhair",                                       category: "Láser Rejuvenecimiento",       documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },

            // ============ Láser Vascular y Pigmentación ============
            // NOTA: La majoria tenen dos documents vàlids (OR). Eliminar tattoo té un document propi.
            { id: 2702570, name: "IPL manchas faciales",                           category: "Láser Vascular y Pigmentación", documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702571, name: "IPL periocular",                                 category: "Láser Vascular y Pigmentación", documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702572, name: "Nd-Yag vascular",                                category: "Láser Vascular y Pigmentación", documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702573, name: "Eliminar tattoo",                                category: "Láser Vascular y Pigmentación", documents: [{ base: "CI ELIMINACION DE TATUAJES", expiryMonths: 12 }] },
            { id: 2702591, name: "Nd-Yag Puntos rubi x1",                          category: "Láser Vascular y Pigmentación", documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702592, name: "Nd-Yag Puntos rubi de 5 a 15",                   category: "Láser Vascular y Pigmentación", documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702593, name: "Nd-Yag Puntos rubi más de 15",                   category: "Láser Vascular y Pigmentación", documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702594, name: "Nd-Yag Arañas Vasculares x1",                    category: "Láser Vascular y Pigmentación", documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702595, name: "Nd-Yag Arañas Vasculares de 5 a 15",             category: "Láser Vascular y Pigmentación", documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702596, name: "Nd-Yag Arañas Vasculares más de 15",             category: "Láser Vascular y Pigmentación", documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 2702574, name: "Nd-Yag Venas Prioculares",                       category: "Láser Vascular y Pigmentación", documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            
            // ============ Marketing ============
            { id: 2702615, name: "Colaboración",                                   category: "Marketing",   document: { base: "CI USO IMAGENES SONIDO",     expiryMonths: 12 } },

            // ============ Mesoterapia / PRGF / PRP ============
            { id: 2702554, name: "Vitaminas NCTF 135 AH rostro",                   category: "Mesoterapia", document: { base: "CI MESOTERAPIA CON VITAMINAS", expiryMonths: 12 } },
            { id: 2702555, name: "Vitaminas NCTF 135 AH periocular",               category: "Mesoterapia", document: { base: "CI MESOTERAPIA CON VITAMINAS", expiryMonths: 12 } },
            { id: 2702556, name: "PRGF Facial",                                    category: "Mesoterapia", document: { base: "CI PRGF ES 2026", expiryMonths: 12 } },
            { id: 2702557, name: "PRGF Capilar",                                   category: "Mesoterapia", document: { base: "CI PRGF ES 2026", expiryMonths: 12 } },
            { id: 2702558, name: "PRGF COLIRIO",                                   category: "Mesoterapia", document: { base: "CI PRGF ES 2026", expiryMonths: 12 } },
            { id: 2702559, name: "Pack Vitaminas + PRGF",                          category: "Mesoterapia", document: { base: "CI PRGF ES 2026", expiryMonths: 12 } },
            { id: 2702616, name: "PRP Facial",                                     category: "Mesoterapia", document: { base: "CI PRP ES 2026",  expiryMonths: 12 } },
            { id: 2702617, name: "PRP Capilar",                                    category: "Mesoterapia", document: { base: "CI PRP ES 2026",  expiryMonths: 12 } },
            { id: 2702618, name: "Pack Vitaminas + PRP",                           category: "Mesoterapia", document: { base: "CI PRP ES 2026",  expiryMonths: 12 } },
            { id: 2702623, name: "Plasma Gel",                                     category: "Mesoterapia",  document: { base: "CI PALSMA GEL",   expiryMonths: 12 } },

             // ============ Neuromoduladores ============
            { id: 2702524, name: "Neuromoduladores - 1 zona",            category: "Neuromoduladores",    document: { base: "CI TOXINA BOTULINICA",   expiryMonths: 12 } },
            { id: 2702525, name: "Neuromoduladores - 2 zonas",           category: "Neuromoduladores",    document: { base: "CI TOXINA BOTULINICA",   expiryMonths: 12 } },
            { id: 2702526, name: "Neuromoduladores - 3 zonas",           category: "Neuromoduladores",    document: { base: "CI TOXINA BOTULINICA",   expiryMonths: 12 } },
            { id: 2702527, name: "Neuromoduladores tercio inferior",     category: "Neuromoduladores",    document: { base: "CI TOXINA BOTULINICA",   expiryMonths: 12 } },
            { id: 2702528, name: "Bruxismo",                             category: "Neuromoduladores",    document: { base: "CI TOXINA BOTULINICA",   expiryMonths: 12 } },
            { id: 2702529, name: "Hiperhidrosis",                        category: "Neuromoduladores",    document: { base: "CI TOXINA BOTULINICA",   expiryMonths: 12 } },
            { id: 2702627, name: "NEUROMODULADORES LATISMA",             category: "Neuromoduladores",    document: { base: "CI TOXINA BOTULINICA",   expiryMonths: 12 } },
            { id: 2702628, name: "NEUROMODULADORES MANDIBULAR",          category: "Neuromoduladores",    document: { base: "CI TOXINA BOTULINICA",   expiryMonths: 12 } },
            // ============ Refractiva (sense document definit) ============
            { id: 2702548, name: "Láser FemtoLasik – por ojo",                     category: "Refractiva",  document: null },
            { id: 2702549, name: "Láser PRK – por ojo",                            category: "Refractiva",  document: null },
            { id: 2702550, name: "Lentes ICL esférica – por ojo",                  category: "Refractiva",  document: null },
            { id: 2702551, name: "Lentes ICL tórica – por ojo",                    category: "Refractiva",  document: null },

            // ============ Tratamientos Faciales ============
            { id: 2702611, name: "Reverso",                                        category: "Tratamientos Faciales", document: { base: "CI RADIOFRECUENCIA CON MICROAGUJAS", expiryMonths: 12 } },
            { id: 2702538, name: "Microneedling con exosomas vegetales",           category: "Tratamientos Faciales", document: { base: "CI MICRONEEDLING", expiryMonths: 12 } },
            { id: 2702539, name: "Peeling médico cara",                            category: "Tratamientos Faciales", document: { base: "PEELING",          expiryMonths: 12 } },
            { id: 2702537, name: "Microneedling cara y cuello",                    category: "Tratamientos Faciales", document: { base: "CI MICRONEEDLING", expiryMonths: 12 } },
            { id: 2702540, name: "Hydrafacial Signature",                          category: "Tratamientos Faciales", document: { base: "CI HYDRAFACIAL",   expiryMonths: 12 } },
            { id: 2702541, name: "Hydrafacial Deluxe",                             category: "Tratamientos Faciales", document: { base: "CI HYDRAFACIAL",   expiryMonths: 12 } },

            // ============ Ultrasonidos HIFU ============
            { id: 2702534, name: "Ultraformer MPT - Cara",                         category: "Tratamientos Faciales", document: { base: "CI ULTRAFORMER",   expiryMonths: 12 } },
            { id: 2702535, name: "Ultraformer MPT - Cuello / Papada",              category: "Tratamientos Faciales", document: { base: "CI ULTRAFORMER",   expiryMonths: 12 } },
            { id: 2702536, name: "Ultraformer MPT - Cara y cuello completo",       category: "Tratamientos Faciales", document: { base: "CI ULTRAFORMER",   expiryMonths: 12 } },

            // ============ Packages (3 sesiones ...) ============
            // NOTA: A Pabau, els productes "3 sesiones ..." són PACKAGES
            // (item_category="packages"), NO serveis. Tenen product_id propis
            // en el rang 4480xxx, NO els IDs dels serveis que empaqueten.
            // S'han definit aquí amb els IDs reals dels packages per garantir
            // que el lookup per ID funcioni correctament.
            //
            // El category és "Packages" per coincidir amb el JSON de Pabau.
            { id: 4480062, name: "3 sesiones EXOSOMAS AUTÓLOGOS",        category: "Packages", document: { base: "CONSENTIMIENTO EXOSOMAS AUTOLOGOS", expiryMonths: 12 } },
            { id: 4480061, name: "3 sesiones Polinucleotidos",           category: "Packages", document: { base: "CI POLINUCLEOTIDOS UNIVERSAL", expiryMonths: 12 } },
            { id: 4480057, name: "3 sesiones IPL",                       category: "Packages", documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 4480058, name: "3 sesiones ResurFX",                   category: "Packages", documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 4480056, name: "3 SESIONES PICO",                      category: "Packages", documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 4480059, name: "3 Sesiones PRGF + Vitaminas",          category: "Packages", document: { base: "CI PRGF ES 2026", expiryMonths: 12 } },
            { id: 4480064, name: "3 sesiones Microneedling con exosomas vegetales", category: "Packages", document: { base: "CI MICRONEEDLING", expiryMonths: 12 } },
            { id: 4480066, name: "Pack 5 sesiones Resurhair",            category: "Packages", documents: [{ base: "CI LASER", expiryMonths: 12 }, { base: "CI LASER PICO (EN)", expiryMonths: 12 }] },
            { id: 4480063, name: "3 Sesiones PRP + Vitaminas",           category: "Packages", document: { base: "CI PRP ES 2026",  expiryMonths: 12 } },
            { id: 4480067, name: "3 sesiones ULTRAFORMER MPT",           category: "Packages", document: { base: "CI ULTRAFORMER",  expiryMonths: 12 } },
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
         * Resol quin/quins documents + caducitat toca per un tractament.
         * Retorna un array de {documentName, expiryMonths, expiryDays} - el
         * caller ha de comprovar si el client té ALMENYS un d'aquests documents.
         * @param {{id?: number|string, name?: string}} key
         * @returns {Array<{documentName: string, expiryMonths: number, expiryDays: number}> | null}
         */
        function resolve(key) {
            const entry =
                (key.id != null && key.id !== "" && getById(key.id)) ||
                (key.name && getByName(key.name));
            if (!entry) return null;

            // Si té 'documents' (array), retornar tots com a opcions vàlides
            if (entry.documents) {
                return entry.documents.map((d) => ({
                    documentName: `${d.base}_FIRMADO.pdf`,
                    expiryMonths: d.expiryMonths ?? 0,
                    expiryDays: d.expiryDays ?? 0,
                }));
            }
            // Si té 'document' (single), retornar array d'un element
            if (entry.document) {
                return [{
                    documentName: `${entry.document.base}_FIRMADO.pdf`,
                    expiryMonths: entry.document.expiryMonths ?? 0,
                    expiryDays: entry.document.expiryDays ?? 0,
                }];
            }
            return null;
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
     * 1d. MÒDUL: debug
     * ----------------------------------------------------------------------
     * Panell flotant que mostra en directe el que l'script consulta a
     * l'API i com processa els resultats. Molt útil per depurar perquè
     * els packages no es detecten correctament.
     *
     * Característiques:
     *   - Es pot moure arrossegant la capçalera.
     *   - Botons per netejar el log i per tancar el panell.
     *   - Cada línia mostra una etiqueta + dades (objecte, array o text).
     *   - També escriu a la consola del navegador (F12).
     * ======================================================================= */
    const debug = (() => {
        // Inicialitzem l'estat des de GM_getValue amb fallback al default.
        // D'aquesta manera, l'estat es recorda entre sessions i cada
        // usuari pot activar/desactivar el debug segons les seves necessitats.
        let enabled = false;
        try {
            enabled = !!GM_getValue(CONFIG.DEBUG_STORAGE_KEY, CONFIG.DEBUG_DEFAULT);
        } catch (e) {
            enabled = !!CONFIG.DEBUG_DEFAULT;
        }

        let panel = null;
        let content = null;

        function createPanel() {
            if (panel && document.body.contains(panel)) return panel;
            if (panel && !document.body.contains(panel)) {
                // El panell ha estat eliminat del DOM. El tornem a crear.
                panel = null;
                content = null;
            }

            panel = document.createElement("div");
            panel.id = "pabau-debug-panel";
            Object.assign(panel.style, {
                position: "fixed",
                bottom: "10px",
                right: "10px",
                width: "720px",
                maxHeight: "520px",
                backgroundColor: "#1e1e1e",
                color: "#d4d4d4",
                border: "2px solid #007acc",
                borderRadius: "6px",
                fontFamily: "Menlo, Consolas, monospace",
                fontSize: "11px",
                zIndex: "2147483647",
                overflow: "hidden",
                boxShadow: "0 4px 20px rgba(0,0,0,0.7)",
                display: "none", // ocult per defecte; es mostra quan s'activa
                flexDirection: "column",
            });

            const header = document.createElement("div");
            Object.assign(header.style, {
                backgroundColor: "#007acc",
                padding: "8px 12px",
                color: "#fff",
                fontWeight: "bold",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "move",
                userSelect: "none",
            });

            const title = document.createElement("span");
            title.textContent = "🔍 Pabau LOPD Debug";
            header.appendChild(title);

            const buttons = document.createElement("div");
            buttons.style.display = "flex";
            buttons.style.alignItems = "center";
            buttons.style.gap = "12px";

            const clearBtn = document.createElement("span");
            clearBtn.textContent = "🗑️";
            clearBtn.title = "Netejar";
            clearBtn.style.cursor = "pointer";
            clearBtn.onclick = (e) => {
                e.stopPropagation();
                clear();
            };
            buttons.appendChild(clearBtn);

            const closeBtn = document.createElement("span");
            closeBtn.textContent = "✕";
            closeBtn.title = "Tancar (Ctrl+Shift+D per tornar a obrir)";
            closeBtn.style.cursor = "pointer";
            closeBtn.onclick = (e) => {
                e.stopPropagation();
                // Tancar ≠ desactivar. Simplement ocultem el panell però
                // els logs continuen acumulant-se. Per desactivar del tot,
                // cal fer servir el menú de Tampermonkey o Ctrl+Shift+D.
                hide();
            };
            buttons.appendChild(closeBtn);

            header.appendChild(buttons);
            panel.appendChild(header);

            content = document.createElement("div");
            Object.assign(content.style, {
                padding: "10px",
                overflow: "auto",
                flex: "1",
            });
            panel.appendChild(content);

            document.body.appendChild(panel);

            // Drag funcionality
            let isDragging = false;
            let dragOffset = { x: 0, y: 0 };
            header.addEventListener("mousedown", (e) => {
                if (e.target.tagName === "SPAN") return;
                isDragging = true;
                const rect = panel.getBoundingClientRect();
                dragOffset.x = e.clientX - rect.left;
                dragOffset.y = e.clientY - rect.top;
            });
            document.addEventListener("mousemove", (e) => {
                if (!isDragging) return;
                panel.style.left = (e.clientX - dragOffset.x) + "px";
                panel.style.top = (e.clientY - dragOffset.y) + "px";
                panel.style.right = "auto";
                panel.style.bottom = "auto";
            });
            document.addEventListener("mouseup", () => {
                isDragging = false;
            });

            return panel;
        }

        function addLog(label, data) {
            // Si el debug està desactivat, no fem absolutament res.
            // Així zero overhead en producció.
            if (!enabled) return;

            createPanel();

            // Si està activat però el panell està tancat, el mostrem.
            // Així l'usuari veu immediatament el que està passant.
            if (panel && panel.style.display === "none") {
                panel.style.display = "flex";
            }

            const line = document.createElement("div");
            line.style.marginBottom = "8px";
            line.style.paddingBottom = "8px";
            line.style.borderBottom = "1px solid #333";

            const labelEl = document.createElement("div");
            labelEl.style.color = "#569cd6";
            labelEl.style.fontWeight = "bold";
            labelEl.style.marginBottom = "4px";
            labelEl.textContent = `▸ ${label}`;
            line.appendChild(labelEl);

            if (data !== undefined && data !== null) {
                const dataEl = document.createElement("div");
                dataEl.style.color = "#ce9178";
                dataEl.style.whiteSpace = "pre-wrap";
                dataEl.style.wordBreak = "break-word";
                dataEl.style.maxHeight = "300px";
                dataEl.style.overflow = "auto";
                dataEl.textContent = typeof data === "string"
                    ? data
                    : JSON.stringify(data, null, 2);
                line.appendChild(dataEl);
            }

            content.appendChild(line);
            content.scrollTop = content.scrollHeight;

            // També escriu a la consola del navegador (F12)
            if (data !== undefined && data !== null) {
                console.log(`[Pabau Debug] ${label}:`, data);
            } else {
                console.log(`[Pabau Debug] ${label}`);
            }
        }

        function clear() {
            if (content) content.innerHTML = "";
            if (enabled) console.log("[Pabau Debug] Log netejat");
        }

        function show() {
            createPanel();
            panel.style.display = "flex";
        }

        function hide() {
            if (panel) panel.style.display = "none";
        }

        /** Retorna l'estat actual del debug (true = actiu). */
        function isEnabled() {
            return enabled;
        }

        /**
         * Activa o desactiva el mode debug. L'estat es desa entre sessions
         * amb GM_setValue per no haver-lo de canviar manualment cada cop.
         * @param {boolean} value
         */
        function setEnabled(value) {
            enabled = !!value;
            try {
                GM_setValue(CONFIG.DEBUG_STORAGE_KEY, enabled);
            } catch (e) {
                // Si GM_setValue falla (p.ex. sandbox), ignorem.
                // L'estat només serà vàlid durant aquesta sessió.
            }
            console.log(
                `[Pabau LOPD] Debug mode ${enabled ? "🟢 ACTIVAT" : "🔴 DESACTIVAT"}`,
            );
            if (enabled) {
                createPanel();
                panel.style.display = "flex";
                addLog("🔧 Debug mode activat", {
                    timestamp: new Date().toISOString(),
                    url: location.href,
                });
            } else {
                if (panel) panel.style.display = "none";
            }
        }

        /** Inverteix l'estat actual. */
        function toggle() {
            setEnabled(!enabled);
        }

        /**
         * Registra el shortcut de teclat (per defecte Ctrl+Shift+D).
         * Si el panell ja estava creat (per un altre motiu), el mostrem/amaguem.
         * Si no, simplement fem toggle.
         */
        function installShortcut() {
            const sc = CONFIG.DEBUG_SHORTCUT || {};
            document.addEventListener("keydown", (e) => {
                if (sc.ctrl && !e.ctrlKey) return;
                if (sc.shift && !e.shiftKey) return;
                if (sc.alt && !e.altKey) return;
                if (sc.key && e.key.toUpperCase() !== sc.key.toUpperCase()) return;

                e.preventDefault();
                e.stopPropagation();

                // Si el panell existeix i està ocult, primer el mostrem
                // sense canviar l'estat de "enabled". Si ja està activat
                // i el panell és visible, el desactivem.
                if (enabled && panel && panel.style.display === "flex") {
                    hide();
                } else if (enabled) {
                    show();
                } else {
                    toggle();
                }
            }, true);
        }

        // Registrem el shortcut immediatament (no cal esperar bootstrap)
        installShortcut();

        // Si per defecte està activat, mostrar el panell automàticament
        if (enabled) {
            // Esperem que el body existeixi
            if (document.body) {
                createPanel();
                panel.style.display = "flex";
            } else {
                document.addEventListener("DOMContentLoaded", () => {
                    createPanel();
                    panel.style.display = "flex";
                });
            }
        }

        return { addLog, clear, show, hide, isEnabled, setEnabled, toggle };
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
            console.log("[Pabau LOPD] URL:", oldHref, "→", newHref);
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
     * Emmagatzema la clau d'API amb TM_setValue (xifrada per Tampermonkey).
     * Si no n'hi ha, la demana amb prompt(); ofereix un menú per canviar-la.
     * ======================================================================= */

    const apiKey = (() => {
        function get() {
            let key = GM_getValue(CONFIG.STORAGE_KEY, "");
            if (!key) {
                key = prompt(
                    "Introdueix la teva API key de Pabau (es desarà xifrada):",
                );
                if (key) GM_setValue(CONFIG.STORAGE_KEY, key.trim());
            }
            return key;
        }

        function clear() {
            GM_setValue(CONFIG.STORAGE_KEY, "");
        }

        function registerMenu() {
            GM_registerMenuCommand("🔑 Modificar API key", () => {
                // ⚠️ Per seguretat NO mostrem l'API key actual.
                // L'usuari ha de tornar-la a teclejar sencera.
                const next = prompt(
                    "Nova API key (es deixa buit per seguretat — cal tornar-la a escriure):",
                    "",
                );
                if (next && next.trim()) {
                    GM_setValue(CONFIG.STORAGE_KEY, next.trim());
                    alert("API key actualitzada. Recarrega la pàgina.");
                }
            });

            // Menú per activar/desactivar el mode debug.
            // El text del menú canvia segons l'estat actual perquè
            // l'usuari sàpiga què passarà quan hi cliqui.
            GM_registerMenuCommand(
                `🔍 Debug: ${debug.isEnabled() ? "ON" : "OFF"} (canviar)`,
                () => debug.toggle(),
            );

            // Menú per mostrar el panell sense activar el debug.
            // Útil per consultar logs antics que ja s'havien desat.
            GM_registerMenuCommand("🔍 Mostrar panell debug", () => {
                debug.show();
            });
        }

        return { get, clear, registerMenu };
    })();

    /* =========================================================================
     * 5. MÒDUL: documentsApi
     * ----------------------------------------------------------------------
     * Encapsula la consulta a l'API de Pabau per saber si el client té
     * LOPD_FIRMADO.pdf. Necessita `GM_xmlhttpRequest` per saltar CORS.
     * ======================================================================= */

    const documentsApi = (() => {
        /**
         * Cerca un document pel títol exacte dins els documents del client.
         * Retorna TOTS els resultats (ordenats DESC per l'API) perquè el
         * caller pugui decidir quin fer servir (p. ex. el més recent).
         * @returns {Promise<{found: boolean, documents: Array, document: object|null}>}
         */
        function findDocument({ apiKey: key, clientId, documentName }) {
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

            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "GET",
                    url,
                    headers: { Accept: "application/json" },
                    onload: (res) => {
                        if (res.status === 200) {
                            try {
                                const data = JSON.parse(res.responseText);
                                const list =
                                    data.documents ||
                                    data.results ||
                                    data.data ||
                                    [];
                                const target = documentName.toLowerCase();
                                // Acceptem coincidència contra:
                                //   - El nom ORIGINAL amb accents (si un
                                //     dia Pabau corregeix la sanitització).
                                //   - El nom MANGLED que Pabau ha desat.
                                //   - La variant MANGLED sense "?" (per si
                                //     algun cop es queda sense "?" però
                                //     encara sense accents).
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
                                resolve({
                                    found: matches.length > 0,
                                    documents: matches,
                                    document: matches[0] || null,
                                });
                            } catch (e) {
                                reject(new Error("Resposta JSON no vàlida"));
                            }
                        } else if (res.status === 401 || res.status === 403) {
                            apiKey.clear();
                            reject(
                                new Error("API key invàlida — s'ha esborrat"),
                            );
                        } else {
                            reject(
                                new Error(
                                    `HTTP ${res.status}: ${res.statusText}`,
                                ),
                            );
                        }
                    },
                    onerror: () => reject(new Error("Error de xarxa")),
                });
            });
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
        /**
         * @returns {Promise<{found: boolean, items: Array, raw: object|null}>}
         */
        function getByInvoiceNo({ apiKey: key, invoiceNo }) {
            const url =
                `${CONFIG.API_BASE}/${encodeURIComponent(key)}` +
                `/invoices?inv_no=${encodeURIComponent(invoiceNo)}`;

            debug.addLog(`📡 GET /invoices?inv_no=${invoiceNo}`, { url });

            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "GET",
                    url,
                    headers: { Accept: "application/json" },
                    onload: (res) => {
                        debug.addLog(`📥 Resposta HTTP ${res.status}`, {
                            status: res.status,
                            responseLength: res.responseText?.length || 0,
                        });
                        if (res.status === 200) {
                            try {
                                const data = JSON.parse(res.responseText);
                                const list = data.invoices || [];
                                debug.addLog(`📦 Factures trobades: ${list.length}`, {
                                    invoiceCount: list.length,
                                });
                                if (list.length === 0) {
                                    resolve({ found: false, items: [], raw: data });
                                    return;
                                }
                                const inv = list[0];
                                // Mostrem info bàsica de la factura
                                debug.addLog(`🧾 Factura ${inv.details?.invoice_no || invoiceNo}`, {
                                    id: inv.details?.id,
                                    invoice_no: inv.details?.invoice_no,
                                    invoice_type: inv.details?.invoice_type,
                                    status: inv.details?.status,
                                    issued_to: inv.details?.issued_to,
                                    inv_total: inv.details?.inv_total,
                                    itemCount: Array.isArray(inv.items) ? inv.items.length : 0,
                                });
                                const rawItems = Array.isArray(inv.items) ? inv.items : [];
                                const items = rawItems.map((it) => {
                                    // Primer busquem per ID, després per nom (amb fallback)
                                    const byId = treatmentsConfig.getById(it.product_id);
                                    const byName = byId ? null : treatmentsConfig.getByName(it.item_name);
                                    const tx = byId || byName;
                                    const docsForItem =
                                        tx ? (tx.documents || (tx.document ? [tx.document] : null)) : null;
                                    return {
                                        product_id: it.product_id,
                                        item_name: it.item_name,
                                        item_category: it.item_category,
                                        category: it.category,
                                        group: it.group,
                                        resolved_by: byId ? "id" : (byName ? "name" : "none"),
                                        resolved_id: tx ? tx.id : null,
                                        // Pot tenir 'documents' (array) o 'document' (single) o null
                                        documents: docsForItem,
                                    };
                                });
                                // Mostrem taula amb cada item + quin document s'ha resolt
                                const itemsSummary = items.map((it) => ({
                                    product_id: it.product_id,
                                    item_name: it.item_name,
                                    item_category: it.item_category,
                                    resolved_by: it.resolved_by,
                                    resolved_id: it.resolved_id,
                                    documents: it.documents ? it.documents.map((d) => d.base) : null,
                                }));
                                debug.addLog(`📋 Items processats (${items.length})`, itemsSummary);
                                // Extreiem el clientId de la resposta de l'API.
                                //
                                // ATENCIÓ: `details.issued_to` NO és l'ID del client
                                // sinó el seu NOM (p. ex. "Prueba Koretic"). El
                                // camp correcte és `client[0].contact_id`, que
                                // conté l'ID numèric que ens cal per consultar
                                // els documents del client.
                                //
                                // Aquesta és l'ÚNICA font fiable del clientId:
                                // ens permet validar factures obertes des de
                                // qualsevol context (/clients/{id}/financial,
                                // /calendar obrint un modal, deep-links, etc.)
                                // sense dependre de la URL.
                                const clientArray = Array.isArray(inv.client)
                                    ? inv.client
                                    : [];
                                const firstClient = clientArray[0] || null;
                                const clientId = firstClient?.contact_id
                                    ? String(firstClient.contact_id)
                                    : null;
                                debug.addLog(`👤 clientId resolt de la factura`, {
                                    clientId,
                                    source: firstClient
                                        ? `client[0].contact_id (${firstClient.client_name})`
                                        : "cap client trobat",
                                });
                                resolve({ found: true, items, raw: inv, clientId });
                            } catch (e) {
                                debug.addLog(`❌ Error parsejant JSON /invoices`, { error: e.message });
                                reject(
                                    new Error(
                                        "Resposta /invoices no vàlida: " + e.message,
                                    ),
                                );
                            }
                        } else if (res.status === 401 || res.status === 403) {
                            apiKey.clear();
                            debug.addLog(`🔑 API key invàlida (HTTP ${res.status})`);
                            reject(new Error("API key invàlida — s'ha esborrat"));
                        } else {
                            debug.addLog(`❌ HTTP ${res.status} a /invoices`);
                            reject(
                                new Error(
                                    `HTTP ${res.status}: ${res.statusText}`,
                                ),
                            );
                        }
                    },
                    onerror: (err) => {
                        debug.addLog(`❌ Error de xarxa a /invoices`, { error: String(err) });
                        reject(new Error("Error de xarxa"));
                    },
                });
            });
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

        /**
         * Comprova si el document està caducat. Admet caducitat en mesos o
         * en dies; si no hi ha cap valor positiu configurat, no caduca.
         */
        function isExpired(dateStr, expiryMonths = 0, expiryDays = 0) {
            const months = Number(expiryMonths);
            const days = Number(expiryDays);
            const hasMonths = Number.isFinite(months) && months > 0;
            const hasDays = Number.isFinite(days) && days > 0;
            if (!hasMonths && !hasDays) return false;
            if (!dateStr) return true;

            // Format esperat: "2026-07-02 18:03:05" → cal substituir l'espai per "T"
            const uploadedAt = new Date(String(dateStr).replace(" ", "T"));
            if (Number.isNaN(uploadedAt.getTime())) return true;

            const expiryDates = [];
            if (hasMonths) {
                const expiryByMonths = new Date(uploadedAt);
                expiryByMonths.setMonth(expiryByMonths.getMonth() + months);
                expiryDates.push(expiryByMonths);
            }
            if (hasDays) {
                const expiryByDays = new Date(uploadedAt);
                expiryByDays.setDate(expiryByDays.getDate() + days);
                expiryDates.push(expiryByDays);
            }

            // Si accidentalment es configuren totes dues unitats, apliquem
            // la caducitat més restrictiva (la primera que venç).
            const expiresAt = Math.min(...expiryDates.map((d) => d.getTime()));
            return Date.now() > expiresAt;
        }

        /** Diferència en dies complets entre la data de pujada i ara. */
        function daysSince(dateStr) {
            if (!dateStr) return null;
            const d = new Date(String(dateStr).replace(" ", "T"));
            if (Number.isNaN(d.getTime())) return null;
            return Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60 * 1000));
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

        /** Constrou el llistat ÚNIC de papers: LOPD 1 cop + 1 per GRUP de
         *  documents de tractament. Cada entrada del llistat representa un
         *  SOL requisit: o bé un document concret (sense alternatives),
         *  o bé un grup d'alternatives (OR) del qual el client nomes en
         *  necessita tenir UN.
         *
         *  IMPORTANT: quan un tractament té multiples alternatives (OR),
         *  generem UNA SOLA entrada al llistat, NO una entrada per cada
         *  alternativa. Si no, el recompte d'issues s'inflaria i es
         *  mostraria "FALTAN 2 documentos" quan en realitat nomes en
         *  falta UN (perque el client nomes en necessita un dels dos).
         *
         *  Dedupliquem per GRUP (llista ordenada de bases), no per base
         *  individual. Aixi, dos tractaments que comparteixen exactament
         *  les mateixes alternatives (p. ex. tots els lasers que usen
         *  [CI LASER, CI LASER PICO]) col·lapsen en una sola entrada.
         */
        function buildRequiredFromItems(items) {
            // Map per deduplicar grups d'alternatives identics entre si.
            // Clau = llista ORDENADA de bases, per evitar falsos duplicats
            // quan l'ordre del array varia pero el contingut es el mateix.
            const groups = new Map();
            for (const it of items) {
                if (!it.documents || it.documents.length === 0) continue;
                const docs = it.documents;

                // Claus d'agrupacio: llista ordenada de bases amb "||".
                // D'aquesta manera:
                //   - [LASER, PICO] i [PICO, LASER]    → mateix grup
                //   - [LASER, PICO]  i  [LASER]        → grups diferents
                const sortedBases = docs.map((d) => d.base).slice().sort();
                const groupKey = sortedBases.join(" || ");

                // Document "principal" (per mostrar al tooltip): el primer
                // de la llista ORIGINAL. Si te alternatives, marquem el
                // grup amb `alternatives` perque la consulta API apliqui
                // la logica OR (consultar totes les opcions i acceptar
                // qualsevol que existeixi).
                // Nota: `expiryMonths` s'agafa del primer document. Si en
                // el futur les alternatives poden tenir caducitats
                // diferents, caldra revisar aquesta assignacio.
                const candidate = {
                    base: docs[0].base,
                    documentName: `${docs[0].base}_FIRMADO.pdf`,
                    expiryMonths: docs[0].expiryMonths ?? 0,
                    expiryDays: docs[0].expiryDays ?? 0,
                    alternatives:
                        docs.length > 1
                            ? docs.map((d) => `${d.base}_FIRMADO.pdf`)
                            : null,
                };

                // Si dos tractaments comparteixen el mateix document però
                // tenen caducitats diferents, conservem la més restrictiva.
                // La conversió a dies només serveix per comparar configuracions;
                // el càlcul real continua fent-se amb calendari a isExpired().
                const expiryRank = (entry) => {
                    const configured = [];
                    if (Number(entry.expiryDays) > 0) {
                        configured.push(Number(entry.expiryDays));
                    }
                    if (Number(entry.expiryMonths) > 0) {
                        configured.push(Number(entry.expiryMonths) * 30.4375);
                    }
                    return configured.length > 0 ? Math.min(...configured) : Infinity;
                };
                const current = groups.get(groupKey);
                if (!current || expiryRank(candidate) < expiryRank(current)) {
                    groups.set(groupKey, candidate);
                }
            }
            return [
                {
                    documentName: CONFIG.LOPD_DOCUMENT,
                    base: CONFIG.LOPD_DOCUMENT,
                    expiryMonths: 0,
                    expiryDays: 0,
                    kind: "lopd",
                },
                ...[...groups.values()].map((d) => ({
                    ...d,
                    kind: "treatment",
                })),
            ];
        }

        /**
         * Fa tota la validació d'una factura.
         *
         * IMPORTANT: A partir de la v1.0.5 el paràmetre `clientId` està
         * OBSOLET. La resposta de /invoices?inv_no=... SEMPRE inclou
         * `client[0].contact_id`, que és l'única font fiable del
         * clientId (el `details.issued_to` és el NOM, no pas l'ID).
         *
         * El paràmetre es manté a la signatura per compatibilitat amb
         * crides antigues, però S'IGNORA — s'usa sempre el valor
         * resolt per `invoiceApi`.
         *
         * @returns {Promise<{
         *   found: boolean,
         *   items: Array,
         *   required: Array,
         *   issues: Array<{kind: string, name: string, scope: string, createdAt: string|null, monthsOld: number|null}>,
         *   raw: object|null,
         *   clientId: string|null,
         * }>}
         */
        async function checkInvoice({ apiKey: key, clientId, invoiceNo }) {
            // `clientId` del paràmetre s'ignora: ve sempre de la resposta.
            void clientId;
            const { found, items, raw, clientId: resolvedClientId } = await invoiceApi.getByInvoiceNo({
                apiKey: key,
                invoiceNo,
            });
            if (!found) {
                debug.addLog(`⚠️ Factura ${invoiceNo} no trobada a l'API`);
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
                    clientId: resolvedClientId,
                };
            }

            // El clientId SEMPRE ve de la resposta (client[0].contact_id).
            // Si la factura no té cap client associat, no podem validar res.
            if (!resolvedClientId) {
                debug.addLog(
                    `⚠️ La factura ${invoiceNo} no té cap client associat (client[0].contact_id absent)`,
                );
                return {
                    found,
                    items,
                    required: [],
                    issues: [
                        {
                            kind: "missing",
                            name: `Client associat a la factura ${invoiceNo}`,
                            scope: "invoice",
                            createdAt: null,
                            monthsOld: null,
                        },
                    ],
                    raw,
                    clientId: null,
                };
            }

            const required = buildRequiredFromItems(items);
            // Mostrem quins documents s'han deduplicat
            debug.addLog(`📋 Documents requerits (després de dedup) (${required.length})`, required.map((r) => ({
                documentName: r.documentName,
                scope: r.kind,
                expiryMonths: r.expiryMonths,
                expiryDays: r.expiryDays,
                alternatives: r.alternatives,
            })));

            // Una sola crida per paper requerit, en paral·lel.
            // Per documents amb alternatives (OR), cal consultar TOTES les opcions
            // i només marcar como "no trobat" si cap d'elles existeix.
            const checks = await Promise.all(
                required.map(async (req) => {
                    // Obtenim la llista de documents a consultar:
                    // - Si té alternatives: totes elles
                    // - Si no: només el document principal
                    const docsToCheck = req.alternatives || [req.documentName];

                    // Consultem totes les alternatives en paral·lel
                    const results = await Promise.all(
                        docsToCheck.map(async (docName) => {
                            try {
                                    const r = await documentsApi.findDocument({
                                        apiKey: key,
                                        clientId: resolvedClientId,
                                        documentName: docName,
                                    });
                                const top = r.document || null;
                                const createdAt = top ? top.date || null : null;
                                const expired =
                                    !!top && isExpired(
                                        createdAt,
                                        req.expiryMonths,
                                        req.expiryDays,
                                    );
                                return {
                                    found: !!top,
                                    expired,
                                    createdAt,
                                    doc: top,
                                    docName,
                                };
                            } catch (err) {
                                console.error(
                                    `[Pabau LOPD] Error consultant ${docName}:`,
                                    err,
                                );
                                return {
                                    found: false,
                                    expired: false,
                                    createdAt: null,
                                    doc: null,
                                    docName,
                                    error: err,
                                };
                            }
                        }),
                    );

                    // Lògica OR: si ALMENYS una alternativa és vàlida, considerem el document OK
                    // Escollim la més recent (per mostrar info) i l'estat combinat
                    const validResults = results.filter((r) => r.found && !r.expired);
                    const anyFound = results.some((r) => r.found);
                    const anyExpired = results.some((r) => r.expired);

                    // Triem el document més recent per mostrar-lo (el primer de la llista és el DESC)
                    const bestMatch = validResults.length > 0 ? validResults[0] : results[0];

                    return {
                        req,
                        doc: bestMatch.doc,
                        found: anyFound,
                        expired: anyExpired && !anyFound ? false : anyExpired, // expirado solo si hay alguno expired Y ninguno valid
                        createdAt: bestMatch.createdAt,
                        // Per al tooltip:quins documents s'han consultat
                        checkedDocs: docsToCheck,
                    };
                }),
            );

            // Resum dels checks: per cada document requerit, si s'ha trobat
            const checksSummary = checks.map((c) => ({
                documentName: c.req.documentName,
                scope: c.req.kind,
                found: c.found,
                expired: c.expired,
                createdAt: c.createdAt,
                doc_title: c.doc?.photo_title || c.doc?.name || c.doc?.filename || c.doc?.title || null,
            }));
            debug.addLog(`🔍 Checks realitzats (${checks.length})`, checksSummary);

            const issues = checks
                .filter(({ found, expired }) => !found || expired)
                .map(({ req, found, expired, createdAt, checkedDocs }) => ({
                    kind: !found ? "missing" : "expired",
                    name: req.documentName,
                    // Si té alternatives, mostrem quines s'han consultat
                    alternatives: req.alternatives || null,
                    scope: req.kind, // "lopd" | "treatment"
                    createdAt,
                    expiryDays: req.expiryDays,
                    daysOld: daysSince(createdAt),
                    monthsOld: monthsSince(createdAt),
                }));

            debug.addLog(`⚠️ Issues trobats (${issues.length})`, issues);

            return { found: true, items, required, issues, raw };
        }

        return {
            checkInvoice,
            buildRequiredFromItems,
            isExpired,
            daysSince,
            monthsSince,
            formatDate,
        };
    })();

    /* =========================================================================
     * 5d. MÒDUL: modalInvoiceExtractor
     * ----------------------------------------------------------------------
     * Helpers per gestionar factures que s'obren DINS d'un modal
     * (p. ex. quan es fa clic sobre un event amb factura al calendari
     * de Pabau: URL = /calendar, però el panell de pagaments apareix
     * dins d'un dialog). En aquest context:
     *   - La URL NO conté /clients/{id}/..., per la qual cosa el
     *     pathname no ens serveix per obtenir el clientId.
     *   - L'element `#invoice` TAMPOC està present (és propi de la
     *     pàgina /clients/{id}/financial, no del modal del calendari).
     *
     * Aquest mòdul exposa dues funcions:
     *   - isInsideEditInvoiceModal() : retorna l'element del modal si
     *     n'hi ha algun obert (classe EditInvoice_editInvoiceModal).
     *   - extractInvoiceNoFromModal(modal) : extreu el número de factura
     *     del DOM del modal (l'HTML renderitzat mostra "#17543" al
     *     costat de l'etiqueta "Factura").
     *
     * Amb aquestes dues dades, `invoiceGuard.processFromModal` pot
     * resoldre el clientId consultant l'API /invoices (que retorna
     * `details.issued_to`) i continuar la validació de documents
     * sense necessitat del path.
     * ======================================================================= */
    const modalInvoiceExtractor = (() => {
        /**
         * Retorna l'element del modal d'edició de factura si n'hi ha
         * algun de muntat al DOM, o `null` si no.
         *
         * Usem `[class*="EditInvoice_editInvoiceModal"]` perquè Pabau
         * aplica un hash BEM als noms de classe (`__BOVNL` al final,
         * que canvia entre desplegaments).
         */
        function isInsideEditInvoiceModal() {
            return document.querySelector(
                CONFIG.EDIT_INVOICE_MODAL_SELECTOR,
            );
        }

        /**
         * Extreu el número de factura del DOM del modal.
         *
         * Estructura esperada al modal renderitzat:
         *   <div class="textContent">
         *     <span class="textContentHeaderText">Factura</span>
         *     <span class="textContentInfoText">#17543</span>
         *   </div>
         *
         * Busquem l'span amb text "Factura" i agafem el següent germà.
         * Si no el trobem, retornem null i `processFromModal` ja
         * s'encarregarà de gestionar-ho (no fa res).
         *
         * @param {Element} modal - element arrel del modal (no cal que
         *   contingui directament la informació, fem servir querySelectorAll).
         * @returns {string|null} número de factura (p. ex. "17543") o null.
         */
        function extractInvoiceNoFromModal(modal) {
            if (!modal) return null;

            // 1) Cerca directa al modal: span amb classe textContentHeaderText
            //    i text exacte "Factura". El seu següent germà amb classe
            //    textContentInfoText hauria de contenir "#NNNNN".
            const headers = modal.querySelectorAll(
                ".textContentHeaderText, span[class*='textContentHeaderText']",
            );
            for (const h of headers) {
                if (h.textContent && h.textContent.trim() === "Factura") {
                    const sibling = h.nextElementSibling;
                    if (sibling) {
                        const txt = (sibling.textContent || "").trim();
                        const m = txt.match(/^#?(\d{1,10})$/);
                        if (m) return m[1];
                    }
                }
            }

            // 2) Fallback: regex sobre el text complet del modal. Això és
            //    molt més permissiu i pot capturar el número encara que
            //    Pabau canviï l'estructura de classes en un futur.
            const text = modal.textContent || "";
            // Busquem patrons tipus "Factura\n#17543" o "Factura #17543".
            const m = text.match(/Factura\s*#?\s*(\d{1,10})/);
            if (m) return m[1];

            return null;
        }

        return { isInsideEditInvoiceModal, extractInvoiceNoFromModal };
    })();

    /* =========================================================================
     * 6. MÒDUL: buttonGuard
     * ----------------------------------------------------------------------
     * Fa la part visual: pintar el botó en vermell i deshabilitar-lo.
     * També ofereix la neteja (revertir a l'estat original) quan l'usuari
     * canvia de vista.
     * ======================================================================= */

    const buttonGuard = (() => {
        // ─── Flag anti-bucle ────────────────────────────────────────────
        // Totes les funcions d'aquest mòdul que MODIFIQUIN EL DOM
        // (canviar text, estils, disabled, etc.) activen aquest flag
        // abans i el desactiven amb un microtask al final. Així,
        // `ensureDom` (i qualsevol MutationObserver) pot saber que els
        // canvis que veu al DOM són "nostres" i NO han de disparar
        // una nova validació de l'API.
        //
        // Si NO féssim això, el bucle seria infinit:
        //   process() → _runValidation() → buttonGuard.block() (canvia DOM)
        //   → MutationObserver → ensureDom() → process() → ...
        let _acting = false;
        function isActing() {
            return _acting;
        }
        function beginMutation() {
            _acting = true;
        }
        function endMutation() {
            // setTimeout perquè el MutationObserver tingui temps de
            // veure els canvis ABANS de permetre una nova consulta.
            setTimeout(() => {
                _acting = false;
            }, 0);
        }
        // ─────────────────────────────────────────────────────────────────

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

            beginMutation();
            try {
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
            } finally {
                endMutation();
            }
            return true;
        }

        /** Reverteix l'estat d'un botó bloquejat per aquest script. */
        function unblockOne(btn) {
            if (!btn) return;

            beginMutation();
            try {
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
            } finally {
                endMutation();
            }
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
                // Bloquejem TOTS els botons, sense filtrar per inFooter.
                // Si el botó és dins del footer però encara no ha acabat
                // el render de React, el trobarem igual.
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

            // Idempotència
            if (
                btn.dataset.lopdBlocked === "true" &&
                btn.title === tt
            ) {
                return true;
            }

            // Capturem l'estat inicial
            if (btn.dataset.lopdWasDisabled == null) {
                btn.dataset.lopdWasDisabled = btn.disabled ? "true" : "false";
            }

            btn.disabled = true;
            btn.title = tt;
            btn.dataset.lopdBlocked = "true";
            btn.dataset.lopdTooltip = tt;
            btn.dataset.lopdKey = "payment";

            // Reforç: interceptar clics
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
                    true,
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
            // Si la validació ja ha acabat correctament abans que React
            // muntés els botons, cancel·lem l'observer preventiu. Si no,
            // podria trobar-los més tard i deixar-los bloquejats amb el text
            // "Revisando documentación..." sense cap nova validació.
            if (buttonObserver) {
                buttonObserver.disconnect();
                buttonObserver = null;
                buttonObserverTooltip = null;
            }

            const btns = document.querySelectorAll(
                `${CONFIG.PAYMENT_BUTTON_SELECTORS}[data-lopd-blocked="true"]`,
            );
            if (btns.length === 0) return;

            let restored = 0;
            let skipped = 0;
            for (const b of btns) {
                const wasOurs = b.dataset.lopdWasDisabled === "false";

                // Eliminem marcadors PRIMER, ABANS del disabled=false.
                // Així, si l'observer s'activa entre el delete i el disabled=false,
                // veurà que `data-lopd-blocked` ja NO hi és i NO bloc Gegem.
                delete b.dataset.lopdBlocked;
                delete b.dataset.lopdTooltip;
                delete b.dataset.lopdKey;
                b.title = "";

                if (!wasOurs) {
                    skipped += 1;
                    continue;
                }

                // Reactivem el botó que nosaltres vam bloquejar
                const beforeDisabled = b.disabled;
                b.disabled = false;
                
                restored += 1;
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
         *
         * IMPORTANT: Aquesta funció SIEMPRE bloquegem tots els botons que
         * troba al DOM, sense importar si ja tenen `data-lopd-blocked`.
         * Això garanteix que si Pabau React re-renderitza els botons
         * (per exemple en canviar d'estat intern), tornem a bloquejar-los.
         */
        function forceBlockAllPaymentButtons(tooltip) {
            const tt = tooltip || "Revisando documentación...";
            
            
            // Search for buttons globally - they might not exist yet in the DOM
            // when this is first called (React renders them asynchronously)
            const btns = document.querySelectorAll(CONFIG.PAYMENT_BUTTON_SELECTORS);
            
            
            // If no buttons found, set up a MutationObserver to wait for them
            if (btns.length === 0) {
                waitForPaymentButtons(tt);
                return;
            }
            
            // We have buttons, block them
            blockPaymentButtonsImmediate(btns, tt);
        }
        
        /**
         * Sets up a MutationObserver to wait for payment buttons to appear in the DOM.
         * This handles the case where React hasn't rendered the buttons yet.
         */
        let buttonObserver = null;
        let buttonObserverTooltip = null;
        
        function waitForPaymentButtons(tooltip) {
            // Cancel any existing observer
            if (buttonObserver) {
                buttonObserver.disconnect();
                buttonObserver = null;
            }
            
            buttonObserverTooltip = tooltip || "Revisando documentación...";
            
            buttonObserver = new MutationObserver((mutations, obs) => {
                const btns = document.querySelectorAll(CONFIG.PAYMENT_BUTTON_SELECTORS);
                
                if (btns.length > 0) {
                    // Found buttons! Block them and disconnect observer
                    blockPaymentButtonsImmediate(btns, buttonObserverTooltip);
                    obs.disconnect();
                    buttonObserver = null;
                }
            });
            
            // Observe the entire document for button mutations
            buttonObserver.observe(document.body, {
                childList: true,
                subtree: true
            });
            
        }
        
        /**
         * Blocks payment buttons immediately without idempotency check.
         * This is the core blocking logic.
         */
        function blockPaymentButtonsImmediate(btns, tt) {
            let touched = 0;
            for (const b of btns) {
                // Capturem l'estat inicial de `disabled` la PRIMERA vegada
                // que bloquegem (si `wasDisabled` encara no existeix).
                // Així quan fem unblock sabem si Pabau el tenía deshabilitat
                // abans del nostre bloqueig.
                if (b.dataset.lopdWasDisabled == null) {
                    b.dataset.lopdWasDisabled = b.disabled ? "true" : "false";
                }

                // SIEMPRE bloquejem: posem disabled=true i title
                // (no comprovem idempotència perquè volem forçar el bloqueig)
                b.disabled = true;
                b.title = tt;
                b.dataset.lopdBlocked = "true";
                b.dataset.lopdTooltip = tt;
                b.dataset.lopdKey = "payment";

                // Listener de seguretat (idempotent gràcies al dataset check)
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
        }

        function unblockAll() {
            // 1) Botó principal (text + estils vermells)
            const main = document.querySelector(
                `${CONFIG.BUTTON_SELECTOR}[data-lopd-blocked]`,
            );
            if (main) unblockOne(main);

            // 2) Botons de pagament
            unblockPaymentButtons();

            // 3) IMPORTANT: netejar TOTS els marcadors de lopd al DOM,
            //    no només als elements actualment bloquejats.
            //
            //    Incloem `data-lopd-checked` aquí perquè SINÓ el botó
            //    principal recorda que ja s'ha validat i `process()` no
            //    torna a consultar l'API quan l'usuari reentra al panell.
            document
                .querySelectorAll(
                    `${CONFIG.BUTTON_SELECTOR}[data-lopd-key], ` +
                    `${CONFIG.BUTTON_SELECTOR}[data-lopd-checked], ` +
                    `${CONFIG.BUTTON_SELECTOR}[data-lopd-label], ` +
                    `${CONFIG.BUTTON_SELECTOR}[data-lopd-tooltip], ` +
                    `${CONFIG.BUTTON_SELECTOR}[data-lopd-original-label]`,
                )
                .forEach((b) => {
                    delete b.dataset.lopdKey;
                    delete b.dataset.lopdChecked;
                    delete b.dataset.lopdLabel;
                    delete b.dataset.lopdTooltip;
                    delete b.dataset.lopdOriginalLabel;
                });
        }

        return {
            block,
            unblockOne,
            blockPaymentButtons,
            unblockPaymentButtons,
            forceBlockAllPaymentButtons,
            unblockAll,
            isActing, // ← exposat perquè invoiceGuard pugui evitar el bucle
        };
    })();

    /* =========================================================================
     * 7. MÒDUL: invoiceGuard
     * ----------------------------------------------------------------------
     * Orquestrador: per a cada vista de la SPA, decideix si cal bloquejar
     * el botó "Guardar cambios". Manté una memòria de factures ja
     * validades (Map indexat per `invoiceNo`) per no repetir crides a
     * l'API innecessàriament.
     *
     * IMPORTANT (v1.0.5+): ja NO s'obté el clientId del pathname de la
     * URL. Sempre es consulta /invoices?inv_no=... i s'extreu el
     * `client[0].contact_id`. Això unifica el comportament entre:
     *   - Pàgina /clients/{id}/financial (URL "normal")
     *   - Modal obert des de /calendar (URL = /calendar)
     *   - Deep-links o qualsevol altre context
     *
     * El `clientId` ja NO forma part del cacheKey (només `invoiceNo`)
     * perquè cada número de factura és únic a Pabau.
     * ======================================================================= */

    const invoiceGuard = (() => {
        // Resultat de l'última validació feta durant l'entrada ACTUAL al
        // panell de pagaments. La clau és invoiceNo i el valor conté el text
        // ja calculat. `label === null` significa que la documentació és OK.
        //
        // Això és més robust que un flag temporal després del click: React
        // pot continuar modificant el DOM bastants ms després, però aquestes
        // mutacions només reapliquen el resultat conegut i NO consulten l'API.
        const processedViews = new Map(); // invoiceNo -> { label, tooltip }
        let inFlight = null; // Promise de la validació en curs (per evitar duplicats)
        let tabObserver = null; // MutationObserver dedicat als panels rc-tabs
        let _processingKey = null; // clau de la factura que s'està processant
        let paymentTabWasActive = null; // evita processar dues vegades la mateixa transició

        // ─── Flag anti-revalidació per clicks ──────────────────────────
        // Quan l'usuari clica un botó de pagament, Pabau modifica el DOM
        // (canvia l'estat del botó a "Processing...", mostra diàlegs, etc.).
        // El MutationObserver global veu aquests canvis i dispararia
        // `process()` innecessàriament. Per evitar-ho, activem aquest
        // flag durant un microtask quan es detecta un click. `ensureDom`
        // el comprova i retorna immediatament si està actiu.
        let _actingOnUserAction = false;
        const PAYMENT_BTN_SELECTOR =
            CONFIG.PAYMENT_BUTTON_SELECTORS +
            ', button[data-testid="operation-create"]';
        // ─────────────────────────────────────────────────────────────────

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

        /** Neteja estats quan es canvia d'URL. */
        function handleNavigation() {
            buttonGuard.unblockAll();
            invoiceStore.reset();
            // Sempre buidem la memòria: cada nova URL és una nova oportunitat
            // per aplicar el bloqueig preventiu i validar l'API.
            processedViews.clear();
        }

        /**
         * S'ha canviat la pestanya activa. Si hem SORTIT del panel de
         * pagaments → desbloquegem TOT immediatament (botons de pagament
         * inclosos). Si hem ENTRAT al panel de pagaments → tornem a
         * validar SEMPRE per obtenir l'estat actualitzat dels documents
         * (Pabau pot haver afegit/actualitzat documents mentrestant).
         *
         * IMPORTANT: quan es canvia de tab, Pabau només canvia l'atribut
         * `aria-hidden` del panel — el botó "Guardar cambios" segueix
         * sent el MATEIX element DOM, per tant el MutationObserver NO es
         * torna a disparar. Per això forcem una nova validació aquí.
         */
        function handleTabChange() {
            const isActive = isPaymentTabActive();

            // L'observer pot rebre diverses mutacions per una sola acció.
            // Només ens interessa la transició real false -> true o
            // true -> false, no qualsevol canvi intern del panel.
            if (paymentTabWasActive === isActive) return;
            paymentTabWasActive = isActive;

            debug.addLog(
                `🔀 handleTabChange — isActive=${isActive}`,
                { url: location.href },
            );
            if (!isActive) {
                buttonGuard.unblockAll();
                invoiceStore.reset();
                processedViews.clear();
                // Netejem _processingKey per si n'hi havia una validació
                // en curs. Així, quan es torni a entrar al panell,
                // process() no quedarà bloquejada per la promesa antiga.
                _processingKey = null;
            } else {
                buttonGuard.forceBlockAllPaymentButtons(
                    "Revisando documentación...",
                );
                // Forcem una nova validació SEMPRE que l'usuari entra al
                // panell de pagaments. Sense això, si Pabau ha actualitzat
                // algun document mentre l'usuari estava en una altra tab,
                // no ens n'assabentaríem fins a la propera recàrrega.
                //
                // IMPORTANT: netejem _processingKey per si la promesa
                // anterior encara no ha acabat — aleshores _runValidation
                // detectaria `_processingKey === cacheKey` i retornaria
                // immediatament sense tornar a consultar l'API.
                _processingKey = null;
                // IMPORTANT: aquí `apiKey` (sense `.get()`) es refereix al
                // MÒDUL `apiKey` (l'objecte `{get, clear, registerMenu}`),
                // no pas a la CLAU de l'API (string). Si passéssim l'objecte,
                // `encodeURIComponent` el serialitzaria a "[object Object]" i
                // l'API retornaria 403. Per tant, cal cridar `apiKey.get()`
                // explícitament per obtenir la string.
                process({ apiKey: apiKey.get() });
            }
        }

        /** Format amigable d'un issue per al tooltip. */
        function fmtIssue(i) {
            const tag = i.scope === "lopd" ? "[LOPD] " : "[CI] ";
            const alternativesInfo = i.alternatives
                ? ` (valido: ${i.alternatives.join(" | ")})`
                : "";

            if (i.kind === "missing") {
                // No tenim cap registre d'aquest document al client.
                const tried = i.alternatives
                    ? ` · Opciones: ${i.alternatives.join(", ")}`
                    : "";
                return `${tag}${i.name} · No encontrado${tried}`;
            }

            // kind === "expired": el document existeix però ha caducat.
            const date = invoiceLookup.formatDate(i.createdAt);
            const when = date ? `subido el ${date}` : "fecha de subida desconocida";
            const age = i.expiryDays > 0 && i.daysOld != null
                ? ` (hace ${i.daysOld} ${i.daysOld === 1 ? "día" : "días"})`
                : (i.monthsOld != null ? ` (hace ${i.monthsOld} meses)` : "");
            return `${tag}${i.name} · Caducado · ${when}${age}${alternativesInfo}`;
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
         * Flux comú de validació per a TANT el flux "normal" com el del
         * modal del calendari. El clientId SEMPRE es resol internament
         * a la resposta de /invoices, independentment de l'origen.
         *
         * El `cacheKey` és simplement l'`invoiceNo` perquè cada número
         * de factura és únic a Pabau.
         */
        /** Aplica un resultat ja calculat sense tornar a consultar l'API. */
        function applyValidationState(btn, state) {
            if (!btn || !state) return;

            if (state.label) {
                buttonGuard.block(state.label, state.tooltip || "");
                buttonGuard.blockPaymentButtons(
                    state.tooltip ||
                    "No es pot cobrar fins que la documentació estigui al dia",
                );
                return;
            }

            // Documentació OK: només revertim elements que encara portin
            // marcadors nostres. No forcem `disabled=false` sobre botons que
            // Pabau hagi desactivat durant el processament del pagament.
            if (btn.dataset.lopdBlocked === "true") {
                buttonGuard.unblockOne(btn);
            }
            buttonGuard.unblockPaymentButtons();
        }

        async function _runValidation({ apiKey: key, invoiceNo, cacheKey }) {
            const btn = document.querySelector(CONFIG.BUTTON_SELECTOR);
            if (!btn) return;

            // Bloquegem preventivament mentre dure la consulta.
            buttonGuard.block(CONFIG.CONSULTING_LABEL, "");
            buttonGuard.blockPaymentButtons("Revisando documentación...");
            _processingKey = cacheKey;

            // Si ja hi ha una validació en curs per la mateixa clau,
            // esperem-la i reapliquem el resultat al botó actual.
            if (inFlight && inFlight.key === cacheKey) {
                const concurrentResult = await inFlight.promise;
                const state = {
                    label: buildLabel(concurrentResult),
                    tooltip: buildTooltip(concurrentResult),
                };
                processedViews.set(cacheKey, state);
                applyValidationState(btn, state);
                _processingKey = null;
                return;
            }

            // Llancem la validació. Noteu que NO passem clientId:
            // el mòdul `invoiceLookup.checkInvoice` l'extreurà de
            // `client[0].contact_id` a la resposta de /invoices.
            const p = (async () => {
                try {
                    return await invoiceLookup.checkInvoice({
                        apiKey: key,
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

            const state = {
                label: buildLabel(result),
                tooltip: buildTooltip(result),
            };
            processedViews.set(cacheKey, state);
            applyValidationState(btn, state);
            _processingKey = null;
        }

        /**
         * Resol el número de factura actiu i dispara la validació.
         * El clientId NO es passa — es resol a dins de `checkInvoice`.
         *
         * Prioritza el modal (si està obert) i, si no, llegeix l'`#invoice`
         * del `invoiceStore` (funciona tant a la pàgina /financial com
         * en qualsevol altre context on Pabau hagi muntat l'element).
         *
         * IMPORTANT: Aquesta funció SEMPRE dispara una nova validació
         * cada vegada que l'usuari entra al panell de pagaments. La
         * deduplicació de crides concurrents es fa amb `_processingKey`
         * (i `inFlight` dins de `_runValidation`).
         */
        async function process({ apiKey: key }) {
            if (!isPaymentTabActive()) return;

            const modal = modalInvoiceExtractor.isInsideEditInvoiceModal();
            let invoiceNo = null;

            if (modal) {
                // Modal obert des del calendari: extraiem l'invoiceNo del DOM.
                invoiceNo = modalInvoiceExtractor.extractInvoiceNoFromModal(modal);
            } else {
                // Flux "normal": llegim l'invoiceNo de #invoice.
                invoiceNo = invoiceStore.invoiceNo;
            }

            if (!invoiceNo) return;

            const btn = document.querySelector(CONFIG.BUTTON_SELECTOR);
            if (!btn) return;

            const cacheKey = String(invoiceNo);
            return _runValidation({ apiKey: key, invoiceNo, cacheKey });
        }

        /**
         * Instal·la el routerWatcher i el DOM observer.
         */
        function install({ apiKey: key }) {
            routerWatcher.subscribe(handleNavigation);

            // Reaccionar a qualsevol muntatge/desmuntatge del botó o del #invoice.
            const ensureDom = () => {
                // ─── Anti-bucle ────────────────────────────────────────────
                // Si buttonGuard està aplicant canvis al DOM (p. ex. canviant
                // el text del botó o aplicant estils), IGNOREM els canvis
                // del MutationObserver perquè sinó entraríem en un bucle
                // infinit: process() → _runValidation() → buttonGuard.block()
                // (canvia DOM) → MutationObserver → ensureDom() → process().
                //
                // El flag `isActing` es desactiva amb un setTimeout(0)
                // dins de `endMutation()` perquè el MutationObserver tingui
                // temps de veure els canvis ABANS de permetre'ns reaccionar.
                if (buttonGuard.isActing()) return;

                // ─── Anti-revalidació per clicks ─────────────────────────
                // Si l'usuari acaba de fer click en un botó de pagament,
                // Pabau ja està gestionant el seu propi flux (canvia l'estat
                // del botó, mostra diàlegs, etc.) i provoca múltiples
                // mutacions al DOM en pocs ms. Si deixem que el
                // MutationObserver les processi totes, dispararíem
                // `process()` innecessàriament N vegades seguides. El
                // listener de click a `install()` activa aquest flag
                // durant un microtask, i aquí el comprovem per descartar
                // aquestes mutacions "internes" de Pabau.
                if (_actingOnUserAction) return;

                const btn = document.querySelector(CONFIG.BUTTON_SELECTOR);
                if (!btn) return;

                // CAS 1: NO estem al panel de pagaments.
                // → Els botons tornen al seu color/estat originals de
                //   Pabau (no els hem tocat mai CSS) i netegem markers.
                if (!isPaymentTabActive()) {
                    buttonGuard.unblockPaymentButtons();
                    return;
                }

                // CAS 2: Panel actiu.
                // Avaluem el número de factura actiu (del modal si està
                // obert, o de #invoice si estem a /financial).
                const invoiceNo = (() => {
                    const modal = modalInvoiceExtractor.isInsideEditInvoiceModal();
                    if (modal) {
                        return modalInvoiceExtractor.extractInvoiceNoFromModal(modal);
                    }
                    return invoiceStore.invoiceNo;
                })();
                const cacheKey = invoiceNo != null ? String(invoiceNo) : null;

                // Encara no tenim prou informació per validar. No deixem
                // botons bloquejats preventivament sense una consulta que
                // els pugui desbloquejar després.
                if (!cacheKey) return;

                // Si ja hi ha una validació en curs per aquesta mateixa
                // factura, no en llancem cap altra. Aquesta comparació ha de
                // fer-se contra la variable local: `invoiceGuard` no exposa
                // `_processingKey` públicament.
                if (_processingKey === cacheKey) return;

                // Una mutació del DOM (incloses les provocades en clicar un
                // mètode de pagament) no invalida la documentació. Reapliquem
                // el resultat guardat als nodes que React pugui haver remuntat
                // i, sobretot, NO tornem a consultar l'API.
                const cachedState = processedViews.get(cacheKey);
                if (cachedState) {
                    applyValidationState(btn, cachedState);
                    return;
                }

                // Bloquem immediatament tots els botons de pagament
                // mentre dura la consulta (és la primera vegada o una
                // re-entrada al panell).
                buttonGuard.forceBlockAllPaymentButtons(
                    "Revisando documentación...",
                );
                buttonGuard.blockPaymentButtons("Revisando documentación...");

                // Cridem process() per fer la consulta API i desbloquejar
                // (o mantenir el bloqueig) segons el resultat. SEMPRE
                // es tornarà a consultar l'API cada vegada que l'usuari
                // entra al panell — l'estat no és estàtic.
                process({ apiKey: key });
            };

            if (document.readyState === "loading") {
                document.addEventListener("DOMContentLoaded", ensureDom);
            } else {
                ensureDom();
            }
            // MutationObserver que descarta els canvis al DOM que provenen
            // de les nostres pròpies modificacions (buttonGuard.block/unblock).
            // Si NO els descartem, el callback s'executaria DESPRÉS que
            // `_acting` es desactivi (via setTimeout(0)) i veuria `_acting = false`,
            // disparant un bucle infinit.
            const mo = new MutationObserver((mutations, obs) => {
                if (buttonGuard.isActing()) {
                    // Els canvis al DOM són nostres (de buttonGuard.block/unblock);
                    // els descartem perquè el callback de sota no els processi.
                    obs.takeRecords();
                    return;
                }
                ensureDom();
            });
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
                        // L'estat actiu es determina exclusivament amb
                        // aria-hidden. Observar `class` feia que canvis
                        // visuals interns poguessin revalidar la factura.
                        attributeFilter: ["aria-hidden"],
                    });
                }
            };
            subscribeTabPanels();
            paymentTabWasActive = isPaymentTabActive();

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

            // ─── Listener anti-revalidació per clicks ──────────────────
            // Quan l'usuari clica un botó de pagament (Credit, Cash,
            // Card, etc.) o el botó "Guardar cambios", Pabau modifica
            // el DOM per gestionar la seva acció (canviar l'estat del
            // botó, mostrar un diàleg, fer una navegació, etc.). Aquests
            // canvis dispararien `process()` innecessàriament a través
            // del MutationObserver. Per evitar-ho, activem el flag
            // `_actingOnUserAction` durant un microtask quan es detecta
            // un click dins d'aquests botons. Així, `ensureDom` retornarà
            // immediatament sense validar.
            //
            // IMPORTANT: usem `closest()` perquè el click pot provenir
            // d'un element fill del botó (p. ex. una icona SVG).
            document.addEventListener(
                "click",
                (e) => {
                    const target = e.target;
                    if (!(target instanceof Element)) return;
                    if (!target.closest(PAYMENT_BTN_SELECTOR)) return;
                    _actingOnUserAction = true;
                    setTimeout(() => {
                        _actingOnUserAction = false;
                    }, 0);
                },
                true, // capture phase per agafar el click abans que Pabau
            );
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
        // El @match cobreix tota l'app Pabau. El bloqueig s'aplica a
        // qualsevol context on apareix el panell de pagaments
        // (/clients/{id}/financial, modal obert des del calendari, etc.).
        // El clientId es resol SEMPRE via API /invoices, no del path.
        // Per tant hem d'instal·lar sempre el routerWatcher i
        // l'invoiceGuard per reaccionar a la navegació SPA.

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
        console.log(
            `%c[Pabau LOPD] v${GM_info.script.version} · ${location.pathname}`,
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
