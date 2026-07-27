const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const app     = express();

app.use(express.json());

const {
    WHATSAPP_TOKEN,
    VERIFY_TOKEN,
    PHONE_NUMBER_ID,
    // Comma-separated lists — soporta de 1 a 3 números cada uno:
    
    PERSONAL_NUMBERS,
    ADMIN_NUMBERS
} = process.env;

// Normaliza número: quita +, espacios y guiones para comparar de forma segura
const normalizarNumero = n => (n ?? '').replace(/[\s+\-()]/g, '');

// Parse comma-separated env vars into arrays of normalized numbers
const PERSONAL_LIST = (PERSONAL_NUMBERS ?? process.env.PERSONAL_PHONE_NUMBER ?? '')
    .split(',').map(n => normalizarNumero(n)).filter(Boolean);

const ADMIN_LIST = (ADMIN_NUMBERS ?? process.env.ADMIN_NUMBER ?? '')
    .split(',').map(n => normalizarNumero(n)).filter(Boolean);

if (PERSONAL_LIST.length === 0) console.warn('⚠️  PERSONAL_NUMBERS no está configurado en .env');
if (ADMIN_LIST.length   === 0) console.warn('⚠️  ADMIN_NUMBERS no está configurado en .env');

// Helpers de permisos
const esAdmin    = from => ADMIN_LIST.includes(normalizarNumero(from));
const esPersonal = from => PERSONAL_LIST.includes(normalizarNumero(from));

// Broadcast a todos los números personales (alertas de leads)
async function enviarATodos(texto) {
    await Promise.all(PERSONAL_LIST.map(num => enviarTexto(num, texto)));
}

// Broadcast a todos los admins (mensajes reenviados de clientes, notificaciones de CRM)
async function enviarATodosAdmins(texto) {
    await Promise.all(ADMIN_LIST.map(num => enviarTexto(num, texto)));
}

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
        texto:
            "2️⃣ de 4 — *¿Qué tipo de instalación eléctrica tienes disponible?*\n\n" +
            "1️⃣ Tengo 220V (dos fases / línea de 220)\n" +
            "2️⃣ Solo tengo 127V (contactos normales)\n" +
            "3️⃣ No estoy seguro/a\n\n" +
            "_(Si no sabes, también puedes mandarnos una foto de tu medidor o recibo de luz y lo checamos nosotros.)_"
    },
    {
        estado: 'c3_metros',
        campo:  'metros',
        texto:
            "3️⃣ de 4 — *¿A cuántos metros aproximados está el tablero eléctrico del punto donde quieres instalar el cargador?*\n\n" +
            "_(Una estimación está bien, ej: \"unos 8 metros\" o \"están en el mismo cuarto\".)_"
    },
    {
        estado: 'c4_ubicacion',
        campo:  'ubicacion',
        texto:
            "4️⃣ de 4 — *¿En qué ciudad y colonia será la instalación?*\n\n" +
            "_(Solo ciudad y colonia, sin dirección exacta por ahora.)_"
    }
];

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
            "_(Una estimación está bien, ej: \"como $2,000\" o \"entre 3 y 4 mil\".)_"
    },
    {
        estado: 'p3_recibo',
        campo:  null,
        texto:
            "3️⃣ de 3 — ¡Ya casi! Para afinar la cotización necesitamos tu *recibo de luz*.\n\n" +
            "📸 Mándanos una foto del recibo *por ambos lados*.\n\n" +
            "_(Esto nos permite ver tu historial de consumo y darte el tamaño exacto del sistema.)_"
    }
];

// ═══════════════════════════════════════════════════════════════
// ALERTAS PROGRESIVAS  (van a TODOS los PERSONAL_NUMBERS)
// ═══════════════════════════════════════════════════════════════

async function alertarActualizacionCargador(from, datos, paso) {
    const emojis = ['', '🚗', '🔌', '📏', '📍'];
    const labels  = ['', 'Auto', 'Voltaje', 'Distancia tablero', 'Ubicación'];
    const valores = [datos.marca, datos.voltaje, datos.metros, datos.ubicacion];

    let msg = `${emojis[paso]} *Plug&Go — Lead Cargador* ⚡\n`;
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
    await enviarATodos(msg);
}

