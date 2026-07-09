// ==UserScript==
// @name         Block invoice Pabau - LOPD check
// @namespace    http://tampermonkey.net/
// @version      2026-07-07
// @description  Comprova si el client té LOPD_FIRMADO.pdf i bloqueja el botó "Guardar cambios" si no el té
// @author       Alex Rodriguez
// @match        https://app.pabau.com/clients/*/financial*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=pabau.com
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.oauth.pabau.com
// ==/UserScript==

(function () {
    "use strict";

    const STORAGE_KEY = "pabau_api_key";
    const API_BASE = "https://api.oauth.pabau.com";
    const REQUIRED_DOC = "LOPD_FIRMADO.pdf";
    const BUTTON_SELECTOR = 'button[data-testid="operation-create"]';

    // ---------------------------------------------------------------------
    // Gestió de navegació SPA
    // ---------------------------------------------------------------------
    // La SPA de Pabau NO recarrega la pàgina quan canvia de vista, per la
    // qual cosa el #invoice apareix i desapareix sense modificar la URL.
    // Detectem els canvis de ruta (pushState/replaceState + popstate) i
    // reintentem la cerca de l'element en cada vista.
    // ---------------------------------------------------------------------
    let value = null;
    let invoiceWatchId = 0;
    let lastHref = location.href;

    function watchInvoice(selector = "#invoice") {
        // Cancel·lem qualsevol cerca anterior
        invoiceWatchId += 1;
        const myId = invoiceWatchId;

        const tryRead = () => {
            if (myId !== invoiceWatchId) return; // algú altre ens ha cancel·lat
            const el = document.querySelector(selector);
            if (el) {
                value = el.value;
                console.log("[Pabau LOPD] Invoice obtinguda:", value);
            } else {
                // Tornem a provar en el pròxim tick del DOM
                requestAnimationFrame(tryRead);
            }
        };
        tryRead();
    }

    function onUrlChange() {
        if (location.href === lastHref) return;
        const oldHref = lastHref;
        lastHref = location.href;
        console.log("[Pabau LOPD] Canvi de URL:", oldHref, "→", location.href);
        // Reset del valor i nova cerca
        value = null;
        watchInvoice();
        // Netejem els estats dels botons de l'anterior vista
        document
            .querySelectorAll(`${BUTTON_SELECTOR}[data-lopd-blocked]`)
            .forEach((b) => {
                b.removeAttribute("data-lopd-blocked");
                b.removeAttribute("data-lopd-checked");
                b.removeAttribute("data-lopd-key");
                b.disabled = false;
                b.style.cssText = "";
            });
        // Si hem canviat de client, descartem la memòria de vistes ja processades
        const newClientMatch = location.pathname.match(/^\/clients\/(\d+)\//);
        const oldClientMatch = oldHref.match(/\/clients\/(\d+)\//);
        const newClient = newClientMatch ? newClientMatch[1] : null;
        const oldClient = oldClientMatch ? oldClientMatch[1] : null;
        if (newClient !== oldClient) processedKeys.clear();
    }

    // Hook sobre history.pushState / replaceState (la SPA els crida en navegar)
    ["pushState", "replaceState"].forEach((fn) => {
        const original = history[fn];
        history[fn] = function (...args) {
            const result = original.apply(this, args);
            onUrlChange();
            return result;
        };
    });
    window.addEventListener("popstate", onUrlChange);

    // Llancem la primera cerca quan el body existeixi
    if (document.body) {
        watchInvoice();
    } else {
        document.addEventListener("DOMContentLoaded", watchInvoice);
    }
    // 1) Verifiquem que la URL té el paràmetre `referrer` (per coincidir amb el patró original)
    const url = new URL(window.location.href);
    if (!url.searchParams.has("referrer")) {
        console.log("[Pabau LOPD] No hi ha referrer, sortint.");
        return;
    }

    // 2) Extraiem el clientId de la URL dinàmica
    const match = window.location.pathname.match(/^\/clients\/(\d+)\//);
    if (!match) {
        console.log("[Pabau LOPD] No s'ha pogut obtenir el clientId.");
        return;
    }
    const clientId = match[1];

    // 3) Recuperem o demanem la API key (desada encriptada per Tampermonkey)
    function getApiKey() {
        let key = GM_getValue(STORAGE_KEY, "");
        if (!key) {
            key = prompt(
                "Introdueix la teva API key de Pabau (es desarà xifrada):"
            );
            if (key) {
                GM_setValue(STORAGE_KEY, key.trim());
            }
        }
        return key;
    }

    // 4) Comanda al menú per canviar la clau sense editar el codi
    GM_registerMenuCommand("🔑 Canviar API key de Pabau", () => {
        const current = GM_getValue(STORAGE_KEY, "");
        const newKey = prompt("Nova API key:", current);
        if (newKey && newKey !== current) {
            GM_setValue(STORAGE_KEY, newKey.trim());
            alert("API key actualitzada. Recarrega la pàgina.");
        }
    });

    const apiKey = getApiKey();
    if (!apiKey) {
        console.error("[Pabau LOPD] No s'ha proporcionat API key.");
        return;
    }

    // 5) Consulta a l'API de Pabau (cal GM_xmlhttpRequest per saltar CORS)
    function checkLopdDocument() {
        const reqUrl =
            `${API_BASE}/${encodeURIComponent(apiKey)}` +
            `/clients/${clientId}/documents` +
            `?order=DESC&per_page=20&page=1&search=${encodeURIComponent(REQUIRED_DOC)}`;

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: reqUrl,
                headers: { Accept: "application/json" },
                onload: (res) => {
                    if (res.status === 200) {
                        try {
                            const data = JSON.parse(res.responseText);
                            // Adapta a l'estructura real de la resposta:
                            // pot ser `results`, `data`, `documents`...
                            const list =
                                data.results ||
                                data.data ||
                                data.documents ||
                                [];
                            const hasDoc = Array.isArray(list) && list.length > 0;
                            resolve(hasDoc);
                        } catch (e) {
                            reject(new Error("Resposta JSON no vàlida"));
                        }
                    } else if (res.status === 401 || res.status === 403) {
                        GM_setValue(STORAGE_KEY, "");
                        reject(new Error("API key invàlida — s'ha esborrat"));
                    } else {
                        reject(new Error(`HTTP ${res.status}: ${res.statusText}`));
                    }
                },
                onerror: (err) => reject(new Error("Error de xarxa")),
            });
        });
    }

    // 6) Modificar el botó quan falti el document
    function blockButton() {
        // Només bloquejar si estem en una vista amb #invoice (edició de factura)
        // Si l'element no existeix, no és la pantalla correcta — sortim.
        if (!document.querySelector("#invoice")) return;

        const btn = document.querySelector(BUTTON_SELECTOR);
        if (!btn) return;

        const label = btn.querySelector("p") || btn;
        label.textContent = "Falta la documentación firmada";

        Object.assign(btn.style, {
            backgroundColor: "#dc3545",
            borderColor: "#dc3545",
            color: "#ffffff",
            opacity: "0.85",
            cursor: "not-allowed",
        });

        btn.disabled = true;
        btn.setAttribute("data-lopd-blocked", "true");
    }

    // 7) L'SPA de Pabau carrega el botó dinàmicament — observem el DOM
    // L'estat `alreadyProcessed` ara es basa per clientId + URL, ja que
    // canviar de vista dins de la SPA requereix una nova comprovació.
    const processedKeys = new Set();

    function buildKey() {
        return `${clientId}|${location.pathname}${location.search}`;
    }

    async function processButton() {
        const btn = document.querySelector(BUTTON_SELECTOR);
        if (!btn) return;

        const key = buildKey();
        // Si ja hem processat exactament aquesta vista, sortim
        if (btn.dataset.lopdKey === key) return;
        // Si ja hem fet la crida API per aquesta vista, no la repetim
        if (processedKeys.has(key)) {
            // Però encara podem haver de bloquejar el botó (vista acabada de muntar)
            if (!btn.dataset.lopdChecked) {
                btn.dataset.lopdChecked = "true";
                blockButton();
                btn.dataset.lopdKey = key;
            }
            return;
        }

        btn.dataset.lopdChecked = "true";
        btn.dataset.lopdKey = key;
        processedKeys.add(key);

        try {
            const hasDoc = await checkLopdDocument();
            console.log(
                `[Pabau LOPD] Client ${clientId} té ${REQUIRED_DOC}?`,
                hasDoc
            );
            if (!hasDoc) {
                blockButton();
                // Re-aplica si el botó es torna a renderitzar
                const mo = new MutationObserver(() => {
                    const b = document.querySelector(BUTTON_SELECTOR);
                    if (b && b.dataset.lopdChecked !== "blocked") {
                        blockButton();
                        b.dataset.lopdChecked = "blocked";
                    }
                });
                mo.observe(document.body, { childList: true, subtree: true });
            }
        } catch (err) {
            console.error("[Pabau LOPD]", err);
        }
    }

    // Llançament immediat + observer per quan el botó es carregui
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", processButton);
    } else {
        processButton();
    }

    const rootObserver = new MutationObserver(processButton);
    rootObserver.observe(document.body, { childList: true, subtree: true });
})();