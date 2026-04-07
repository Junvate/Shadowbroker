const WebSocket = require('ws');
const readline = require('readline');
const fs = require('fs');

const args = process.argv.slice(2);
const API_KEY = args[0] || process.env.AIS_API_KEY;

if (!API_KEY) {
    console.error("FATAL: AIS_API_KEY is not set. WebSocket proxy cannot start.");
    process.exit(1);
}

// Start with global coverage, until frontend updates it
let currentBboxes = [[[-90, -180], [90, 180]]];
let activeWs = null;
let useInsecureTls = ['1', 'true', 'yes'].includes(
    String(process.env.AIS_TLS_ALLOW_INSECURE || '').toLowerCase()
);
let certFallbackUsed = false;
const autoFallbackEnabled = !['0', 'false', 'no'].includes(
    String(process.env.AIS_TLS_AUTO_FALLBACK || 'true').toLowerCase()
);
const customCaFile = String(process.env.AIS_CA_CERT_FILE || '').trim();

function isCertError(err) {
    const msg = String((err && err.message) || err || '').toLowerCase();
    return (
        msg.includes('unable to get local issuer certificate') ||
        msg.includes('unable to verify the first certificate') ||
        msg.includes('self signed certificate') ||
        msg.includes('certificate verify failed')
    );
}

function buildWsOptions() {
    const options = {
        rejectUnauthorized: !useInsecureTls
    };
    if (customCaFile) {
        try {
            options.ca = fs.readFileSync(customCaFile);
        } catch (e) {
            console.error(
                `AIS_CA_CERT_FILE could not be read (${customCaFile}): ${e.message}`
            );
        }
    }
    return options;
}

function sendSub(ws) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const subMsg = {
            APIKey: API_KEY,
            BoundingBoxes: currentBboxes,
            FilterMessageTypes: [
                "PositionReport",
                "ShipStaticData",
                "StandardClassBPositionReport"
            ]
        };
        ws.send(JSON.stringify(subMsg));
    }
}

// Listen for dynamic bounding box updates via stdin from Python orchestrator
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

rl.on('line', (line) => {
    try {
        const cmd = JSON.parse(line);
        if (cmd.type === "update_bbox" && cmd.bboxes) {
            currentBboxes = cmd.bboxes;
            if (activeWs) sendSub(activeWs); // Resend subscription (swap and replace)
        }
    } catch (e) {}
});

function connect() {
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream', buildWsOptions());
    activeWs = ws;

    ws.on('open', () => {
        if (useInsecureTls) {
            console.error(
                'AIS proxy connected with TLS verification disabled. ' +
                'Set AIS_TLS_ALLOW_INSECURE=false and provide AIS_CA_CERT_FILE to re-enable strict TLS.'
            );
        }
        sendSub(ws);
    });

    ws.on('message', (data) => {
        try {
            const parsed = JSON.parse(data);
            console.log(JSON.stringify(parsed));
        } catch (e) {}
    });

    ws.on('error', (err) => {
        console.error("WebSocket Proxy Error:", err.message);
        if (isCertError(err) && autoFallbackEnabled && !useInsecureTls && !certFallbackUsed) {
            certFallbackUsed = true;
            useInsecureTls = true;
            console.error(
                "AIS TLS cert verification failed; retrying with insecure TLS fallback. " +
                "This is for local recovery only."
            );
            try {
                ws.terminate();
            } catch (e) {}
        }
    });

    ws.on('close', () => {
        activeWs = null;
        console.error("WebSocket Proxy Closed. Reconnecting in 5s...");
        setTimeout(connect, 5000);
    });
}

connect();
