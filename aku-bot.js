const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// ==========================================
// 🔧 CONFIGURACIÓN INICIAL
// ==========================================

// Cache para mensajes
const msgCache = new NodeCache({ stdTTL: 3600 });

// Configuración del bot
const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
const almacen = JSON.parse(fs.readFileSync('./almacen.json', 'utf-8'));

// Configuración de Supabase
const supabaseConfig = JSON.parse(fs.readFileSync('./supabase-config.json', 'utf-8'));
const supabase = createClient(supabaseConfig.supabase_url, supabaseConfig.supabase_anon_key);

// ==========================================
// 👨‍💻 INFORMACIÓN DEL CREADOR (Hardcodeada)
// ==========================================
const CREADOR = {
    nombre: "Iván Ortuño",
    alias: "Deltabiew",
    numero: "14803864136@s.whatsapp.net",
    whatsapp: "221 986 1564",
    gmail: "deltafx.studio.pro@gmail.com",
    website: "ejemplo.com",
    cargo: "Creador y Desarrollador del Bot"
};

// ==========================================
// 📁 RUTAS Y CACHÉ
// ==========================================

// Ruta de las imágenes en Android
const RUTA_IMAGENES = '/data/data/com.termux/files/home/storage/shared/imagenes';
// Cache de imágenes
let cacheImagenes = [];

// Almacenamiento de conversaciones
const conversationHistory = {};

// ==========================================
// 🔑 CONFIGURACIÓN DE API KEYS Y MODELOS
// ==========================================

const API_KEYS = config.api_keys || [config.api_key];
let currentApiKeyIndex = 0;

const GEMINI_MODELS = [
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.0-flash-lite",
    "gemini-2.0-flash"
];

let currentModelIndex = 0;

// Palabras clave para detectar peticiones de imágenes (SOLO LÓGICA)
const PALABRAS_IMAGEN = [
    'ver', 'muestra', 'muéstrame', 'enseña', 'enséñame',
    'foto', 'fotografía', 'imagen', 'fotico', 'foticos',
    'cómo es', 'como es', 'catálogo', 'catalogo', 'galería',
    'quiero ver', 'puedo ver', 'enseñame', 'muestrame',
    'foto de', 'imagen de', 'fotografía de'
];

// ==========================================
// 🗄️ FUNCIONES DE SUPABASE
// ==========================================

/**
 * Normaliza un número de teléfono para usarlo como identificador
 */
function normalizePhoneNumber(phone) {
    // Eliminar el sufijo @s.whatsapp.net o @g.us
    let cleaned = phone.split('@')[0];
    // Eliminar espacios, guiones, paréntesis y el signo +
    cleaned = cleaned.replace(/[\s\-\(\)\+]/g, '');
    return cleaned;
}

/**
 * Obtiene o crea un registro del bot para un dueño específico
 */
async function getOrCreateBotRecord(ownerName, ownerNumber) {
    try {
        const normalizedNumber = normalizePhoneNumber(ownerNumber);
        
        // Buscar si ya existe
        const { data: existingBot, error: fetchError } = await supabase
            .from('bots')
            .select('*')
            .eq('owner_number', normalizedNumber)
            .single();

        if (existingBot) {
            console.log(`📊 Registro encontrado para ${ownerName} (${normalizedNumber})`);
            return existingBot;
        }

        // Si no existe, crear nuevo registro
        const { data: newBot, error: insertError } = await supabase
            .from('bots')
            .insert([{
                owner_name: ownerName,
                owner_number: normalizedNumber,
                is_paid: false,
                free_messages_used: 0,
                max_free_messages: 5
            }])
            .select()
            .single();

        if (insertError) {
            console.error('❌ Error al crear registro:', insertError);
            return null;
        }

        console.log(`✅ Nuevo bot registrado: ${ownerName} (${normalizedNumber})`);
        return newBot;

    } catch (error) {
        console.error('❌ Error en getOrCreateBotRecord:', error);
        return null;
    }
}

/**
 * Verifica si un usuario puede enviar más mensajes
 */
