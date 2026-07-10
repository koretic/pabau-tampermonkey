// ==UserScript==
// @name         Block invoice Pabau - LOPD check
// @namespace    http://tampermonkey.net/
// @version      2026-07-09
// @description  Comprova si el client té LOPD_FIRMADO.pdf i bloqueja el botó
// @author       Alex Rodriguez
// @match        https://app.pabau.com/*
// @match        https://app.pabau.com/clients/*/financial*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=pabau.com
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.oauth.pabau.com
// @run-at       document-end
// @sandbox JavaScript
// ==/UserScript==

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
     * 1. CONSTANTS I SELECTORS
     * ======================================================================= */
    const CONFIG = Object.freeze({
        STORAGE_KEY: "pabau_api_key",
        API_BASE: "https://api.oauth.pabau.com",
        REQUIRED_DOC: "LOPD_FIRMADO.pdf",
        INVOICE_SELECTOR: "#invoice",
        BUTTON_SELECTOR: 'button[data-testid="operation-create"]',
        BLOCKED_LABEL: "Falta la documentación firmada",
    });

    /* =========================================================================
     * 2. MÒDUL: invoiceStore
     * ----------------------------------------------------------------------
     * Llegeix `#invoice` quan apareix al DOM i manté el seu valor a la
     * variable `current`. Com que la SPA el munta/desmunta en cada
     * vista, fem servir `requestAnimationFrame` en bucle (en lloc d'un
     * `setTimeout` finit) i cancel·lem la cerca quan arriba una nova.
     * ======================================================================= */

    const invoiceStore = (() => {
        let current = null;
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
            current = null;
            start();
        }

        function tick(myId) {
            if (myId !== watchId) return; // algú ha cancel·lat aquesta cerca
            const el = document.querySelector(CONFIG.INVOICE_SELECTOR);
            if (el) {
                current = el.value;
                console.log("[Pabau LOPD] Invoice obtinguda:", current);
                return;
            }
            // Tornem-ho a provar al pròxim frame; es cancel·la amb start().
            requestAnimationFrame(() => tick(myId));
        }

        return {
            start,
            reset,
            get value() {
                return current;
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
            GM_registerMenuCommand("🔑 Canviar API key de Pabau", () => {
                const current = GM_getValue(CONFIG.STORAGE_KEY, "");
                const next = prompt("Nova API key:", current);
                if (next && next !== current) {
                    GM_setValue(CONFIG.STORAGE_KEY, next.trim());
                    alert("API key actualitzada. Recarrega la pàgina.");
                }
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
         * @returns {Promise<boolean>} true si el client té el document.
         */
        function checkLopdDocument({ apiKey: key, clientId }) {
            const url =
                `${CONFIG.API_BASE}/${encodeURIComponent(key)}` +
                `/clients/${clientId}/documents` +
                `?order=DESC&per_page=20&page=1` +
                `&search=${encodeURIComponent(CONFIG.REQUIRED_DOC)}`;

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
                                    data.results ||
                                    data.data ||
                                    data.documents ||
                                    [];
                                resolve(Array.isArray(list) && list.length > 0);
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

        return { checkLopdDocument };
    })();

    /* =========================================================================
     * 6. MÒDUL: buttonGuard
     * ----------------------------------------------------------------------
     * Fa la part visual: pintar el botó en vermell i deshabilitar-lo.
     * També ofereix la neteja (revertir a l'estat original) quan l'usuari
     * canvia de vista.
     * ======================================================================= */

    const buttonGuard = (() => {
        function block() {
            // Només actuem en pantalles amb #invoice (edició de factura).
            if (!document.querySelector(CONFIG.INVOICE_SELECTOR)) return;

            const btn = document.querySelector(CONFIG.BUTTON_SELECTOR);
            if (!btn || btn.dataset.lopdBlocked === "true") return;

            const label = btn.querySelector("p") || btn;
            label.textContent = CONFIG.BLOCKED_LABEL;

            Object.assign(btn.style, {
                backgroundColor: "#dc3545",
                borderColor: "#dc3545",
                color: "#ffffff",
                opacity: "0.85",
                cursor: "not-allowed",
            });

            btn.disabled = true;
            btn.dataset.lopdBlocked = "true";
            console.log("[Pabau LOPD] Botó bloquejat:", btn);
        }

        function unblockAll() {
            document
                .querySelectorAll(
                    `${CONFIG.BUTTON_SELECTOR}[data-lopd-blocked]`,
                )
                .forEach((b) => {
                    delete b.dataset.lopdBlocked;
                    delete b.dataset.lopdChecked;
                    delete b.dataset.lopdKey;
                    b.disabled = false;
                    b.style.cssText = "";
                });
        }

        return { block, unblockAll };
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
        const processedViews = new Set();
        const buttonObservers = new WeakMap(); // btn -> MutationObserver

        function viewKey(clientId) {
            return `${clientId}|${location.pathname}${location.search}`;
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

        /** Crida única a l'API per vista; emmagatzema el resultat. */
        async function fetchAndRemember({ apiKey: key, clientId, key: viewK }) {
            const hasDoc = await documentsApi.checkLopdDocument({
                apiKey: key,
                clientId,
            });
            console.log(
                `[Pabau LOPD] Client ${clientId} té ${CONFIG.REQUIRED_DOC}?`,
                hasDoc,
            );
            processedViews.add(viewK);
            return hasDoc;
        }

        /** Punt d'entrada del DOM observer; idempotent. */
        async function process({ apiKey: key, clientId }) {
            const btn = document.querySelector(CONFIG.BUTTON_SELECTOR);
            if (!btn) return;

            const keyV = viewKey(clientId);

            // Mateixa instància de botó i mateixa vista → res a fer.
            if (btn.dataset.lopdKey === keyV) return;

            // Si ja hem fet la consulta per aquesta vista, només
            // assegurem que el botó reflecteix el bloqueig.
            if (processedViews.has(keyV)) {
                btn.dataset.lopdChecked = "true";
                btn.dataset.lopdKey = keyV;
                buttonGuard.block();
                return;
            }

            btn.dataset.lopdChecked = "true";
            btn.dataset.lopdKey = keyV;

            try {
                const hasDoc = await fetchAndRemember({
                    apiKey: key,
                    clientId,
                    key: keyV,
                });
                if (!hasDoc) {
                    buttonGuard.block();
                    // Si React remunta el botó, reapliquem el bloqueig.
                    if (!buttonObservers.has(btn)) {
                        const mo = new MutationObserver(() => {
                            const fresh = document.querySelector(
                                CONFIG.BUTTON_SELECTOR,
                            );
                            if (
                                fresh &&
                                fresh.dataset.lopdChecked !== "blocked"
                            ) {
                                buttonGuard.block();
                                fresh.dataset.lopdChecked = "blocked";
                            }
                        });
                        mo.observe(document.body, {
                            childList: true,
                            subtree: true,
                        });
                        buttonObservers.set(btn, mo);
                    }
                }
            } catch (err) {
                console.error("[Pabau LOPD]", err);
            }
        }

        /**
         * Instal·la el routerWatcher i el DOM observer; retorna una
         * funció `run(view)` que l'orquestrador pot cridar.
         */
        function install({ apiKey: key }) {
            routerWatcher.subscribe(handleNavigation);

            // Reaccionar a qualsevol muntatge/desmuntatge del botó.
            const ensureDom = () => {
                const clientId = clientIdFromPath(location.pathname);
                if (!clientId) return;
                process({ apiKey: key, clientId });
            };

            if (document.readyState === "loading") {
                document.addEventListener("DOMContentLoaded", ensureDom);
            } else {
                ensureDom();
            }
            const mo = new MutationObserver(ensureDom);
            mo.observe(document.body, { childList: true, subtree: true });
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
        // Log de diagnòstic: si NO veus això a la consola, l'script no s'injecta
        console.log(
            "%c[Pabau LOPD] Bootstrap iniciat a " + location.href,
            "background:#28a745;color:#fff;padding:2px 6px;border-radius:3px;",
        );

        const url = new URL(window.location.href);
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
        console.log(
            `[Pabau LOPD] Bootstrap complet${
                initialClientId ? ` per al client ${initialClientId[1]}` : ""
            } (referrer=${url.searchParams.get("referrer")})`,
        );
    }

    bootstrap();
})();
