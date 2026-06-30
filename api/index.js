const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const app     = express();

app.use(express.json());

const { WHATSAPP_TOKEN, VERIFY_TOKEN, PHONE_NUMBER_ID, PERSONAL_PHONE_NUMBER } = process.env;

// ═══════════════════════════════════════════════════════════════
// PERSISTENCIA DE ESTADOS  (archivo JSON en disco)
// ═══════════════════════════════════════════════════════════════
const ESTADOS_FILE = path.join(__dirname, 'estados.json');

function cargarEstados() {
    try {
        if (fs.existsSync(ESTADOS_FILE))
            return JSON.parse(fs.readFileSync(ESTADOS_FILE, 'utf8'));
    } catch (e) { console.error('Error cargando estados:', e.message); }
    return {};
}
function guardarEstados(estados) {
    try { fs.writeFileSync(ESTADOS_FILE, JSON.stringify(estados, null, 2)); }
    catch (e) { console.error('Error guardando estados:', e.message); }
}

let estadoUsuarios = cargarEstados();

// ═══════════════════════════════════════════════════════════════
// TIMEOUTS
// ═══════════════════════════════════════════════════════════════
const TIMEOUT_FLUJO_MS      = 30 * 60 * 1000;        // 30 min → vuelve al menú
const TIMEOUT_ASESOR_MS     = 24 * 60 * 60 * 1000;   // 24 h   → libera modo asesor
const TIMEOUT_LEAD_HECHO_MS = 14 * 24 * 60 * 60 * 1000; // 2 semanas → lead_hecho expira

function obtenerEstado(from) {
    const e = estadoUsuarios[from];
    if (!e) return null;
    const ahora = Date.now();

    // lead_hecho tiene su propio timeout de 2 semanas
    if (e.estado === 'lead_hecho') {
        if (ahora - e.leadHechoAt > TIMEOUT_LEAD_HECHO_MS) {
            console.log(`Lead hecho expirado para ${from}. Reseteando.`);
            delete estadoUsuarios[from];
            guardarEstados(estadoUsuarios);
            return null;
        }
        return e;
    }

    const timeout = e.estado === 'asesor' ? TIMEOUT_ASESOR_MS : TIMEOUT_FLUJO_MS;
    if (ahora - e.ultimaActividad > timeout) {
        console.log(`Timeout (${e.estado}) para ${from}. Reseteando.`);
        delete estadoUsuarios[from];
        guardarEstados(estadoUsuarios);
        return null;
    }
    return e;
}

function setEstado(from, nuevoEstado, extras = {}) {
    estadoUsuarios[from] = { estado: nuevoEstado, ultimaActividad: Date.now(), ...extras };
    guardarEstados(estadoUsuarios);
}
function setLeadHecho(from, flujo, datos) {
    // Estado especial: flujo completado. No vuelve a encuestar por 2 semanas.
    estadoUsuarios[from] = {
        estado: 'lead_hecho',
        flujo,
        datos,
        leadHechoAt: Date.now(),
        ultimaActividad: Date.now()
    };
    guardarEstados(estadoUsuarios);
}
function resetEstado(from) {
    delete estadoUsuarios[from];
    guardarEstados(estadoUsuarios);
}
function refrescarActividad(from) {
    if (estadoUsuarios[from]) {
        estadoUsuarios[from].ultimaActividad = Date.now();
        guardarEstados(estadoUsuarios);
    }
}

// ═══════════════════════════════════════════════════════════════
// FLUJOS PROGRESIVOS — definición de pasos
// ═══════════════════════════════════════════════════════════════

