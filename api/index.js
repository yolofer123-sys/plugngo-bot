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
// Sobrevive reinicios del proceso. Si tu plataforma no persiste
// el disco entre deploys (Render free tier, Railway sin volumen)
// migra a Upstash Redis — avísame y te lo agrego en 5 min.
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
const TIMEOUT_FLUJO_MS   = 30 * 60 * 1000;       // 30 min → vuelve al menú
const TIMEOUT_ASESOR_MS  = 24 * 60 * 60 * 1000;  // 24 h  → libera modo asesor

function obtenerEstado(from) {
    const e = estadoUsuarios[from];
    if (!e) return null;
    const ahora = Date.now();
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
//
// CARGADOR NIVEL 2 — 4 preguntas, una por una
//   c1 → marca y modelo del auto
//   c2 → voltaje disponible (220V o 127V)
//   c3 → metros al tablero eléctrico
//   c4 → ciudad y colonia de instalación
//
// PANELES SOLARES — 2 preguntas + foto del recibo
//   p1 → tipo de propiedad (casa / negocio / rancho)
//   p2 → pago bimestral aproximado
//   p3 → foto del recibo (imagen)

// ─── Preguntas del flujo CARGADOR ───
const PREGUNTAS_CARGADOR = [
    {
        estado: 'c1_marca',
        campo:  'marca',
        texto:
            "⚡ ¡Perfecto! Vamos paso a paso para darte la mejor cotización.\n\n" +
            "1️⃣ de 4 — *¿Qué marca y modelo de auto eléctrico tienes?*\n" +
            "_(Ej: BYD Dolphin, Tesla Model 3, Geely Geometry C…)_\n\n" +
            "─────────────────\n" +
            "💡 Escribe *menú* en cualquier momento para regresar al inicio."
    },
    {
        estado: 'c2_voltaje',
        campo:  'voltaje',
        texto:
            "2️⃣ de 4 — *¿Cuentas con voltaje de 220V disponible en el lugar de instalación, o solo tienes contactos normales de 127V?*\n\n" +
            "_(Si no estás seguro, tranquilo — lo evaluamos en la visita técnica.)_\n\n" +
            "💡 Escribe *menú* para regresar al inicio."
    },
    {
        estado: 'c3_metros',
        campo:  'metros',
        texto:
            "3️⃣ de 4 — *¿A cuántos metros aproximados está el tablero eléctrico del punto donde quieres instalar el cargador?*\n\n" +
            "_(Una estimación está bien, ej: \"como 8 metros\" o \"está en el mismo cuarto\".)_\n\n" +
            "💡 Escribe *menú* para regresar al inicio."
    },
    {
        estado: 'c4_ubicacion',
        campo:  'ubicacion',
        texto:
            "4️⃣ de 4 — *¿En qué ciudad y colonia será la instalación?*\n\n" +
            "_(Solo ciudad y colonia, sin necesidad de dar dirección exacta por ahora.)_\n\n" +
            "💡 Escribe *menú* para regresar al inicio."
    }
];

// ─── Preguntas del flujo PANELES ───
const PREGUNTAS_PANELES = [
    {
        estado: 'p1_tipo',
        campo:  'tipo',
        texto:
            "☀️ ¡Excelente elección! Vamos a armar tu cotización paso a paso.\n\n" +
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
        campo:  null, // campo especial → espera imagen
        texto:
            "3️⃣ de 3 — ¡Ya casi! Para afinar la cotización necesitamos tu *recibo de luz*.\n\n" +
            "📸 Por favor manda una foto del recibo *por ambos lados*.\n\n" +
            "_(Esto nos permite ver tu historial de consumo y darte el tamaño exacto del sistema.)_\n\n" +
            "💡 Escribe *menú* para regresar al inicio."
    }
];

// ═══════════════════════════════════════════════════════════════
// ALERTAS PROGRESIVAS — mensajes que te llegan a ti
// ═══════════════════════════════════════════════════════════════

async function alertarActualizacionCargador(from, datos, paso) {
    const emojis = ['', '🚗', '🔌', '📏', '📍'];
    const labels  = ['', 'Auto', 'Voltaje', 'Distancia tablero', 'Ubicación'];
    const valores = [datos.marca, datos.voltaje, datos.metros, datos.ubicacion];

    let resumen = `${emojis[paso]} *Plug n Go — Update Lead Cargador* ⚡\n`;
    resumen    += `📱 Cliente: +${from}\n`;
    resumen    += `📋 Paso ${paso}/4 completado: *${labels[paso]}* → "${valores[paso - 1]}"\n\n`;
    resumen    += `📊 *Resumen acumulado:*\n`;
    if (datos.marca)     resumen += `  🚗 Auto: ${datos.marca}\n`;
    if (datos.voltaje)   resumen += `  🔌 Voltaje: ${datos.voltaje}\n`;
    if (datos.metros)    resumen += `  📏 Metros: ${datos.metros}\n`;
    if (datos.ubicacion) resumen += `  📍 Ubicación: ${datos.ubicacion}\n`;

    if (paso === 4) {
        resumen += `\n✅ *LEAD COMPLETO* — Entra a Meta Business Suite para cotizar.\n`;
        resumen += `_Cuando termines: *#liberar ${from}*_`;
    }

    await enviarTexto(PERSONAL_PHONE_NUMBER, resumen);
}

async function alertarActualizacionPaneles(from, datos, paso) {
    const emojis = ['', '🏠', '💰', '📄'];
    const labels  = ['', 'Tipo propiedad', 'Pago bimestral', 'Recibo de luz'];
    const valores = [datos.tipo, datos.bimestral, 'Imagen recibida'];

    let resumen = `${emojis[paso]} *Plug n Go — Update Lead Paneles* ☀️\n`;
    resumen    += `📱 Cliente: +${from}\n`;
    resumen    += `📋 Paso ${paso}/3 completado: *${labels[paso]}* → "${valores[paso - 1]}"\n\n`;
    resumen    += `📊 *Resumen acumulado:*\n`;
    if (datos.tipo)      resumen += `  🏠 Propiedad: ${datos.tipo}\n`;
    if (datos.bimestral) resumen += `  💰 Bimestral: ${datos.bimestral}\n`;
    if (datos.recibo)    resumen += `  📄 Recibo: ✅ Imagen recibida\n`;

    if (paso === 3) {
        resumen += `\n✅ *LEAD COMPLETO* — Entra a Meta Business Suite para cotizar.\n`;
        resumen += `_Cuando termines: *#liberar ${from}*_`;
    }

    await enviarTexto(PERSONAL_PHONE_NUMBER, resumen);
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
            await enviarTexto(PERSONAL_PHONE_NUMBER, `✅ Modo asesor liberado para +${num}. El bot lo atenderá de nuevo.`);
        } else {
            await enviarTexto(PERSONAL_PHONE_NUMBER, `⚠️ No encontré al cliente +${num} en ningún estado activo.`);
        }
        return res.sendStatus(200);
    }
    if (texto === COMANDO_LISTAR) {
        const lista = Object.entries(estadoUsuarios)
            .map(([k, v]) => `+${k} → ${v.estado}`)
            .join('\n');
        const msg = lista
            ? `📋 Clientes con estado activo:\n${lista}`
            : '✅ No hay clientes con estado activo ahora mismo.';
        await enviarTexto(PERSONAL_PHONE_NUMBER, msg);
        return res.sendStatus(200);
    }
    return null; // no era un comando admin
}