async function alertarActualizacionPaneles(from, datos, paso) {
    const emojis = ['', '🏠', '💰', '📄'];
    const labels  = ['', 'Tipo propiedad', 'Pago bimestral', 'Recibo de luz'];
    const valores = [datos.tipo, datos.bimestral, 'Imagen recibida'];

    let msg = `${emojis[paso]} *Plug&Go — Lead Paneles* ☀️\n`;
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
    await enviarATodos(msg);
}

// ═══════════════════════════════════════════════════════════════
// COMANDOS ADMIN (desde CUALQUIER número en ADMIN_NUMBERS)
// ═══════════════════════════════════════════════════════════════
const COMANDO_LIBERAR = '#liberar';
const COMANDO_LISTAR  = '#listar';

// `from` = el admin que mandó el comando; le respondemos a él directamente.
async function manejarComandoAdmin(texto, from, res) {
    if (texto.startsWith(COMANDO_LIBERAR)) {
        const num = texto.replace(COMANDO_LIBERAR, '').trim().replace('+', '');
        if (num && estadoUsuarios[num]) {
            resetEstado(num);
            await enviarTexto(from, `✅ Estado liberado para +${num}. El bot lo atenderá de nuevo.`);
        } else {
            await enviarTexto(from, `⚠️ No encontré al cliente +${num} con estado activo.`);
        }
        return res.sendStatus(200);
    }
    if (texto === COMANDO_LISTAR) {
        const lista = Object.entries(estadoUsuarios)
            .map(([k, v]) => `+${k} → ${v.estado}${v.flujo ? ` (${v.flujo})` : ''}`)
            .join('\n');
        await enviarTexto(from,
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
app.get('/', (req, res) => res.send('🔌 Plug n Go Bot v4.1 activo (multi-admin).'));

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

        // ══════════════════════════════════════════════════════════
        // MICRO-CRM — se ejecuta si el mensaje viene de CUALQUIER admin
        // ══════════════════════════════════════════════════════════
        if (esAdmin(from)) {

            if (message.type === 'text') {
                const textoAdmin = message.text.body.trim();

                const resultadoComando = await manejarComandoAdmin(textoAdmin, from, res);
                if (resultadoComando !== null) return resultadoComando;

                // ── RELAY DE TEXTO: "#52XXXXXXXXXX\nMensaje aquí" ──
                if (textoAdmin.startsWith('#')) {
                    const saltoLinea = textoAdmin.indexOf('\n');

                    if (saltoLinea === -1) {
                        await enviarTexto(from,
                            "⚠️ Formato incorrecto. Usa:\n\n" +
                            "*#52XXXXXXXXXX*\n" +
                            "Tu mensaje aquí\n\n" +
                            "_El número va en la primera línea, el mensaje en las siguientes._"
                        );
                        return res.sendStatus(200);
                    }

                    const numeroDestino = textoAdmin.slice(1, saltoLinea).trim().replace(/[\s+\-()]/g, '');
                    const mensajeRelay  = textoAdmin.slice(saltoLinea + 1).trim();

                    if (!numeroDestino || !mensajeRelay) {
                        await enviarTexto(from, "⚠️ No pude leer el número o el mensaje. Verifica el formato.");
                        return res.sendStatus(200);
                    }

                    try {
                        await hacerPeticionWA({
                            messaging_product: "whatsapp",
                            to:   numeroDestino,
                            type: "text",
                            text: { body: mensajeRelay }
                        });
                        await enviarTexto(from, `✅ Mensaje enviado a +${numeroDestino}`);
                        console.log(`[RELAY TEXTO] Admin (+${from}) → +${numeroDestino}`);
                    } catch (e) {
                        await enviarTexto(from, `❌ Error al enviar a +${numeroDestino}: ${e.message}`);
                    }
                    return res.sendStatus(200);
                }
            }

            // ── RELAY DE IMAGEN: caption debe comenzar con "#52..." ──
            if (message.type === 'image') {
                const mediaId = message.image?.id;
                const caption = (message.image?.caption ?? '').trim();

                if (caption.startsWith('#')) {
                    const primeraLinea  = caption.split(/\s|\n/)[0];
                    const numeroDestino = primeraLinea.slice(1).replace(/[\s+\-()]/g, '');
                    const textoExtra    = caption.slice(primeraLinea.length).trim();

                    try {
                        await hacerPeticionWA({
                            messaging_product: "whatsapp",
                            to:   numeroDestino,
                            type: "image",
                            image: {
                                id: mediaId,
                                ...(textoExtra && { caption: textoExtra })
                            }
                        });
                        await enviarTexto(from, `✅ Imagen enviada a +${numeroDestino}`);
                        console.log(`[RELAY IMAGEN] Admin (+${from}) → +${numeroDestino} | media_id: ${mediaId}`);
                    } catch (e) {
                        await enviarTexto(from, `❌ Error enviando imagen a +${numeroDestino}: ${e.message}`);
                    }
                } else {
                    await enviarTexto(from,
                        "📸 Para reenviar una imagen a un cliente, pon el número en el *caption* de la foto:\n\n" +
                        "_Ejemplo:_ `#52XXXXXXXXXX Aquí tu cotización`"
                    );
                }
                return res.sendStatus(200);
            }

            // ── RELAY DE DOCUMENTO/PDF: caption debe comenzar con "#52..." ──
            if (message.type === 'document') {
                const mediaId  = message.document?.id;
                const caption  = (message.document?.caption ?? '').trim();
                const filename = message.document?.filename ?? 'documento';

                if (caption.startsWith('#')) {
                    const primeraLinea  = caption.split(/\s|\n/)[0];
                    const numeroDestino = primeraLinea.slice(1).replace(/[\s+\-()]/g, '');
                    const textoExtra    = caption.slice(primeraLinea.length).trim();

                    try {
                        await hacerPeticionWA({
                            messaging_product: "whatsapp",
                            to:   numeroDestino,
                            type: "document",
                            document: {
                                id:       mediaId,
                                filename: filename,
                                ...(textoExtra && { caption: textoExtra })
                            }
                        });
                        await enviarTexto(from, `✅ Documento "${filename}" enviado a +${numeroDestino}`);
                        console.log(`[RELAY DOC] Admin (+${from}) → +${numeroDestino} | media_id: ${mediaId}`);
                    } catch (e) {
                        await enviarTexto(from, `❌ Error enviando documento a +${numeroDestino}: ${e.message}`);
                    }
                } else {
                    await enviarTexto(from,
                        "📄 Para reenviar un PDF/documento a un cliente, pon el número en el *caption* del archivo:\n\n" +
                        "_Ejemplo:_ `#52XXXXXXXXXX Cotización adjunta`"
                    );
                }
                return res.sendStatus(200);
            }

            // Cualquier otro tipo desde admin (audio, video, sticker) → ignorar
            return res.sendStatus(200);
        }
        // ══════════════════════════════════════════════════════════
        // FIN MICRO-CRM — a partir de aquí solo llegan clientes
        // ══════════════════════════════════════════════════════════

        const entrada      = obtenerEstado(from);
        const estadoActual = entrada?.estado ?? null;
        const datos        = entrada?.datos  ?? {};

        // ── Modo asesor: bot mudo + forward a TODOS los admins ──
        if (estadoActual === 'asesor') {
            refrescarActividad(from);
            console.log(`[ASESOR] Forwardeando mensaje de ${from} a admins`);
            await forwardMensajeCliente(from, message, 'asesor');
            return res.sendStatus(200);
        }

        // ── Lead hecho: avisar al cliente (solo 1 vez) + forward a TODOS los admins ──
        if (estadoActual === 'lead_hecho') {
            refrescarActividad(from);
            const yaAvisado = entrada?.yaAvisadoLeadHecho ?? false;
            if (!yaAvisado) {
                estadoUsuarios[from].yaAvisadoLeadHecho = true;
                guardarEstados(estadoUsuarios);
                await enviarTexto(from,
                    "Tu solicitud ya está en proceso 👍\n\n" +
                    "Un asesor de Plug&Go se pondrá en contacto contigo en breve por este mismo chat.\n\n" +
                    "_Si tienes alguna duda urgente, responde aquí y te atendemos._"
                );
            }
            await forwardMensajeCliente(from, message, 'lead_hecho');
            return res.sendStatus(200);
        }

        // ════════════════════════════════════════
        // BOTONES INTERACTIVOS
        // ════════════════════════════════════════
        if (message.type === 'interactive') {
            const interactiveData = message.interactive;

            if (interactiveData?.button_reply) {
                const botonID = interactiveData.button_reply.id;

                if (botonID === 'btn_paneles') {
                    setEstado(from, 'p1_tipo', { datos: {}, flujo: 'paneles' });
                    await enviarTexto(from, PREGUNTAS_PANELES[0].texto);

                } else if (botonID === 'btn_cargador') {
                    setEstado(from, 'c1_marca', { datos: {}, flujo: 'cargador' });
                    await enviarTexto(from, PREGUNTAS_CARGADOR[0].texto);

                } else if (['btn_220v', 'btn_127v', 'btn_nosabe_voltaje'].includes(botonID)) {
                    const voltajeMap = {
                        'btn_220v': '220V (dos fases)',
                        'btn_127v': '127V (contactos normales)'
                    };

                    if (botonID === 'btn_nosabe_voltaje') {
                        setEstado(from, 'c2b_foto_voltaje', { datos, flujo: 'cargador' });
                        await enviarTexto(from,
                            "Sin problema, te ayudamos a saberlo 🔍\n\n" +
                            "Puedes enviarnos cualquiera de estas opciones:\n\n" +
                            "📸 *Foto de tu medidor de luz* (la caja gris afuera de tu casa)\n" +
                            "📄 *Foto de tu recibo de luz* reciente\n" +
                            "⏭️ Escribe *omitir* y un asesor lo evalúa en la visita técnica"
                        );
                    } else {
                        const nuevosDatos = { ...datos, voltaje: voltajeMap[botonID] };
                        setEstado(from, 'c3_metros', { datos: nuevosDatos, flujo: 'cargador' });
                        await alertarActualizacionCargador(from, nuevosDatos, 2);
                        await enviarTexto(from, PREGUNTAS_CARGADOR[2].texto);
                    }

                } else {
                    await enviarMenuPrincipal(from);
                }
            }

        // ════════════════════════════════════════
        // IMAGEN
        // ════════════════════════════════════════
        } else if (message.type === 'image') {

            if (estadoActual === 'c2_voltaje') {
                const nuevosDatos = { ...datos, voltaje: 'Foto de medidor enviada' };
                setEstado(from, 'c3_metros', { datos: nuevosDatos, flujo: 'cargador' });
                await alertarActualizacionCargador(from, nuevosDatos, 2);
                await enviarTexto(from,
                    "📸 ¡Recibida! Nuestro equipo revisará tu instalación con la foto.\n\n" +
                    PREGUNTAS_CARGADOR[2].texto
                );

            } else if (estadoActual === 'c2b_foto_voltaje') {
                const nuevosDatos = { ...datos, voltaje: 'Foto enviada — pendiente revisión' };
                setEstado(from, 'c3_metros', { datos: nuevosDatos, flujo: 'cargador' });
                await alertarActualizacionCargador(from, nuevosDatos, 2);
                await enviarTexto(from,
                    "📸 ¡Listo, imagen recibida! Nuestro equipo la revisará y te dirá qué tipo de instalación tienes.\n\n" +
                    PREGUNTAS_CARGADOR[2].texto
                );

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

            if (esKeywordMenu(textoCliente)) {
                resetEstado(from);
                await enviarMenuPrincipal(from);
                return res.sendStatus(200);
            }

            if (!estadoActual && textoCliente.length < 2) {
                await enviarTexto(from,
                    "No entendí ese mensaje 😅\n\n" +
                    "Escribe *menú* para volver al inicio."
                );
                return res.sendStatus(200);
            }

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

            } else if (estadoActual === 'c2b_foto_voltaje') {
                const txt = textoCliente.toLowerCase();
                let voltaje = 'Por evaluar en visita técnica';
                if (txt.includes('omitir') || txt.includes('saltar') || txt.includes('después') || txt.includes('despues')) {
                    voltaje = 'Por evaluar en visita técnica';
                } else if (txt.includes('220') || txt.includes('dos fases')) {
                    voltaje = '220V (dos fases)';
                } else if (txt.includes('127') || txt.includes('110')) {
                    voltaje = '127V (contactos normales)';
                } else {
                    await enviarTexto(from,
                        "Para continuar puedes:\n\n" +
                        "📸 Mandarnos una *foto de tu medidor* o *recibo de luz*\n" +
                        "⏭️ Escribir *omitir* y un asesor lo evalúa en la visita"
                    );
                    return res.sendStatus(200);
                }
                const nuevosDatos = { ...datos, voltaje };
                setEstado(from, 'c3_metros', { datos: nuevosDatos, flujo: 'cargador' });
                await alertarActualizacionCargador(from, nuevosDatos, 2);
                await enviarTexto(from, PREGUNTAS_CARGADOR[2].texto);

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
                    "_¡Gracias por confiar en Plug&Go!_"
                );
                await alertarActualizacionCargador(from, datosFinal, 4);

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
// FORWARD DE MENSAJES DE CLIENTES A TODOS LOS ADMINS
// ═══════════════════════════════════════════════════════════════
async function forwardMensajeCliente(from, message, contexto) {
    const etiqueta = contexto === 'asesor' ? '🔵 *Conversación activa*' : '🟡 *Lead en proceso*';

    let preview = '';
    let tieneMedia = false;
    let mediaPayload = null;

    if (message.type === 'text') {
        preview = `💬 _"${message.text.body}"_`;

    } else if (message.type === 'image') {
        tieneMedia = true;
        preview = '🖼️ _[El cliente mandó una imagen]_';
        mediaPayload = {
            type: 'image',
            id:   message.image?.id,
            caption: message.image?.caption ?? ''
        };

    } else if (message.type === 'document') {
        tieneMedia = true;
        const fname = message.document?.filename ?? 'documento';
        preview = `📄 _[El cliente mandó un archivo: ${fname}]_`;
        mediaPayload = {
            type:     'document',
            id:       message.document?.id,
            filename: fname,
            caption:  message.document?.caption ?? ''
        };

    } else if (message.type === 'audio' || message.type === 'voice') {
        preview = '🎤 _[El cliente mandó un audio]_';

    } else if (message.type === 'video') {
        tieneMedia = true;
        preview = '🎥 _[El cliente mandó un video]_';
        mediaPayload = {
            type: 'video',
            id:   message.video?.id,
            caption: message.video?.caption ?? ''
        };

    } else if (message.type === 'sticker') {
        preview = '🃏 _[El cliente mandó un sticker]_';

    } else {
        preview = `❓ _[Tipo de mensaje: ${message.type}]_`;
    }

    const notif =
        `${etiqueta}\n` +
        `📱 Cliente: +${from}\n\n` +
        `${preview}\n\n` +
        `─────────────────\n` +
        `↩️ *Para responderle con texto:*\n` +
        `#${from}\n` +
        `Tu respuesta aquí\n\n` +
        `↩️ *Para imagen/PDF:* adjunta el archivo y pon en el caption:\n` +
        `\`#${from} texto opcional\``;

    // Notifica a TODOS los admins, no solo a uno
    await enviarATodosAdmins(notif);

    // Si el mensaje tiene media, se la reenviamos también a todos los admins
    if (tieneMedia && mediaPayload) {
        try {
            await Promise.all(ADMIN_LIST.map(num => hacerPeticionWA({
                messaging_product: "whatsapp",
                to:   num,
                type: mediaPayload.type,
                [mediaPayload.type]: {
                    id: mediaPayload.id,
                    ...(mediaPayload.caption && { caption: mediaPayload.caption }),
                    ...(mediaPayload.filename && { filename: mediaPayload.filename })
                }
            })));
        } catch (e) {
            console.error(`[FORWARD MEDIA] Error reenviando media a admins: ${e.message}`);
        }
    }
}

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
                    "¿Qué tal? Soy el asistente de *Plug&Go* ⚡\n\n" +
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
            footer: { text: "Escribe 'menú' para volver al inicio si lo necesitas." },
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