// ─── CARGADOR NIVEL 2 — 4 pasos ───
const PREGUNTAS_CARGADOR = [
    {
        estado: 'c1_marca',
        campo:  'marca',
        texto:
            "Vamos paso a paso para armar tu cotización.\n\n" +
            "1️⃣ de 4 — *¿Qué marca y modelo de auto eléctrico tienes?*\n" +
            "_(Ej: BYD Dolphin, Tesla Model 3, Geely Geometry C…)_\n\n" +
            "─────────────────\n" +
            "💡 Escribe *menú* en cualquier momento para regresar al inicio."
    },
    {
        estado: 'c2_voltaje',
        campo:  'voltaje',
        // Texto especial: se envía con botones interactivos, este campo es fallback
        texto:
            "2️⃣ de 4 — *¿Qué tipo de instalación eléctrica tienes disponible?*\n\n" +
            "1️⃣ Tengo 220V (dos fases / línea de 220)\n" +
            "2️⃣ Solo tengo 127V (contactos normales)\n" +
            "3️⃣ No estoy seguro/a\n\n" +
            "_(Si no sabes, también puedes mandarnos una foto de tu medidor o recibo de luz y lo checamos nosotros.)_\n\n" +
            "💡 Escribe *menú* para regresar al inicio."
    },
    {
        estado: 'c3_metros',
        campo:  'metros',
        texto:
            "3️⃣ de 4 — *¿A cuántos metros aproximados está el tablero eléctrico del punto donde quieres instalar el cargador?*\n\n" +
            "_(Una estimación está bien, ej: \"unos 8 metros\" o \"están en el mismo cuarto\".)_\n\n" +
            "💡 Escribe *menú* para regresar al inicio."
    },
    {
        estado: 'c4_ubicacion',
        campo:  'ubicacion',
        texto:
            "4️⃣ de 4 — *¿En qué ciudad y colonia será la instalación?*\n\n" +
            "_(Solo ciudad y colonia, sin dirección exacta por ahora.)_\n\n" +
            "💡 Escribe *menú* para regresar al inicio."
    }
];

// ─── PANELES SOLARES — 3 pasos ───
const PREGUNTAS_PANELES = [
    {
        estado: 'p1_tipo',
        campo:  'tipo',
        texto:
            "Vamos a armar tu cotización paso a paso.\n\n" +
            "1️⃣ de 3 — *¿Para qué tipo de propiedad es el sistema solar?*\n\n" +
            "🏠 Casa habitación\n" +
            "🏢 Negocio / local comercial\n" +
            "🌾 Rancho o campo\n\n" +
            "_(Escribe la opción que aplique.)_\n\n" +
            "─────────────────\n" +
            "💡 Escribe *menú* en cualquier momento para regresar al inicio."
    },
    {
        estado: 'p2_bimestral',
        campo:  'bimestral',
        texto:
            "2️⃣ de 3 — *¿Cuánto pagas aproximadamente en tu recibo de luz bimestral?*\n\n" +
            "_(Una estimación está bien, ej: \"como $2,000\" o \"entre 3 y 4 mil\".)_\n\n" +
            "💡 Escribe *menú* para regresar al inicio."
    },
    {
        estado: 'p3_recibo',
        campo:  null,
        texto:
            "3️⃣ de 3 — ¡Ya casi! Para afinar la cotización necesitamos tu *recibo de luz*.\n\n" +
            "📸 Mándanos una foto del recibo *por ambos lados*.\n\n" +
            "_(Esto nos permite ver tu historial de consumo y darte el tamaño exacto del sistema.)_\n\n" +
            "💡 Escribe *menú* para regresar al inicio."
    }
];

// ═══════════════════════════════════════════════════════════════
// ALERTAS PROGRESIVAS
// ═══════════════════════════════════════════════════════════════

