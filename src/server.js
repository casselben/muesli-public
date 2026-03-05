const express = require('express');
const axios = require('axios');
const app = express();

require('dotenv').config();

// API configuration for Recall.ai
const RECALLAI_API_URL = process.env.RECALLAI_API_URL || 'https://api.recall.ai';
const RECALLAI_API_KEY = process.env.RECALLAI_API_KEY;

app.get('/start-recording', async (req, res) => {
    if (!RECALLAI_API_KEY) {
        console.error("RECALLAI_API_KEY is missing! Set it in .env file");
        return res.status(500).json({ status: 'error', message: 'RECALLAI_API_KEY is missing' });
    }
    console.log(`Creating upload token with API key: ${RECALLAI_API_KEY.slice(0,4)}...`);

    const url = `${RECALLAI_API_URL}/api/v1/sdk_upload/`;

    try {
        const response = await axios.post(url, {
            recording_config: {
                transcript: {
                    provider: {
                        assembly_ai_v3_streaming: {}
                    }
                },
                realtime_endpoints: [
                    {
                        type: "desktop_sdk_callback",
                        events: [
                            "participant_events.join",
                            "participant_events.update",
                            "participant_events.speech_on",
                            "participant_events.speech_off",
                            "video_separate_png.data",
                            "transcript.data",
                            "transcript.provider_data"
                        ]
                    },
                ],
            }
        }, {
            headers: { 'Authorization': `Token ${RECALLAI_API_KEY}` },
            timeout: 9000,
        });

        res.json({ status: 'success', upload_token: response.data.upload_token });
    } catch (e) {
        console.error("Error creating upload token:", JSON.stringify(e.errors || e.response?.data || e.message));
        res.status(500).json({ status: 'error', message: e.message });
    }
});

if (require.main === module) {
    const PORT_MIN = 13373;
    const PORT_MAX = 13382;

    function tryListen(port) {
        const server = app.listen(port, () => {
            console.log(`Server listening on http://localhost:${port}`);
        });
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE' && port < PORT_MAX) {
                server.close(() => tryListen(port + 1));
            }
        });
    }
    tryListen(PORT_MIN);
}

module.exports = app;
