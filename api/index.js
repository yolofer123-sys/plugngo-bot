const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const { WHATSAPP_TOKEN, VERIFY_TOKEN, PHONE_NUMBER_ID } = process.env;

// --- NUEVO: La puerta principal para comprobar que Vercel funciona ---
app.get('/', (req, res) => {
    res.send('🔌 El cerebro de Plug n Go está en línea y funcionando al 100%');
});

// 1. Endpoint para verificar el Webhook en Meta
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK VERIFICADO');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    } else {
        // --- NUEVO: Para que no marque error si entras desde tu navegador web ---
        res.status(200).send('Webhook de WhatsApp listo para recibir mensajes.');
    }
});

// 2. Endpoint para recibir mensajes
app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object) {
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
            const message = body.entry[0].changes[0].value.messages[0];
            const from = message.from; 
            
            if (message.type === 'text') {
                await enviarMenuPrincipal(from);
            } 
            else if (message.type === 'interactive') {
                const botonID = message.interactive.button_reply.id;
                
                if (botonID === 'btn_paneles') {
                    await enviarTexto(from, "¡Excelente! Para armarte una cotización precisa de paneles solares, por favor mándanos una foto de tu recibo de luz (por ambos lados) para analizar tu consumo.");
                } else if (botonID === 'btn_cargador') {
                    await enviarTexto(from, "¡Perfecto! Para tu cargador Nivel 2, ¿para qué marca de auto es (Tesla, BYD, Geely)? \n\nY cuéntame, ¿ya cuentas con preparación a 220v o tarifa PDBT en tu domicilio?");
                }
            }
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

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

// Exportamos la app para que Vercel la pueda ejecutar
module.exports = app;