async function alertarActualizacionCargador(from, datos, paso) {
    const emojis = ['', '🚗', '🔌', '📏', '📍'];
    const labels  = ['', 'Auto', 'Voltaje', 'Distancia tablero', 'Ubicación'];
    const valores = [datos.marca, datos.voltaje, datos.metros, datos.ubicacion];

    let msg = `${emojis[paso]} *Plug n Go — Lead Cargador* ⚡\n`;
    msg    += `📱 Cliente: +${from}\n`;
    msg    += `📋 Paso ${paso}/4: *${labels[paso]}* → "${valores[paso - 1]}"\n\n`;
    msg    += `📊 *Resumen:*\n`;
    if (datos.marca)     msg += `  🚗 Auto: ${datos.marca}\n`;
    if (datos.voltaje)   msg += `  🔌 Voltaje: ${datos.voltaje}\n`;
    if (datos.metros)    msg += `  📏 Metros: ${datos.metros}\n`;
    if (datos.ubicacion) msg += `  📍 Ubicación: ${datos.ubicacion}\n`;
    if (paso === 4) {
        msg += `\n✅ *LEAD COMPLETO* — Entra a Meta Business Suite.\n`;
        msg += `_Al terminar: *#liberar ${from}*_`;
    }
    await enviarTexto(PERSONAL_PHONE_NUMBER, msg);
}

async function alertarActualizacionPaneles(from, datos, paso) {
    const emojis = ['', '🏠', '💰', '📄'];
    const labels  = ['', 'Tipo propiedad', 'Pago bimestral', 'Recibo de luz'];
    const valores = [datos.tipo, datos.bimestral, 'Imagen recibida'];

    let msg = `${emojis[paso]} *Plug n Go — Lead Paneles* ☀️\n`;
    msg    += `📱 Cliente: +${from}\n`;
    msg    += `📋 Paso ${paso}/3: *${labels[paso]}* → "${valores[paso - 1]}"\n\n`;
    msg    += `📊 *Resumen:*\n`;
    if (datos.tipo)      msg += `  🏠 Propiedad: ${datos.tipo}\n`;
    if (datos.bimestral) msg += `  💰 Bimestral: ${datos.bimestral}\n`;
    if (datos.recibo)    msg += `  📄 Recibo: ✅ Imagen recibida\n`;
    if (paso === 3) {
        msg += `\n✅ *LEAD COMPLETO* — Entra a Meta Business Suite.\n`;
        msg += `_Al terminar: *#liberar ${from}*_`;
    }
    await enviarTexto(PERSONAL_PHONE_NUMBER, msg);
}

// ═══════════════════════════════════════════════════════════════
// COMANDOS ADMIN (desde tu número personal)
// ═══════════════════════════════════════════════════════════════
const COMANDO_LIBERAR = '#liberar';
const COMANDO_LISTAR  = '#listar';

