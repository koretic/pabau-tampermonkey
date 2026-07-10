// filepath: treatments_config.js
// ==UserScript==
// @name         Pabau LOPD — Treatments Config
// @namespace    http://tampermonkey.net/
// @version      2026-07-10
// @description  Mapa de tractaments (id → document base + caducitat). Inclòs via @require.
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function (root) {
    "use strict";

    /**
     * Cada entrada defineix:
     *   id          : id de servei (product_id de la invoice). 0 = sense id → match per nom.
     *   name        : nom humà del tractament (per debug i fallback de lookup).
     *   category    : categoria Pabau (informatiu).
     *   document    : { base: "CI …", expiryMonths: 12 }
     *                 El nom final que es cerca a l'API és `${base}_FIRMADO.pdf`.
     *                 Si `document` és null, el tractament NO requereix document.
     */
    const TREATMENTS = [
        // ============ Ácido Hialurónico ============
        { id: 2702512, name: "Marcación mandibular",                category: "Ácido Hialurónico",  document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
        { id: 2702513, name: "Proyección de mentón",                 category: "Ácido Hialurónico",  document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
        { id: 2702514, name: "Proyección de pómulos",                category: "Ácido Hialurónico",  document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
        { id: 2702515, name: "Corrección surco nasogeniano",         category: "Ácido Hialurónico",  document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
        { id: 2702516, name: "Corrección líneas de marioneta",       category: "Ácido Hialurónico",  document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
        { id: 2702517, name: "Corrección sonrisa gingival",          category: "Ácido Hialurónico",  document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
        { id: 2702518, name: "Relleno fosa temporal",                category: "Ácido Hialurónico",  document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
        { id: 2702519, name: "Código de barras",                     category: "Ácido Hialurónico",  document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
        { id: 2702520, name: "Corrección de ojeras",                 category: "Ácido Hialurónico",  document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
        { id: 2702521, name: "Diseño de labios",                     category: "Ácido Hialurónico",  document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
        { id: 2702522, name: "Rinomodelación",                       category: "Ácido Hialurónico",  document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },
        { id: 2702523, name: "Rinomodelación con cirugía previa",    category: "Ácido Hialurónico",  document: { base: "CI ACIDO HIALURONICO-ES 2026", expiryMonths: 12 } },

        // ============ Blefaroplastia ============
        { id: 2702542, name: "Blefaroplastia superior",              category: "Blefaroplastia",     document: { base: "CI BLEFAROPLASTIA-ES 2026",     expiryMonths: 12 } },
        { id: 2702543, name: "Blefaroplastia inferior",              category: "Blefaroplastia",     document: { base: "CI BLEFAROPLASTIA-ES 2026",     expiryMonths: 12 } },
        { id: 2702544, name: "Blefaroplastia 4 párpados",            category: "Blefaroplastia",     document: { base: "CI BLEFAROPLASTIA-ES 2026",     expiryMonths: 12 } },

        // ============ Exosomas y Biología ============
        { id: 2702545, name: "Exosomas autólogos",                   category: "Exosomas y Biología", document: { base: "Consent. Exosomas autólogos ES 2026", expiryMonths: 12 } },
        { id: 2702546, name: "Polinucleótidos",                      category: "Exosomas y Biología", document: { base: "CI Polinucleotidos universal ES 2026", expiryMonths: 12 } },
        { id: 2702547, name: "Hialuronidasa",                        category: "Exosomas y Biología", document: { base: "CI HIALURONIDASA ES 2026",      expiryMonths: 12 } },

        // ============ Neuromoduladores ============
        { id: 2702524, name: "Neuromoduladores – 1 zona",            category: "Neuromoduladores",   document: { base: "CI TOXINA BOTULINICA ES 2026",   expiryMonths: 12 } },
        { id: 2702525, name: "Neuromoduladores – 2 zonas",           category: "Neuromoduladores",   document: { base: "CI TOXINA BOTULINICA ES 2026",   expiryMonths: 12 } },
        { id: 2702526, name: "Neuromoduladores – 3 zonas",           category: "Neuromoduladores",   document: { base: "CI TOXINA BOTULINICA ES 2026",   expiryMonths: 12 } },
        { id: 2702527, name: "Neuromoduladores tercio inferior",     category: "Neuromoduladores",   document: { base: "CI TOXINA BOTULINICA ES 2026",   expiryMonths: 12 } },
        { id: 2702528, name: "Bruxismo",                             category: "Neuromoduladores",   document: { base: "CI TOXINA BOTULINICA ES 2026",   expiryMonths: 12 } },
        { id: 2702529, name: "Hiperhidrosis",                        category: "Neuromoduladores",   document: { base: "CI TOXINA BOTULINICA ES 2026",   expiryMonths: 12 } },

        // ============ Inductores de colágeno (Sculptra / Radiesse) ============
        // Encara sense id definit per la API → match per nom.
        { id: 2702531, name: "Sculptra cuello",        category: "Inductores", document: { base: "CI INDUCTOR DE COLÁGENO ES 2026", expiryMonths: 12 } },
        { id: 2702530, name: "Sculptra cara",          category: "Inductores", document: { base: "CI INDUCTOR DE COLÁGENO ES 2026", expiryMonths: 12 } },
        { id: 0, name: "Sulptra cara",           category: "Inductores", document: { base: "CI INDUCTOR DE COLÁGENO ES 2026", expiryMonths: 12 } },
        { id: 2702532, name: "Radiesse Cara",          category: "Inductores", document: { base: "CI INDUCTOR DE COLÁGENO ES 2026", expiryMonths: 12 } },
        { id: 2702533, name: "Radiesse cuello",        category: "Inductores", document: { base: "CI INDUCTOR DE COLÁGENO ES 2026", expiryMonths: 12 } },
        { id: 2702597, name: "Inductores de colágeno", category: "Inductores", document: { base: "CI INDUCTOR DE COLÁGENO ES 2026", expiryMonths: 12 } },

        // ============ Láser Rejuvenecimiento ============
        { id: 2702560, name: "ResurFX rejuvenecimiento",                       category: "Láser Rejuvenecimiento", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
        { id: 2702561, name: "Láser Pico rejuvenecimiento / manchas / melasma", category: "Láser Rejuvenecimiento", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
        { id: 2702562, name: "CO2 Panfacial completo",                         category: "Láser Rejuvenecimiento", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
        { id: 2702563, name: "CO2 Tercio medio",                               category: "Láser Rejuvenecimiento", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
        { id: 2702564, name: "CO2 Periocular",                                 category: "Láser Rejuvenecimiento", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
        { id: 2702565, name: "CO2 Cuello",                                     category: "Láser Rejuvenecimiento", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
        { id: 2702566, name: "CO2 Cara y cuello",                              category: "Láser Rejuvenecimiento", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
        { id: 2702567, name: "CO2 Cara, cuello y escote",                      category: "Láser Rejuvenecimiento", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
        { id: 2702568, name: "CO2 Escote",                                     category: "Láser Rejuvenecimiento", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
        { id: 2702569, name: "CO2 Verrugas",                                   category: "Láser Rejuvenecimiento", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },

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
        { id: 2702574,        name: "Nd-Yag Venas Prioculares",                    category: "Láser Vascular y Pigmentación", document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },

        // ============ Mesoterapia / PRGF / PRP ============
        { id: 2702554, name: "Vitaminas NCTF 135 AH rostro",                   category: "Mesoterapia", document: { base: "CI MESOTERAPIA NTCF 135 HA-ES 2026", expiryMonths: 12 } },
        { id: 2702555, name: "Vitaminas NCTF 135 AH periocular",               category: "Mesoterapia", document: { base: "CI MESOTERAPIA NTCF 135 HA-ES 2026", expiryMonths: 12 } },
        { id: 2702556, name: "PRGF Facial",                                    category: "Mesoterapia", document: { base: "CI PRGF ES 2026",                    expiryMonths: 12 } },
        { id: 2702557, name: "PRGF Capilar",                                   category: "Mesoterapia", document: { base: "CI PRGF ES 2026",                    expiryMonths: 12 } },
        { id: 2702558, name: "PRGF COLIRIO",                                   category: "Mesoterapia", document: { base: "CI PRGF ES 2026",                    expiryMonths: 12 } },
        { id: 2702559, name: "Pack Vitaminas + PRGF",                          category: "Mesoterapia", document: { base: "CI PRGF ES 2026",                    expiryMonths: 12 } },
        { id: 2702616, name: "PRP Facial",                                     category: "Mesoterapia", document: { base: "CI PRGF ES 2026",                    expiryMonths: 12 } },
        { id: 2702617, name: "PRP Capilar",                                    category: "Mesoterapia", document: { base: "CI PRGF ES 2026",                    expiryMonths: 12 } },
        { id: 2702618, name: "Pack Vitaminas + PRP",                           category: "Mesoterapia", document: { base: "CI PRGF ES 2026",                    expiryMonths: 12 } },

        // ============ Marketing ============
        { id: 2702615, name: "Colaboración",                                   category: "Marketing", document: { base: "CI USO IMAGENES SONIDO ES 2026",     expiryMonths: 12 } },

        // ============ Refractiva (sense document definit) ============
        { id: 2702548, name: "Láser FemtoLasik – por ojo",                     category: "Refractiva", document: null },
        { id: 2702549, name: "Láser PRK – por ojo",                            category: "Refractiva", document: null },
        { id: 2702550, name: "Lentes ICL esférica – por ojo",                  category: "Refractiva", document: null },
        { id: 2702551, name: "Lentes ICL tórica – por ojo",                    category: "Refractiva", document: null },

        // ============ Tratamientos Faciales ============
        { id: 2702611,        name: "Reverso",                                       category: "Tratamientos Faciales",          document: null },
        { id: 2702538,        name: "Microneedling con exosomas vegetales",          category: "Tratamientos Faciales",          document: { base: "CI MICRONEEDLING ES 2026", expiryMonths: 12 } },
        { id: 2702539,        name: "Peeling médico cara",                           category: "Tratamientos Faciales",           document: { base: "PEELING ES 2026", expiryMonths: 12 } },
        { id: 2702537,        name: "Microneedling cara y cuello",                   category: "Tratamientos Faciales",           document: { base: "CI MICRONEEDLING ES 2026", expiryMonths: 12 } },
        { id: 2702540,        name: "Hydrafacial Signature",                         category: "Tratamientos Faciales",           document: { base: "CI HYDRAFACIAL ES 2026", expiryMonths: 12 } },
        { id: 2702541,        name: "Hydrafacial Deluxe",                            category: "Tratamientos Faciales",           document: { base: "CI HYDRAFACIAL ES 2026", expiryMonths: 12 } },
        { id: 2702574,        name: "Nd-Yag Venas Prioculares",                      category: "Tratamientos Faciales",           document: { base: "CI LÁSER ES v.3.2026", expiryMonths: 12 } },
        
        // ============ Ultrasonidos HIFU ============
        { id: 2702534,        name: "Ultraformer MPT – Cara",                        category: "Tratamientos Faciales",           document: { base: "CI ULTRAFORMER ES 2026", expiryMonths: 12 } },
        { id: 2702535,        name: "Ultraformer MPT – Cuello / Papada",             category: "Tratamientos Faciales",           document: { base: "CI ULTRAFORMER ES 2026", expiryMonths: 12 } },
        { id: 2702536,        name: "Ultraformer MPT – Cara y cuello completo",      category: "Tratamientos Faciales",          document:  { base: "CI ULTRAFORMER ES 2026", expiryMonths: 12 } },
    ];

    // Índex per id (lookup O(1)) — fallback per nom.
    const BY_ID = new Map();
    const BY_NAME = new Map();
    for (const t of TREATMENTS) {
        if (t.id) BY_ID.set(Number(t.id), t);
        if (t.name) BY_NAME.set(String(t.name).toLowerCase().trim(), t);
    }

    function getById(id) {
        return BY_ID.get(Number(id)) || null;
    }

    function getByName(name) {
        if (!name) return null;
        return BY_NAME.get(String(name).toLowerCase().trim()) || null;
    }

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

    root.PabauTreatments = Object.freeze({
        resolve,
        getById,
        getByName,
        list: TREATMENTS,
    });
})(typeof unsafeWindow !== "undefined" ? unsafeWindow : window);