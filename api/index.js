const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const { WHATSAPP_TOKEN, VERIFY_TOKEN, PHONE_NUMBER_ID } = process.env;

// Memoria temporal para saber en qué paso de la cotización va cada cliente
const estadoUsuarios = {};

app.get('/', (req, res) => {
    res.send('🔌 El cerebro de Plug n Go está en línea.');
});

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    } else {
        res.status(200).send('Webhook listo.');
    }
});

app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object) {
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
            const message = body.entry[0].changes[0].value.messages[0];
            const from = message.from; 
            
            // 1. Si el cliente responde tocando un BOTÓN
            if (message.type === 'interactive') {
                const botonID = message.interactive.button_reply.id;
                
                if (botonID === 'btn_paneles') {
                    estadoUsuarios[from] = 'esperando_recibo';
                    await enviarTexto(from, "¡Excelente elección! ☀️\n\nPara armarte una cotización precisa de paneles solares, por favor mándanos una foto de tu recibo de luz (por ambos lados) o un PDF para analizar tu consumo bimestral.");
                } 
                else if (botonID === 'btn_cargador') {
                    estadoUsuarios[from] = 'esperando_detalles_cargador';
                    await enviarTexto(from, "¡Perfecto! ⚡️ Para cotizar la instalación de tu cargador Nivel 2, por favor respóndeme este mensaje con 2 datos:\n\n1. ¿Qué marca de auto es (Tesla, BYD, Geely, etc.)?\n2. ¿Ya cuentas con preparación eléctrica a 220v o tarifa PDBT en tu domicilio?");
                }
            }
            // 2. Si el cliente manda una IMAGEN (Ej. el recibo de luz)
            else if (message.type === 'image') {
                if (estadoUsuarios[from] === 'esperando_recibo') {
                    estadoUsuarios[from] = null; // Reiniciamos su estado
                    await enviarTexto(from, "¡Recibo de luz capturado! 📄✅\n\nNuestro equipo de ingeniería revisará tu historial de consumo. En breve te mandaremos tu corrida financiera y cotización formal por este medio. ¿Te puedo ayudar con algo más?");
                } else {
                    await enviarTexto(from, "Recibimos tu imagen, pero no estoy seguro de qué trata. Escribe 'Hola' para ver el menú de opciones.");
                }
            }
            // 3. Si el cliente manda TEXTO NORMAL
            else if (message.type === 'text') {
                const textoCliente = message.text.body;

                // Si estábamos esperando que nos diera los datos del cargador
                if (estadoUsuarios[from] === 'esperando_detalles_cargador') {
                    estadoUsuarios[from] = null; // Reiniciamos su estado
                    await enviarTexto(from, `¡Anotado! 📝\n\nCon esos datos del vehículo y tu instalación eléctrica actual, calcularemos el cableado y las protecciones necesarias. \n\nEn un momento te mandamos tu cotización de instalación de cargador Nivel 2. ¡Gracias por confiar en Plug n Go!`);
                } 
                // Si es un mensaje nuevo o no estábamos esperando nada
                else {
                    await enviarMenuPrincipal(from);
                }
            }
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// --- FUNCIONES QUE ARMAN LOS MENSAJES ---

async function enviarMenuPrincipal(to) {
    const data = {
        messaging_product: "whatsapp",
        to: to,
        type: "interactive",
        interactive: {
            type: "button",
            body: { text: "¡Hola! Bienvenido a Plug n Go ⚡. ¿Qué proyecto estás buscando hoy?" },
            action: {
                buttons: [
                    { type: "reply", reply: { id: "btn_paneles", title: "Paneles Solares" } },
                    { type: "reply", reply: { id: "btn_cargador", title: "Cargador Nivel 2" } }
                ]
            }
        }
    };
    await hacerPeticionWA(data);
}

async function enviarTexto(to, texto) {
    const data = {
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body: texto }
    };
    await hacerPeticionWA(data);
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
            data: data
        });
    } catch (error) {
        console.error("Error enviando mensaje:", error.response ? error.response.data : error.message);
    }
}

module.exports = app;