async function manejarComandoAdmin(texto, res) {
    if (texto.startsWith(COMANDO_LIBERAR)) {
        const num = texto.replace(COMANDO_LIBERAR, '').trim().replace('+', '');
        if (num && estadoUsuarios[num]) {
            resetEstado(num);
            await enviarTexto(PERSONAL_PHONE_NUMBER, `✅ Estado liberado para +${num}. El bot lo atenderá de nuevo.`);
        } else {
            await enviarTexto(PERSONAL_PHONE_NUMBER, `⚠️ No encontré al cliente +${num} con estado activo.`);
        }
        return res.sendStatus(200);
    }
    if (texto === COMANDO_LISTAR) {
        const lista = Object.entries(estadoUsuarios)
            .map(([k, v]) => `+${k} → ${v.estado}${v.flujo ? ` (${v.flujo})` : ''}`)
            .join('\n');
        await enviarTexto(PERSONAL_PHONE_NUMBER,
            lista ? `📋 Clientes activos:\n${lista}` : '✅ No hay clientes con estado activo.'
        );
        return res.sendStatus(200);
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════
// KEYWORDS MENÚ
// ═══════════════════════════════════════════════════════════════
const KEYWORDS_MENU = ['menu','menú','inicio','hola','hi','hello','start','empezar','volver','regresar','0'];
const esKeywordMenu = txt => KEYWORDS_MENU.includes(txt.toLowerCase().trim());

// ═══════════════════════════════════════════════════════════════
// WEBHOOK GET
// ═══════════════════════════════════════════════════════════════
app.get('/', (req, res) => res.send('🔌 Plug n Go Bot v4.0 activo.'));

app.get('/webhook', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    res.sendStatus(403);
});

// ═══════════════════════════════════════════════════════════════
// WEBHOOK POST
// ═══════════════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        if (!body.object) return res.sendStatus(404);
        if (!body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) return res.sendStatus(200);

        const message = body.entry[0].changes[0].value.messages[0];
        const from    = message.from;

        // ── Comandos admin ──
        if (from === PERSONAL_PHONE_NUMBER && message.type === 'text') {
            const resultado = await manejarComandoAdmin(message.text.body.trim(), res);
            if (resultado !== null) return resultado;
        }

        // ── Estado actual ──
        const entrada      = obtenerEstado(from);
        const estadoActual = entrada?.estado ?? null;
        const datos        = entrada?.datos  ?? {};

        // ── Modo asesor: bot mudo ──
        if (estadoActual === 'asesor') {
            refrescarActividad(from);
            console.log(`[ASESOR] Ignorando mensaje de ${from}`);
            return res.sendStatus(200);
        }

        // ── Lead hecho: recordar que ya está en proceso ──
        if (estadoActual === 'lead_hecho') {
            refrescarActividad(from);
            await enviarTexto(from,
                "Tu solicitud ya está en proceso 👍\n\n" +
                "Un asesor de Plug n Go se pondrá en contacto contigo en breve por este mismo chat.\n\n" +
                "_Si tienes alguna duda urgente, responde aquí y te atendemos._"
            );
            return res.sendStatus(200);
        }

        // ════════════════════════════════════════
        // BOTONES INTERACTIVOS
        // ════════════════════════════════════════
        if (message.type === 'interactive') {
            const interactiveData = message.interactive;

            // Botones del menú principal
            if (interactiveData?.button_reply) {
                const botonID = interactiveData.button_reply.id;

                if (botonID === 'btn_paneles') {
                    setEstado(from, 'p1_tipo', { datos: {}, flujo: 'paneles' });
                    await enviarTexto(from, PREGUNTAS_PANELES[0].texto);

                } else if (botonID === 'btn_cargador') {
                    setEstado(from, 'c1_marca', { datos: {}, flujo: 'cargador' });
                    await enviarTexto(from, PREGUNTAS_CARGADOR[0].texto);

                // Botones de voltaje (paso c2)
                } else if (['btn_220v', 'btn_127v', 'btn_nosabe_voltaje'].includes(botonID)) {
                    const voltajeMap = {
                        'btn_220v':          '220V (dos fases)',
                        'btn_127v':          '127V (contactos normales)',
                        'btn_nosabe_voltaje': 'No sabe / necesita revisión'
                    };
                    const nuevosDatos = { ...datos, voltaje: voltajeMap[botonID] };
                    setEstado(from, 'c3_metros', { datos: nuevosDatos, flujo: 'cargador' });
                    await alertarActualizacionCargador(from, nuevosDatos, 2);
                    await enviarTexto(from, PREGUNTAS_CARGADOR[2].texto);

                } else {
                    await enviarMenuPrincipal(from);
                }
            }

        // ════════════════════════════════════════
        // IMAGEN
        // ════════════════════════════════════════
        } else if (message.type === 'image') {

            // Imagen en paso de voltaje → cliente mandó foto de su medidor
            if (estadoActual === 'c2_voltaje') {
                const nuevosDatos = { ...datos, voltaje: 'Foto de medidor enviada' };
                setEstado(from, 'c3_metros', { datos: nuevosDatos, flujo: 'cargador' });
                await alertarActualizacionCargador(from, nuevosDatos, 2);
                await enviarTexto(from,
                    "📸 ¡Recibida! Nuestro equipo revisará tu instalación con la foto.\n\n" +
                    PREGUNTAS_CARGADOR[2].texto
                );

            // Último paso paneles: recibo de luz
            } else if (estadoActual === 'p3_recibo') {
                const datosFinal = { ...datos, recibo: true };
                setLeadHecho(from, 'paneles', datosFinal);
                await enviarTexto(from,
                    "📄✅ ¡Recibo recibido!\n\n" +
                    "Ya tenemos todo lo que necesitamos. Un asesor revisará tu información y te enviará la cotización *en breve* por este mismo chat.\n\n" +
                    "_¡Gracias por tu tiempo! ☀️_"
                );
                await alertarActualizacionPaneles(from, datosFinal, 3);

            } else if (estadoActual && estadoActual.startsWith('p')) {
                const pasoActual = PREGUNTAS_PANELES.find(p => p.estado === estadoActual);
                await enviarTexto(from,
                    "📸 Recibí tu imagen, pero aún necesito que respondas la pregunta anterior.\n\n" +
                    (pasoActual ? pasoActual.texto : "💡 Escribe *menú* para reiniciar.")
                );

            } else {
                await enviarTexto(from,
                    "Recibí tu imagen 📸, pero no sé en qué te puedo ayudar en este momento.\n\n" +
                    "Escribe *menú* para volver al inicio."
                );
            }

        // ════════════════════════════════════════
        // TEXTO
        // ════════════════════════════════════════
        } else if (message.type === 'text') {
            const textoCliente = message.text.body.trim();

            // Escape universal al menú
            if (esKeywordMenu(textoCliente)) {
                resetEstado(from);
                await enviarMenuPrincipal(from);
                return res.sendStatus(200);
            }

            // Validación mínima solo si no hay estado activo
            // (dentro de un flujo aceptamos cualquier respuesta, incluso "8" o "no")
            if (!estadoActual && textoCliente.length < 2) {
                await enviarTexto(from,
                    "No entendí ese mensaje 😅\n\n" +
                    "Escribe *menú* para volver al inicio."
                );
                return res.sendStatus(200);
            }

            // ─── Si está en c2_voltaje y manda texto en lugar de botón ───
            // (por si acaso el cliente escribe en lugar de tocar el botón)
            if (estadoActual === 'c2_voltaje') {
                const txt = textoCliente.toLowerCase();
                let voltajeDetectado = textoCliente;
                if (txt.includes('220') || txt.includes('dos fases') || txt.includes('bifasico') || txt.includes('bifásico')) {
                    voltajeDetectado = '220V (dos fases)';
                } else if (txt.includes('127') || txt.includes('110') || txt.includes('normal') || txt.includes('contacto')) {
                    voltajeDetectado = '127V (contactos normales)';
                } else if (txt.includes('no') || txt.includes('segur') || txt.includes('sé') || txt.includes('se')) {
                    voltajeDetectado = 'No sabe / necesita revisión';
                }
                const nuevosDatos = { ...datos, voltaje: voltajeDetectado };
                setEstado(from, 'c3_metros', { datos: nuevosDatos, flujo: 'cargador' });
                await alertarActualizacionCargador(from, nuevosDatos, 2);
                await enviarTexto(from, PREGUNTAS_CARGADOR[2].texto);

            // ─── Flujo CARGADOR ───
            } else if (estadoActual === 'c1_marca') {
                const nuevosDatos = { ...datos, marca: textoCliente };
                setEstado(from, 'c2_voltaje', { datos: nuevosDatos, flujo: 'cargador' });
                await alertarActualizacionCargador(from, nuevosDatos, 1);
                await enviarBotonesVoltaje(from);

            } else if (estadoActual === 'c3_metros') {
                const nuevosDatos = { ...datos, metros: textoCliente };
                setEstado(from, 'c4_ubicacion', { datos: nuevosDatos, flujo: 'cargador' });
                await alertarActualizacionCargador(from, nuevosDatos, 3);
                await enviarTexto(from, PREGUNTAS_CARGADOR[3].texto);

            } else if (estadoActual === 'c4_ubicacion') {
                const datosFinal = { ...datos, ubicacion: textoCliente };
                setLeadHecho(from, 'cargador', datosFinal);
                await enviarTexto(from,
                    "📍 ¡Listo, ya tengo todo!\n\n" +
                    "Un asesor revisará tu información y te enviará la cotización de tu cargador Nivel 2 *en breve* ⚡\n\n" +
                    "_¡Gracias por confiar en Plug n Go!_"
                );
                await alertarActualizacionCargador(from, datosFinal, 4);

            // ─── Flujo PANELES ───
            } else if (estadoActual === 'p1_tipo') {
                const nuevosDatos = { ...datos, tipo: textoCliente };
                setEstado(from, 'p2_bimestral', { datos: nuevosDatos, flujo: 'paneles' });
                await alertarActualizacionPaneles(from, nuevosDatos, 1);
                await enviarTexto(from, PREGUNTAS_PANELES[1].texto);

            } else if (estadoActual === 'p2_bimestral') {
                const nuevosDatos = { ...datos, bimestral: textoCliente };
                setEstado(from, 'p3_recibo', { datos: nuevosDatos, flujo: 'paneles' });
                await alertarActualizacionPaneles(from, nuevosDatos, 2);
                await enviarTexto(from, PREGUNTAS_PANELES[2].texto);

            } else if (estadoActual === 'p3_recibo') {
                await enviarTexto(from,
                    "Para continuar necesito la *foto de tu recibo de luz* 📸\n\n" +
                    "Adjunta una imagen (ambos lados del recibo).\n\n" +
                    "💡 Escribe *menú* para volver al inicio."
                );

            // ─── Sin estado → menú ───
            } else {
                await enviarMenuPrincipal(from);
            }

        // ════════════════════════════════════════
        // AUDIO, VIDEO, STICKER, DOCUMENTO, ETC.
        // ════════════════════════════════════════
        } else {
            console.log(`[TIPO NO MANEJADO] ${message.type} de ${from}`);
            await enviarTexto(from,
                "Por el momento solo proceso texto e imágenes 😊\n\n" +
                "Escribe *menú* para volver al inicio."
            );
        }

        res.sendStatus(200);

    } catch (error) {
        console.error('Error en webhook:', error);
        res.sendStatus(200);
    }
});

