const express = require('express');
const SC = require('soundcloud-scraper');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Inicializar cliente de SoundCloud
let scClient = null;
let scKey = null;

async function initSoundCloud() {
    try {
        scKey = await SC.keygen();
        scClient = new SC.Client(scKey);
        console.log(`☁️ SoundCloud activado correctamente con API Key`);
    } catch (e) {
        console.error('❌ Error al inicializar SoundCloud:', e.message);
    }
}
initSoundCloud();

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

// Obtener el URL de audio via SoundCloud
async function getAudioUrlFromSoundCloud(query) {
    if (!scClient) throw new Error("SoundCloud no está inicializado");
    
    // Buscar en SoundCloud
    const searchResults = await scClient.search(query, 'track');
    if (!searchResults || searchResults.length === 0) throw new Error("No hay resultados en SoundCloud");
    
    const track = searchResults[0];
    const songInfo = await scClient.getSongInfo(track.url);
    
    // SoundCloud usa HLS (.m3u8) o Progressive. Alexa soporta HLS perfectamente.
    const streamApiUrl = songInfo.streams.hls + '?client_id=' + scKey;
    
    // Extraer el link real del JSON de la API
    const response = await fetch(streamApiUrl);
    if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
    
    const data = await response.json();
    return { url: data.url, title: track.title, thumbnail: track.thumbnail };
}

app.get('/', (req, res) => res.send('🚀 Servidor Activo en la Nube GAAAA'));

app.post('/alexa', async (req, res) => {
    const requestType = req.body.request.type;

    try {
        if (requestType === 'LaunchRequest') {
            return res.json({
                version: "1.0",
                response: {
                    outputSpeech: { type: "PlainText", text: "Bienvenido a tu música en la nube. ¿Qué quieres escuchar?" },
                    shouldEndSession: false
                }
            });
        }

        if (requestType === 'IntentRequest') {
            const intentName = req.body.request.intent.name;

            if (intentName === 'BuscarMusicaIntent') {
                const query = req.body.request.intent.slots.Cancion.value;
                console.log(`\n🎤 Alexa pide buscar: ${query}`);

                const trackInfo = await getAudioUrlFromSoundCloud(query);
                console.log(`🎵 Listo para reproducir: ${trackInfo.title}`);

                const tokenString = createToken(query, 0);

                return res.json({
                    version: "1.0",
                    response: {
                        outputSpeech: { type: "PlainText", text: `Reproduciendo ${trackInfo.title}` },
                        directives: [{
                            type: "AudioPlayer.Play",
                            playBehavior: "REPLACE_ALL",
                            audioItem: {
                                stream: { url: trackInfo.url, token: tokenString, offsetInMilliseconds: 0 }
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

                    console.log(`\n⏭️ Siguiente canción (${nextIndex}) de: ${query}`);

                    // Volver a buscar y coger el siguiente índice
                    const searchResults = await scClient.search(query, 'track');
                    if (searchResults.length <= nextIndex) throw new Error("No hay más resultados");
                    
                    const nextTrack = searchResults[nextIndex];
                    const songInfo = await scClient.getSongInfo(nextTrack.url);
                    const streamApiUrl = songInfo.streams.hls + '?client_id=' + scKey;
                    const response = await fetch(streamApiUrl);
                    const data = await response.json();
                    
                    const nextTokenString = createToken(query, nextIndex);

                    return res.json({
                        version: "1.0",
                        response: {
                            directives: [{
                                type: "AudioPlayer.Play",
                                playBehavior: "REPLACE_ALL",
                                audioItem: {
                                    stream: { url: data.url, token: nextTokenString, offsetInMilliseconds: 0 }
                                }
                            }],
                            shouldEndSession: true
                        }
                    });
                } catch (e) {
                    console.error('❌ Error en Next:', e.message);
                    return res.json({ version: "1.0", response: { shouldEndSession: true } });
                }
            }
        }

        if (requestType === 'AudioPlayer.PlaybackNearlyFinished') {
            const currentTokenStr = req.body.request.token;
            const tokenData = decodeToken(currentTokenStr);

            if (tokenData && scClient) {
                const query = tokenData.q;
                const nextIndex = tokenData.i + 1;
                console.log(`\n🔄 Autoplay: índice ${nextIndex} para "${query}"...`);

                const searchResults = await scClient.search(query, 'track');

                if (searchResults && searchResults.length > nextIndex) {
                    const nextTrack = searchResults[nextIndex];
                    const songInfo = await scClient.getSongInfo(nextTrack.url);
                    const streamApiUrl = songInfo.streams.hls + '?client_id=' + scKey;
                    
                    const response = await fetch(streamApiUrl);
                    if (response.ok) {
                        const data = await response.json();
                        console.log(`✅ Siguiente en cola: ${nextTrack.title}`);
                        const nextTokenString = createToken(query, nextIndex);

                        return res.json({
                            version: "1.0",
                            response: {
                                directives: [{
                                    type: "AudioPlayer.Play",
                                    playBehavior: "ENQUEUE",
                                    audioItem: {
                                        stream: {
                                            url: data.url,
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
            }
            return res.json({ version: "1.0", response: { shouldEndSession: true } });
        }

        return res.json({ version: "1.0", response: { shouldEndSession: true } });

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
