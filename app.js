const express = require('express');
const play = require('play-dl');
const yt = require('youtube-dl-exec');
const cors = require('cors');
const fs = require('fs'); // Módulo agregado para leer/escribir archivos

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// TRAMPA PARA YOUTUBE: Crear el archivo de cookies físicamente en el servidor
if (process.env.YOUTUBE_COOKIES) {
    // Reemplazamos los saltos de línea de texto plano a reales
    const rawCookies = process.env.YOUTUBE_COOKIES.replace(/\\n/g, '\n');
    fs.writeFileSync('cookies.txt', rawCookies);
    console.log("🍪 Cookies de YouTube inyectadas con éxito en el servidor");
}

function createToken(query, index) {
    const data = JSON.stringify({ q: query, i: index });
    return Buffer.from(data).toString('base64');
}

function decodeToken(base64Token) {
    try {
        const data = Buffer.from(base64Token, 'base64').toString('utf-8');
        return JSON.parse(data);
    } catch (e) {
        return null;
    }
}

app.get('/', (req, res) => res.send('Servidor Activo GAAAA'));

app.post('/alexa', async (req, res) => {
    const requestType = req.body.request.type;

    try {
        if (requestType === 'LaunchRequest') {
            return res.json({
                version: "1.0",
                response: {
                    outputSpeech: { type: "PlainText", text: "Bienvenido a tu música. ¿Qué quieres escuchar?" },
                    shouldEndSession: false
                }
            });
        }

        if (requestType === 'IntentRequest') {
            const intentName = req.body.request.intent.name;

            if (intentName === 'BuscarMusicaIntent') {
                const query = req.body.request.intent.slots.Cancion.value;
                console.log(`\n🎤 Alexa pide buscar: ${query}`);

                const searchResults = await play.search(query, { limit: 1 });
                if (!searchResults || searchResults.length === 0) throw new Error("No hay resultados");

                const video = searchResults[0];
                
                // Aquí aplicamos la trampa de las cookies al extractor
                const streamUrl = await yt(video.url, { 
                    getUrl: true, 
                    format: 'bestaudio',
                    ...(fs.existsSync('cookies.txt') && { cookies: 'cookies.txt' })
                });
                
                console.log(`✅ Audio listo: ${video.title}`);
                const tokenString = createToken(query, 0);

                return res.json({
                    version: "1.0",
                    response: {
                        outputSpeech: { type: "PlainText", text: `Reproduciendo ${video.title}` },
                        directives: [{
                            type: "AudioPlayer.Play",
                            playBehavior: "REPLACE_ALL",
                            audioItem: {
                                stream: { url: streamUrl, token: tokenString, offsetInMilliseconds: 0 }
                            }
                        }],
                        shouldEndSession: true
                    }
                });
            }

            if (intentName === 'AMAZON.PauseIntent' || intentName === 'AMAZON.StopIntent') {
                return res.json({
                    version: "1.0",
                    response: { directives: [{ type: "AudioPlayer.Stop" }], shouldEndSession: true }
                });
            }
            if (intentName === 'AMAZON.ResumeIntent') {
                return res.json({ version: "1.0", response: { shouldEndSession: true } });
            }
            
            if (intentName === 'AMAZON.NextIntent') {
                try {
                    const currentTokenStr = req.body.context?.AudioPlayer?.token;
                    if (!currentTokenStr) throw new Error("No hay token actual");
                    
                    const tokenData = decodeToken(currentTokenStr);
                    const query = tokenData.q;
                    const nextIndex = tokenData.i + 1;
                    
                    console.log(`\n⏭️ Saltando a la siguiente canción de: ${query}`);
                    
                    const searchResults = await play.search(query, { limit: nextIndex + 1 });
                    const nextVideo = searchResults[nextIndex];
                    
                    const streamUrl = await yt(nextVideo.url, { 
                        getUrl: true, 
                        format: 'bestaudio',
                        ...(fs.existsSync('cookies.txt') && { cookies: 'cookies.txt' })
                    });
                    
                    const nextTokenString = createToken(query, nextIndex);
                    
                    return res.json({
                        version: "1.0",
                        response: {
                            directives: [{
                                type: "AudioPlayer.Play",
                                playBehavior: "REPLACE_ALL",
                                audioItem: {
                                    stream: { url: streamUrl, token: nextTokenString, offsetInMilliseconds: 0 }
                                }
                            }],
                            shouldEndSession: true
                        }
                    });
                } catch (e) {
                    return res.json({ version: "1.0", response: { shouldEndSession: true } });
                }
            }
        }

        if (requestType === 'AudioPlayer.PlaybackNearlyFinished') {
            const currentTokenStr = req.body.request.token;
            const tokenData = decodeToken(currentTokenStr);
            
            if (tokenData) {
                const query = tokenData.q;
                const nextIndex = tokenData.i + 1;
                console.log(`\n🔄 Autoplay: Buscando la siguiente canción (Índice ${nextIndex}) para "${query}"...`);

                const searchResults = await play.search(query, { limit: nextIndex + 1 });
                
                if (searchResults && searchResults.length > nextIndex) {
                    const nextVideo = searchResults[nextIndex];
                    const streamUrl = await yt(nextVideo.url, { 
                        getUrl: true, 
                        format: 'bestaudio',
                        ...(fs.existsSync('cookies.txt') && { cookies: 'cookies.txt' })
                    });
                    console.log(`✅ Siguiente en cola: ${nextVideo.title}`);

                    const nextTokenString = createToken(query, nextIndex);

                    return res.json({
                        version: "1.0",
                        response: {
                            directives: [{
                                type: "AudioPlayer.Play",
                                playBehavior: "ENQUEUE",
                                audioItem: {
                                    stream: {
                                        url: streamUrl,
                                        token: nextTokenString,
                                        expectedPreviousToken: currentTokenStr,
                                        offsetInMilliseconds: 0
                                    }
                                }
                            }],
                            shouldEndSession: true
                        }
                    });
                }
            }
            return res.json({ version: "1.0", response: { shouldEndSession: true } });
        }

    } catch (error) {
        console.error('❌ Error general:', error.message);
        return res.json({
            version: "1.0",
            response: {
                outputSpeech: { type: "PlainText", text: "Hubo un problema procesando la música." },
                shouldEndSession: true
            }
        });
    }
});

app.listen(port, () => {
    console.log(`🚀 Servidor backend corriendo en http://localhost:${port}`);
});