async function canSendMessage(ownerNumber) {
    try {
        const normalizedNumber = normalizePhoneNumber(ownerNumber);
        const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
        
        const botRecord = await getOrCreateBotRecord(config.owner_name, config.owner_number);
        
        if (!botRecord) {
            console.error('❌ No se pudo obtener el registro del bot');
            return { canSend: false, reason: 'Error al verificar el estado del bot' };
        }

        // Si está pagado, siempre puede enviar
        if (botRecord.is_paid) {
            // Verificar si el pago ha expirado
            if (botRecord.payment_expires_at && new Date(botRecord.payment_expires_at) < new Date()) {
                // El pago expiró, actualizar a no pagado
                await supabase
                    .from('bots')
                    .update({ is_paid: false })
                    .eq('owner_number', normalizedNumber);
                    
                return { 
                    canSend: botRecord.free_messages_used < botRecord.max_free_messages,
                    freeMessagesLeft: botRecord.max_free_messages - botRecord.free_messages_used,
                    isPaid: false,
                    reason: 'El pago ha expirado. Volviendo a modo gratuito.'
                };
            }
            
            return { 
                canSend: true, 
                freeMessagesLeft: 'ilimitado', 
                isPaid: true 
            };
        }

        // Si no está pagado, verificar mensajes gratuitos
        const canSendFree = botRecord.free_messages_used < botRecord.max_free_messages;
        const freeMessagesLeft = botRecord.max_free_messages - botRecord.free_messages_used;

        return {
            canSend: canSendFree,
            freeMessagesLeft,
            isPaid: false,
            reason: canSendFree ? null : 'Has alcanzado el límite de mensajes gratuitos. Contacta al administrador para continuar usando el bot.'
        };

    } catch (error) {
        console.error('❌ Error en canSendMessage:', error);
        return { canSend: false, reason: 'Error al verificar el estado del bot' };
    }
}

/**
 * Incrementa el contador de mensajes enviados
 */
async function incrementMessageCount(ownerNumber) {
    try {
        const normalizedNumber = normalizePhoneNumber(ownerNumber);
        const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
        
        // Obtener registro actual
        const { data: botRecord } = await supabase
            .from('bots')
            .select('*')
            .eq('owner_number', normalizedNumber)
            .single();

        if (!botRecord) return;

        // Actualizar contadores
        const updates = {
            total_messages_sent: (botRecord.total_messages_sent || 0) + 1,
            updated_at: new Date()
        };

        // Si no está pagado, incrementar mensajes gratuitos
        if (!botRecord.is_paid) {
            updates.free_messages_used = (botRecord.free_messages_used || 0) + 1;
        }

        await supabase
            .from('bots')
            .update(updates)
            .eq('owner_number', normalizedNumber);

        console.log(`📈 Mensaje #${updates.total_messages_sent} enviado. Gratuitos: ${updates.free_messages_used || botRecord.free_messages_used}/${botRecord.max_free_messages}`);

    } catch (error) {
        console.error('❌ Error al incrementar contador:', error);
    }
}

/**
 * Obtiene estadísticas del bot
 */
async function getBotStats() {
    try {
        const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
        const normalizedNumber = normalizePhoneNumber(config.owner_number);
        
        const { data: botRecord } = await supabase
            .from('bots')
            .select('*')
            .eq('owner_number', normalizedNumber)
            .single();

        if (!botRecord) return null;

        return {
            isPaid: botRecord.is_paid,
            freeMessagesUsed: botRecord.free_messages_used,
            maxFreeMessages: botRecord.max_free_messages,
            totalMessagesSent: botRecord.total_messages_sent,
            freeMessagesLeft: botRecord.is_paid ? 'ilimitado' : botRecord.max_free_messages - botRecord.free_messages_used,
            planType: botRecord.plan_type || 'free',
            paymentExpiresAt: botRecord.payment_expires_at
        };

    } catch (error) {
        console.error('❌ Error al obtener estadísticas:', error);
        return null;
    }
}

// ==========================================
// 🤖 FUNCIONES DE GEMINI (Originales mejoradas)
// ==========================================