// ═══════════════════════════════════════════════════════════════
// FUNCIONES API WHATSAPP
// ═══════════════════════════════════════════════════════════════

async function enviarMenuPrincipal(to) {
    await hacerPeticionWA({
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
            type: "button",
            body: {
                text:
                    "¿Qué tal? Soy el asistente de *Plug n Go* ⚡\n\n" +
                    "Cuéntame, ¿en qué proyecto estás pensando?"
            },
            footer: { text: "Escribe 'menú' en cualquier momento para volver aquí." },
            action: {
                buttons: [
                    { type: "reply", reply: { id: "btn_paneles",  title: "☀️ Paneles Solares"  } },
                    { type: "reply", reply: { id: "btn_cargador", title: "⚡ Cargador Nivel 2" } }
                ]
            }
        }
    });
}

async function enviarBotonesVoltaje(to) {
    await hacerPeticionWA({
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
            type: "button",
            body: {
                text:
                    "2️⃣ de 4 — *¿Qué tipo de instalación eléctrica tienes disponible?*\n\n" +
                    "Si no estás seguro/a, también puedes mandarnos una *foto de tu medidor o recibo de luz* y lo checamos nosotros 📸"
            },
            footer: { text: "Escribe 'menú' para regresar al inicio." },
            action: {
                buttons: [
                    { type: "reply", reply: { id: "btn_220v",          title: "✅ Tengo 220V"        } },
                    { type: "reply", reply: { id: "btn_127v",          title: "🔌 Solo 127V"         } },
                    { type: "reply", reply: { id: "btn_nosabe_voltaje", title: "❓ No estoy seguro/a" } }
                ]
            }
        }
    });
}

async function enviarTexto(to, texto) {
    await hacerPeticionWA({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: texto }
    });
}

async function hacerPeticionWA(data) {
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            },
            data
        });
    } catch (error) {
        console.error("Error API WhatsApp:", error.response?.data ?? error.message);
    }
}

module.exports = app;