// ═══════════════════════════════════════════════════════════════
// KEYWORDS PARA VOLVER AL MENÚ
// ═══════════════════════════════════════════════════════════════
const KEYWORDS_MENU = ['menu','menú','inicio','hola','hi','hello','start','empezar','volver','regresar','0'];
const esKeywordMenu = txt => KEYWORDS_MENU.includes(txt.toLowerCase().trim());

// ═══════════════════════════════════════════════════════════════
// WEBHOOK GET — verificación Meta
// ═══════════════════════════════════════════════════════════════
app.get('/', (req, res) => res.send('🔌 Plug n Go Bot v3.0 — Flujos progresivos activos.'));

app.get('/webhook', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    res.sendStatus(403);
});

// ═══════════════════════════════════════════════════════════════
// WEBHOOK POST — lógica principal
// ═══════════════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        if (!body.object) return res.sendStatus(404);
        if (!body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) return res.sendStatus(200);

        const message = body.entry[0].changes[0].value.messages[0];
        const from    = message.from;

        // ── Comandos admin desde tu celular ──
        if (from === PERSONAL_PHONE_NUMBER && message.type === 'text') {
            const resultado = await manejarComandoAdmin(message.text.body.trim(), res);
            if (resultado !== null) return resultado;
            // Si no era comando, lo procesa como cliente normal (por si acaso)
        }

        // ── Estado actual con timeout ──
        const entrada      = obtenerEstado(from);
        const estadoActual = entrada?.estado ?? null;
        const datos        = entrada?.datos  ?? {};

        // ── Modo asesor: bot mudo, solo refresca ──
        if (estadoActual === 'asesor') {
            refrescarActividad(from);
            console.log(`[ASESOR] Ignorando mensaje de ${from}`);
            return res.sendStatus(200);
        }

        // ════════════════════════════════════════
        // BOTONES INTERACTIVOS
        // ════════════════════════════════════════
        if (message.type === 'interactive') {
            const botonID = message.interactive?.button_reply?.id;

            if (botonID === 'btn_paneles') {
                const primerPaso = PREGUNTAS_PANELES[0];
                setEstado(from, primerPaso.estado, { datos: {}, flujo: 'paneles' });
                await enviarTexto(from, primerPaso.texto);

            } else if (botonID === 'btn_cargador') {
                const primerPaso = PREGUNTAS_CARGADOR[0];
                setEstado(from, primerPaso.estado, { datos: {}, flujo: 'cargador' });
                await enviarTexto(from, primerPaso.texto);

            } else {
                await enviarMenuPrincipal(from);
            }

        // ════════════════════════════════════════
        // IMAGEN
        // ════════════════════════════════════════
        } else if (message.type === 'image') {

            if (estadoActual === 'p3_recibo') {
                // Último paso del flujo de paneles
                const datosFinal = { ...datos, recibo: true };
                setEstado(from, 'asesor', { datos: datosFinal, flujo: 'paneles' });

                await enviarTexto(from,
                    "📄✅ ¡Perfecto, recibo recibido!\n\n" +
                    "Ya tenemos todo lo que necesitamos. Un asesor revisará tu información y te enviará la cotización *en breve* por este mismo chat.\n\n" +
                    "_¡Gracias por tu tiempo! ☀️_"
                );
                await alertarActualizacionPaneles(from, datosFinal, 3);

            } else if (estadoActual && estadoActual.startsWith('p')) {
                // Está en flujo de paneles pero en paso incorrecto
                const pasoActual = PREGUNTAS_PANELES.find(p => p.estado === estadoActual);
                await enviarTexto(from,
                    "📸 Recibí tu imagen, pero aún necesito que respondas la pregunta anterior.\n\n" +
                    (pasoActual ? pasoActual.texto : "💡 Escribe *menú* para reiniciar.")
                );

            } else {
                // Imagen fuera de contexto
                await enviarTexto(from,
                    "Recibí tu imagen 📸, pero no sé en qué te puedo ayudar.\n\n" +
                    "Escribe *menú* para ver las opciones disponibles."
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

            // Validación mínima
            if (textoCliente.length < 2) {
                await enviarTexto(from,
                    "No entendí bien ese mensaje 😅\n\n" +
                    "Por favor responde la pregunta o escribe *menú* para ver las opciones."
                );
                return res.sendStatus(200);
            }

            // ────────────────────────────────────
            // FLUJO CARGADOR — paso a paso
            // ────────────────────────────────────
            if (estadoActual === 'c1_marca') {
                const nuevosDatos = { ...datos, marca: textoCliente };
                setEstado(from, 'c2_voltaje', { datos: nuevosDatos, flujo: 'cargador' });
                await alertarActualizacionCargador(from, nuevosDatos, 1);
                await enviarTexto(from, PREGUNTAS_CARGADOR[1].texto);

            } else if (estadoActual === 'c2_voltaje') {
                const nuevosDatos = { ...datos, voltaje: textoCliente };
                setEstado(from, 'c3_metros', { datos: nuevosDatos, flujo: 'cargador' });
                await alertarActualizacionCargador(from, nuevosDatos, 2);
                await enviarTexto(from, PREGUNTAS_CARGADOR[2].texto);

            } else if (estadoActual === 'c3_metros') {
                const nuevosDatos = { ...datos, metros: textoCliente };
                setEstado(from, 'c4_ubicacion', { datos: nuevosDatos, flujo: 'cargador' });
                await alertarActualizacionCargador(from, nuevosDatos, 3);
                await enviarTexto(from, PREGUNTAS_CARGADOR[3].texto);

            } else if (estadoActual === 'c4_ubicacion') {
                // Último paso del flujo cargador
                const datosFinal = { ...datos, ubicacion: textoCliente };
                setEstado(from, 'asesor', { datos: datosFinal, flujo: 'cargador' });
                await enviarTexto(from,
                    "📍 ¡Listo, ya tengo todo!\n\n" +
                    "Un asesor revisará tu información y te enviará la cotización de tu cargador Nivel 2 *en breve* ⚡\n\n" +
                    "_¡Gracias por confiar en Plug n Go!_"
                );
                await alertarActualizacionCargador(from, datosFinal, 4);

            // ────────────────────────────────────
            // FLUJO PANELES — paso a paso
            // ────────────────────────────────────
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
                // Está en paso de foto pero mandó texto
                await enviarTexto(from,
                    "Para continuar necesito la *foto de tu recibo de luz* 📸\n\n" +
                    "Por favor adjunta una imagen (ambos lados del recibo).\n\n" +
                    "💡 Escribe *menú* si deseas volver al inicio."
                );

            // ────────────────────────────────────
            // Sin estado → menú principal
            // ────────────────────────────────────
            } else {
                await enviarMenuPrincipal(from);
            }

        // ════════════════════════════════════════
        // AUDIO, VIDEO, STICKER, DOCUMENTO, ETC.
        // ════════════════════════════════════════
        } else {
            console.log(`[TIPO NO MANEJADO] ${message.type} de ${from}`);
            await enviarTexto(from,
                "Solo proceso texto e imágenes por el momento 😊\n\n" +
                "Escribe *menú* para ver las opciones disponibles."
            );
        }

        res.sendStatus(200);

    } catch (error) {
        console.error('Error en webhook:', error);
        res.sendStatus(200); // Siempre 200 para que Meta no reintente
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
            body: { text: "¡Hola! 👋 Bienvenido a *Plug n Go* ⚡\n\n¿Qué proyecto estás buscando hoy?" },
            footer: { text: "Escribe 'menú' en cualquier momento para regresar aquí." },
            action: {
                buttons: [
                    { type: "reply", reply: { id: "btn_paneles",  title: "☀️ Paneles Solares"  } },
                    { type: "reply", reply: { id: "btn_cargador", title: "⚡ Cargador Nivel 2" } }
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