function getNextApiKey() {
    const key = API_KEYS[currentApiKeyIndex];
    currentApiKeyIndex = (currentApiKeyIndex + 1) % API_KEYS.length;
    console.log(`🔑 Usando API Key ${currentApiKeyIndex}/${API_KEYS.length}`);
    return key;
}

async function queryGeminiWithRetry(requestBody, maxRetries = 3) {
    let attempts = 0;
    let lastError = null;

    for (let modelAttempt = 0; modelAttempt < GEMINI_MODELS.length; modelAttempt++) {
        const currentModel = GEMINI_MODELS[currentModelIndex];

        for (let keyAttempt = 0; keyAttempt < API_KEYS.length; keyAttempt++) {
            const apiKey = getNextApiKey();
            const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent`;

            try {
                console.log(`🤖 Intentando con modelo: ${currentModel} y API Key ${currentApiKeyIndex}/${API_KEYS.length}`);

                const response = await axios.post(`${GEMINI_URL}?key=${apiKey}`, requestBody, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 30000
                });

                if (response.data?.candidates?.[0]) {
                    return response.data.candidates[0].content.parts[0].text;
                }

            } catch (error) {
                lastError = error;
                console.log(`❌ Error con modelo ${currentModel} y API Key ${currentApiKeyIndex}:`, error.message);

                if (error.response?.status === 429) {
                    console.log(`⚠️ Cuota agotada, cambiando configuración...`);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }

        currentModelIndex = (currentModelIndex + 1) % GEMINI_MODELS.length;
    }

    throw lastError || new Error("Todos los intentos fallaron");
}

// ==========================================
// 🖼️ FUNCIONES DE IMÁGENES (Originales)
// ==========================================

function actualizarCacheImagenes() {
    try {
        if (!fs.existsSync(RUTA_IMAGENES)) {
            console.log(`⚠️ La carpeta ${RUTA_IMAGENES} no existe`);
            fs.mkdirSync(RUTA_IMAGENES, { recursive: true });
            console.log(`✅ Carpeta creada: ${RUTA_IMAGENES}`);
            cacheImagenes = [];
            return;
        }

        const archivos = fs.readdirSync(RUTA_IMAGENES);
        cacheImagenes = archivos.filter(file =>
            file.toLowerCase().endsWith('.jpg') ||
            file.toLowerCase().endsWith('.jpeg') ||
            file.toLowerCase().endsWith('.png') ||
            file.toLowerCase().endsWith('.gif') ||
            file.toLowerCase().endsWith('.webp')
        ).map(file => {
            const nombreSinExtension = path.parse(file).name.toLowerCase();
            const palabrasClave = nombreSinExtension.split(/[_\-\s]+/);

            return {
                nombre: file,
                ruta: path.join(RUTA_IMAGENES, file),
                nombreLimpio: nombreSinExtension,
                palabrasClave: palabrasClave,
                tamaño: fs.statSync(path.join(RUTA_IMAGENES, file)).size
            };
        });

        console.log(`🖼️ Cache actualizado: ${cacheImagenes.length} imágenes disponibles`);
    } catch (error) {
        console.error("Error al actualizar cache:", error);
        cacheImagenes = [];
    }
}

function getBusinessContext() {
    let context = `Nombre del bot: ${config.bot_name}\n`;
    context += `Versión: ${config.bot_version}\n`;
    context += `Dueño del bot: ${config.owner_name}\n`;
    context += `Número del dueño: ${config.owner_number}\n`;
    context += `Negocio: ${config.business_name}\n`;
    context += `Tipo de negocio: ${config.business_type}\n`;
    if (config.business_country) context += `País: ${config.business_country}\n`;
    context += `\nPersonalidad: ${config.personality}\n\n`;

    if (almacen.length > 0) {
        context += "Información importante del negocio:\n";
        almacen.forEach(item => {
            context += `- ${item}\n`;
        });
    }

    return context;
}

function cleanHistory(userId) {
    if (!conversationHistory[userId]) conversationHistory[userId] = [];
    if (conversationHistory[userId].length > config.max_memory) {
        conversationHistory[userId] = conversationHistory[userId].slice(-config.max_memory);
    }
}

function detectarPeticionImagen(mensaje) {
    const mensajeLower = mensaje.toLowerCase();
    const esImagen = PALABRAS_IMAGEN.some(p => mensajeLower.includes(p));

    if (!esImagen) {
        return { esImagen: false, producto: null };
    }

    let textoLimpio = mensajeLower;
    const frasesImagen = [
        "quiero ver", "puedo ver", "muéstrame", "muestrame",
        "enséñame", "enseñame", "imagen de", "foto de"
    ];

    frasesImagen.forEach(frase => {
        const regex = new RegExp(frase, "g");
        textoLimpio = textoLimpio.replace(regex, " ");
    });

    const palabrasVacias = [
        'ver', 'imagen', 'foto', 'fotografía',
        'el', 'la', 'los', 'las', 'un', 'una',
        'de', 'del', 'para', 'con', 'por', 'en'
    ];

    palabrasVacias.forEach(palabra => {
        const regex = new RegExp(`\\b${palabra}\\b`, "g");
        textoLimpio = textoLimpio.replace(regex, " ");
    });

    textoLimpio = textoLimpio.replace(/\s+/g, " ").trim();

    if (!textoLimpio) {
        return { esImagen: true, producto: null };
    }

    return {
        esImagen: true,
        producto: textoLimpio,
        palabrasClaves: textoLimpio.split(" ")
    };
}

function buscarImagenPorProducto(producto, palabrasClaves = []) {
    if (cacheImagenes.length === 0) return [];

    const productoLower = producto.toLowerCase();
    const todasPalabras = [productoLower, ...palabrasClaves.map(p => p.toLowerCase())];
    const resultados = [];

    cacheImagenes.forEach(img => {
        let puntuacion = 0;
        let coincidencias = [];

        if (img.nombreLimpio === productoLower) {
            puntuacion += 100;
            coincidencias.push('exacta');
        }

        if (img.nombreLimpio.includes(productoLower)) {
            puntuacion += 50;
            coincidencias.push('incluye');
        }

        todasPalabras.forEach(palabra => {
            img.palabrasClave.forEach(palabraImg => {
                if (palabraImg === palabra) {
                    puntuacion += 30;
                    coincidencias.push(palabra);
                } else if (palabraImg.includes(palabra) || palabra.includes(palabraImg)) {
                    puntuacion += 15;
                    coincidencias.push(`parcial:${palabra}`);
                }
            });
        });

        if (productoLower.endsWith('s') && productoLower.slice(0, -1) === img.nombreLimpio) {
            puntuacion += 25;
            coincidencias.push('plural-singular');
        }
        if (img.nombreLimpio.endsWith('s') && img.nombreLimpio.slice(0, -1) === productoLower) {
            puntuacion += 25;
            coincidencias.push('singular-plural');
        }

        const coincidenciasUnicas = new Set(coincidencias.filter(c => !c.includes('parcial')));
        if (coincidenciasUnicas.size > 1) {
            puntuacion += 10 * coincidenciasUnicas.size;
        }

        if (puntuacion > 0) {
            resultados.push({
                ...img,
                puntuacion: puntuacion,
                coincidencias: coincidencias
            });
        }
    });

    resultados.sort((a, b) => b.puntuacion - a.puntuacion);
    console.log(`🔍 Búsqueda para "${producto}": ${resultados.length} resultados`);

    return resultados;
}

async function generarTextoParaImagen(producto, nombreImagen, mensajeOriginal, userId) {
    try {
        const productoReal = nombreImagen
            .replace(/\.[^/.]+$/, "")
            .replace(/[-_]/g, " ");

        const prompt = `Eres un vendedor amigable y entusiasta de "${config.business_name}", un negocio de ${config.business_type}.

CONTEXTO IMPORTANTE:
- El usuario pidió: "${mensajeOriginal}"
- Has encontrado y vas a enviar la imagen: "${nombreImagen}"
- Esta imagen corresponde al producto: "${productoReal}"

INSTRUCCIONES ESPECÍFICAS:
1. Genera un mensaje CORTO (máximo 80 caracteres) para acompañar la imagen
2. El mensaje debe ser natural, como si estuvieras hablando por WhatsApp
3. Menciona el producto específico "${productoReal}"
4. Puedes usar emojis relacionados (🛍️, 🎁, ✨, 👕, etc.) pero solo 1 o 2 máximo
5. NO expliques nada, solo saluda y ofrece el producto

EJEMPLOS DE BUENOS MENSAJES:
- "¡Justo tengo este ${productoReal} disponible! ¿Te gusta? 🛍️"
- "Mira qué bonito es nuestro ${productoReal} ✨"
- "Aquí tienes el ${productoReal} que mencionaste 📸"
- "Este ${productoReal} está en stock, ¿qué opinas? 👀"

RESPONDE SOLO CON EL MENSAJE, NADA MÁS.`;

        const requestBody = {
            contents: [{
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                maxOutputTokens: 50,
                temperature: 0.7,
            }
        };

        const texto = await queryGeminiWithRetry(requestBody);
        let textoLimpio = texto.trim();
        if (textoLimpio.length > 100) {
            textoLimpio = textoLimpio.substring(0, 97) + '...';
        }

        console.log(`✨ Texto generado para ${nombreImagen}: "${textoLimpio}"`);
        return textoLimpio;

    } catch (error) {
        console.error("Error generando texto para imagen:", error);
        const productoReal = nombreImagen.replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ");
        return `📸 Aquí tienes nuestro ${productoReal}`;
    }
}

async function enviarImagen(sock, sender, imagen, producto, mensajeOriginal) {
    try {
        const imagenBuffer = fs.readFileSync(imagen.ruta);
        const textoAcompañante = await generarTextoParaImagen(
            producto,
            imagen.nombre,
            mensajeOriginal,
            sender
        );

        await sock.sendMessage(sender, {
            image: imagenBuffer,
            caption: `🖼️ *${textoAcompañante}*`
        });

        console.log(`✅ Imagen enviada: ${imagen.nombre} a ${sender}`);
        return true;

    } catch (error) {
        console.error("Error al enviar imagen:", error);
        await sock.sendMessage(sender, {
            text: "❌ Error al enviar la imagen. Intenta más tarde."
        });
        return false;
    }
}

// ==========================================
// 📋 COMANDOS ESPECIALES (Actualizados)
// ==========================================

async function procesarComandoEspecial(mensaje, sender) {
    const comando = mensaje.toLowerCase().trim();

    // Comando de información del creador (Actualizado con nueva info)
    if (comando === '!creador' || comando === '!creator' || comando === '!owner' || comando === '/creador') {
        return `👨‍💻 *INFORMACIÓN DEL CREADOR*\n\n` +
               `📌 *Nombre:* ${CREADOR.nombre}\n` +
               `🔰 *Alias:* ${CREADOR.alias}\n` +
               `📱 *WhatsApp:* +${CREADOR.whatsapp}\n` +
               `📧 *Gmail:* ${CREADOR.gmail}\n` +
               `🌐 *Web:* ${CREADOR.website}\n` +
               `👔 *Cargo:* ${CREADOR.cargo}\n\n` +
               `✨ *Bot creado con ❤️ por ${CREADOR.nombre}*`;
    }

    // Comando para ver estadísticas del bot (NUEVO)
    if (comando === '!stats' || comando === '!estado' || comando === '!estadisticas') {
        const stats = await getBotStats();
        if (!stats) {
            return `❌ No se pudieron obtener las estadísticas.`;
        }

        let mensaje = `📊 *ESTADÍSTICAS DEL BOT*\n\n`;
        mensaje += `💳 *Plan:* ${stats.isPaid ? 'PREMIUM 💎' : 'GRATUITO 🆓'}\n`;
        mensaje += `📨 *Mensajes totales enviados:* ${stats.totalMessagesSent}\n`;
        
        if (!stats.isPaid) {
            mensaje += `🎁 *Mensajes gratuitos usados:* ${stats.freeMessagesUsed}/${stats.maxFreeMessages}\n`;
            mensaje += `✨ *Mensajes gratuitos restantes:* ${stats.freeMessagesLeft}\n`;
        } else {
            mensaje += `✨ *Mensajes restantes:* ILIMITADOS\n`;
            if (stats.paymentExpiresAt) {
                const fecha = new Date(stats.paymentExpiresAt);
                mensaje += `📅 *Pago válido hasta:* ${fecha.toLocaleDateString('es-MX')}\n`;
            }
        }

        if (!stats.isPaid && stats.freeMessagesLeft === 0) {
            mensaje += `\n⚠️ *Has alcanzado el límite de mensajes gratuitos.*\n`;
            mensaje += `💎 Contacta al administrador para activar el plan premium.`;
        }

        return mensaje;
    }

    // Comando para ver información de pago (NUEVO)
    if (comando === '!pago' || comando === '!premium' || comando === '!comprar') {
        return `💎 *INFORMACIÓN DE PAGO*\n\n` +
               `Para continuar usando el bot sin límites, contacta al administrador:\n\n` +
               `👤 *${CREADOR.nombre}*\n` +
               `📱 *WhatsApp:* +${CREADOR.whatsapp}\n` +
               `📧 *Gmail:* ${CREADOR.gmail}\n\n` +
               `✨ *Beneficios del plan premium:*\n` +
               `✅ Mensajes ilimitados\n` +
               `✅ Sin límites de caracteres\n` +
               `✅ Soporte prioritario\n` +
               `✅ Acceso a todas las funciones`;
    }

    if (comando === '!modelos' || comando === '!models') {
        let modelosInfo = `🤖 *MODELOS DE IA DISPONIBLES*\n\n`;
        modelosInfo += `Modelo actual: *${GEMINI_MODELS[currentModelIndex]}*\n`;
        modelosInfo += `API Keys disponibles: *${API_KEYS.length}*\n\n`;
        modelosInfo += `📋 *Lista completa:*\n`;
        GEMINI_MODELS.forEach((modelo, index) => {
            const emoji = index === currentModelIndex ? '✅' : '⭕';
            modelosInfo += `${emoji} ${modelo}\n`;
        });
        return modelosInfo;
    }

    if (comando === '!apis' || comando === '!apikeys') {
        return `🔑 *API KEYS DISPONIBLES*\n\nTotal: *${API_KEYS.length}* keys configuradas\nKey actual: ${currentApiKeyIndex + 1}/${API_KEYS.length}`;
    }

    if (comando.startsWith('!cambiar_modelo') || comando.startsWith('!switch')) {
        const partes = comando.split(' ');
        if (partes.length > 1) {
            const nombreModelo = partes.slice(1).join(' ');
            const index = GEMINI_MODELS.findIndex(m => m.toLowerCase().includes(nombreModelo.toLowerCase()));
            if (index !== -1) {
                currentModelIndex = index;
                return `✅ Modelo cambiado a: *${GEMINI_MODELS[currentModelIndex]}*`;
            } else {
                return `❌ Modelo no encontrado. Usa *!modelos* para ver la lista.`;
            }
        } else {
            currentModelIndex = (currentModelIndex + 1) % GEMINI_MODELS.length;
            return `🔄 Modelo cambiado a: *${GEMINI_MODELS[currentModelIndex]}*`;
        }
    }

    if (comando === '!imagenes' || comando === '!catalogo') {
        if (cacheImagenes.length === 0) {
            return "📁 No hay imágenes disponibles en este momento.";
        }
        let lista = `🖼️ *CATÁLOGO DE IMÁGENES*\n\n`;
        lista += `Total: ${cacheImagenes.length} imágenes\n\n`;
        lista += cacheImagenes.slice(0, 20).map((img, i) => `${i+1}. ${img.nombre}`).join('\n');
        if (cacheImagenes.length > 20) {
            lista += `\n... y ${cacheImagenes.length - 20} más`;
        }
        return lista;
    }

    // Comando de ayuda (NUEVO)
    if (comando === '!ayuda' || comando === '!help' || comando === '!comandos') {
        return `📚 *COMANDOS DISPONIBLES*\n\n` +
               `🤖 *Comandos generales:*\n` +
               `!creador - Información del creador\n` +
               `!stats - Ver estadísticas del bot\n` +
               `!pago - Información de planes premium\n` +
               `!ayuda - Mostrar esta ayuda\n\n` +
               `🖼️ *Comandos de imágenes:*\n` +
               `!catalogo - Ver catálogo de imágenes\n` +
               `!imagenes - Lista de imágenes disponibles\n\n` +
               `🔧 *Comandos avanzados:*\n` +
               `!modelos - Ver modelos de IA disponibles\n` +
               `!cambiar_modelo - Cambiar modelo de IA\n\n` +
               `💬 *Uso en grupos:*\n` +
               `Menciona al bot por su nombre para que responda.`;
    }

    return null;
}

// ==========================================
// 🤖 CONSULTA A GEMINI (Original)
// ==========================================

async function queryGemini(userMessage, userId) {
    try {
        if (!conversationHistory[userId]) conversationHistory[userId] = [];
        cleanHistory(userId);

        let fullContext = getBusinessContext();
        if (conversationHistory[userId].length > 0) {
            fullContext += "\nHistorial de la conversación actual:\n";
            conversationHistory[userId].forEach(msg => {
                fullContext += `${msg.role}: ${msg.content}\n`;
            });
        }

        const requestBody = {
            contents: [{
                parts: [{
                    text: `${fullContext}\nUsuario: ${userMessage}\nAsistente: `
                }]
            }],
            generationConfig: {
                maxOutputTokens: config.max_characters,
                temperature: 0.7,
                topP: 0.8,
                topK: 40
            }
        };

        const botResponse = await queryGeminiWithRetry(requestBody);

        conversationHistory[userId].push({ role: "usuario", content: userMessage });
        conversationHistory[userId].push({ role: "asistente", content: botResponse });
        cleanHistory(userId);

        return botResponse;

    } catch (error) {
        console.error("Error fatal en queryGemini:", error);
        return "❌ Lo siento, todos los modelos de IA están temporalmente agotados. Por favor, espera unos minutos.";
    }
}

// ==========================================
// 📨 PROCESAMIENTO DE MENSAJES (Actualizado)
// ==========================================

async function procesarMensaje(sock, text, sender) {
    try {
        // Verificar si es un comando especial (estos son gratuitos siempre)
        const esComando = text.toLowerCase().trim().startsWith('!') || 
                         text.toLowerCase().trim().startsWith('/');
        
        if (esComando) {
            const comandoRespuesta = await procesarComandoEspecial(text, sender);
            if (comandoRespuesta) {
                await sock.sendMessage(sender, { text: comandoRespuesta });
                return;
            }
        }

        // Para mensajes normales, verificar límites
        const canSend = await canSendMessage(config.owner_number);
        
        if (!canSend.canSend) {
            await sock.sendMessage(sender, { 
                text: `⚠️ ${canSend.reason}\n\nUsa *!pago* para ver información sobre planes premium.` 
            });
            return;
        }

        // Procesar el mensaje normalmente
        const { esImagen, producto, palabrasClaves } = detectarPeticionImagen(text);

        if (esImagen && producto) {
            console.log(`🖼️ Petición de imagen detectada por LÓGICA: producto="${producto}"`);

            const resultados = buscarImagenPorProducto(producto, palabrasClaves || []);

            if (resultados.length > 0) {
                await enviarImagen(sock, sender, resultados[0], producto, text);
            } else {
                const response = await queryGemini(
                    `El usuario pidió: "${text}" pero no tengo imágenes de ${producto}. Responde amablemente que no tenemos ese producto actualmente, pero podemos ofrecerte otros productos.`,
                    sender
                );
                await sock.sendMessage(sender, { text: response });
            }
        } else {
            const response = await queryGemini(text, sender);
            await sock.sendMessage(sender, { text: response });
        }

        // Incrementar contador de mensajes
        await incrementMessageCount(config.owner_number);

        // Mostrar recordatorio cuando queden pocos mensajes
        const stats = await getBotStats();
        if (stats && !stats.isPaid && stats.freeMessagesLeft === 2) {
            await sock.sendMessage(sender, { 
                text: `⚠️ *Aviso importante:* Te quedan solo 2 mensajes gratuitos.\n\nUsa *!pago* para conocer los planes premium y continuar usando el bot sin límites.` 
            });
        }

    } catch (error) {
        console.error('Error al procesar mensaje:', error);
        await sock.sendMessage(sender, { text: "❌ Error procesando tu mensaje. Intenta de nuevo." });
    }
}

// ==========================================
// 🔌 CONEXIÓN A WHATSAPP
// ==========================================

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('Escanea este QR con WhatsApp:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log(`✅ Bot conectado: ${config.bot_name} v${config.bot_version}`);
            console.log(`👤 Dueño: ${config.owner_name}`);
            console.log(`🏪 Negocio: ${config.business_name}`);
            console.log(`👨‍💻 Creador: ${CREADOR.nombre}`);
            console.log(`🖼️ Imágenes en catálogo: ${cacheImagenes.length}`);
            console.log(`🔑 API Keys disponibles: ${API_KEYS.length}`);
            console.log(`📂 Ruta: ${RUTA_IMAGENES}`);
            
            // Verificar estado en Supabase al conectar
            const botRecord = await getOrCreateBotRecord(config.owner_name, config.owner_number);
            if (botRecord) {
                console.log(`📊 Estado del bot: ${botRecord.is_paid ? 'PREMIUM 💎' : 'GRATUITO 🆓'}`);
                if (!botRecord.is_paid) {
                    console.log(`📨 Mensajes gratuitos: ${botRecord.free_messages_used}/${botRecord.max_free_messages}`);
                }
            }
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason === DisconnectReason.loggedOut) {
                console.log('⚠️ Sesión cerrada');
            } else {
                console.log('🔄 Reconectando...');
                connectToWhatsApp();
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const text = m.message.conversation ||
                    m.message.extendedTextMessage?.text ||
                    m.message.imageMessage?.caption || '';

        const sender = m.key.remoteJid;

        if (!text) return;

        const esGrupo = sender.endsWith('@g.us');
        const nombreBot = config.bot_name.toLowerCase();
        const regex = new RegExp(`\\b${nombreBot}\\b`, "i");
        const mencionaBot = regex.test(text);

        console.log(`📩 Mensaje de ${sender}: "${text}"`);

        if (esGrupo && !mencionaBot) return;

        await sock.sendPresenceUpdate('composing', sender);
        await procesarMensaje(sock, text, sender);
    });
}

// ==========================================
// 🚀 INICIALIZACIÓN
// ==========================================

// Inicializar cache de imágenes
actualizarCacheImagenes();

// Actualizar cache cada 5 minutos
setInterval(actualizarCacheImagenes, 5 * 60 * 1000);

// Iniciar bot
console.log(`🚀 Iniciando ${config.bot_name} v${config.bot_version}`);
console.log(`👨‍💻 Creado por ${CREADOR.nombre} (${CREADOR.whatsapp})`);
console.log(`🖼️ Escaneando imágenes en: ${RUTA_IMAGENES}`);
console.log(`🔑 Sistema de rotación de API Keys activado (${API_KEYS.length} keys disponibles)`);
console.log(`🗄️ Supabase conectado: ${supabaseConfig.supabase_url}`);
console.log('📱 Escanea el QR para conectar\n');

// Verificar conexión a Supabase
supabase.from('bots').select('count', { count: 'exact', head: true })
    .then(() => console.log('✅ Conexión a Supabase exitosa'))
    .catch(err => console.error('❌ Error conectando a Supabase:', err.message));

connectToWhatsApp().catch(error => {
    console.error('Error fatal:', error);
    process.exit(1);
});
