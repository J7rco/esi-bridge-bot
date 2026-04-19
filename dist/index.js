import { createServer } from "node:http";
import { URL } from "node:url";
import { Client, Events, GatewayIntentBits, escapeMarkdown, } from "discord.js";
import "dotenv/config";
const OUTGOING_GUILD_DEDUPE_WINDOW_MS = 2_500;
const DISCORD_BROADCAST_HISTORY_LIMIT = 250;
const recentGuildMessages = new Map();
const discordBroadcastHistory = [];
let nextDiscordMessageId = 0;
let shuttingDown = false;
let shutdownPromise = null;
const config = readConfig();
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});
client.once(Events.ClientReady, (readyClient) => {
    console.log(`[discord-bot] logged in as ${readyClient.user.tag}`);
});
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || message.channelId !== config.discordChannelId) {
        return;
    }
    const content = resolveDiscordMessageContent(message);
    if (!content) {
        return;
    }
    enqueueDiscordBroadcast({
        authorName: resolveAuthorName(message),
        content,
        timestamp: Date.now(),
    });
});
const server = createServer(async (request, response) => {
    if (shuttingDown) {
        return writeJson(response, 503, { error: "shutting_down" });
    }
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.botHttpHost}:${config.botHttpPort}`}`);
    if (requestUrl.pathname === "/health") {
        return writeJson(response, 200, { ok: true });
    }
    if (request.method === "GET" && requestUrl.pathname === "/bridge/discord-poll") {
        if (!isAuthorized(request, config.bridgeSharedSecret)) {
            return writeJson(response, 401, { error: "unauthorized" });
        }
        return writeJson(response, 200, buildDiscordPollResponse(requestUrl));
    }
    if (request.method !== "POST" || requestUrl.pathname !== "/bridge/wynncraft-guild") {
        return writeJson(response, 404, { error: "not_found" });
    }
    if (!isAuthorized(request, config.bridgeSharedSecret)) {
        return writeJson(response, 401, { error: "unauthorized" });
    }
    try {
        const payload = parseGuildChatPayload(await readBody(request));
        if (isDuplicateGuildMessage(payload)) {
            return writeJson(response, 202, { ok: true, duplicate: true });
        }
        const channel = await client.channels.fetch(config.discordChannelId);
        if (!channel || !channel.isSendable()) {
            return writeJson(response, 503, { error: "channel_unavailable" });
        }
        await channel.send({
            content: formatGuildChatMessage(payload),
            allowedMentions: { parse: [] },
        });
        return writeJson(response, 202, { ok: true });
    }
    catch (error) {
        console.error("[discord-bot] failed to handle Wynncraft bridge payload", error);
        return writeJson(response, 400, { error: "invalid_payload" });
    }
});
async function start() {
    await client.login(config.discordToken);
    server.listen(config.botHttpPort, config.botHttpHost, () => {
        console.log(`[discord-bot] listening on http://${config.botHttpHost}:${config.botHttpPort}`);
    });
}
function registerShutdownHandlers() {
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => {
            void shutdown(signal);
        });
    }
}
async function shutdown(signal) {
    if (shutdownPromise) {
        return shutdownPromise;
    }
    shuttingDown = true;
    console.log(`[discord-bot] received ${signal}, shutting down gracefully`);
    shutdownPromise = (async () => {
        try {
            await closeHttpServer();
        }
        catch (error) {
            console.error("[discord-bot] failed closing HTTP server", error);
        }
        try {
            client.destroy();
        }
        catch (error) {
            console.error("[discord-bot] failed destroying Discord client", error);
        }
    })();
    await shutdownPromise;
    process.exit(0);
}
function closeHttpServer() {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}
void start().catch((error) => {
    console.error("[discord-bot] failed to start", error);
    process.exitCode = 1;
});
registerShutdownHandlers();
function readConfig() {
    const discordToken = requireEnv("DISCORD_TOKEN");
    const discordChannelId = requireEnv("DISCORD_CHANNEL_ID");
    const bridgeSharedSecret = requireEnv("BRIDGE_SHARED_SECRET");
    const botHttpHost = process.env.BOT_HTTP_HOST?.trim() || "127.0.0.1";
    const botHttpPort = parsePort(process.env.BOT_HTTP_PORT ?? "8787");
    return {
        discordToken,
        discordChannelId,
        bridgeSharedSecret,
        botHttpHost,
        botHttpPort,
    };
}
function requireEnv(name) {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
function parsePort(rawPort) {
    const port = Number.parseInt(rawPort, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${rawPort}`);
    }
    return port;
}
function resolveAuthorName(message) {
    return (message.member?.displayName || message.author.globalName || message.author.username).trim();
}
function resolveDiscordMessageContent(message) {
    const attachments = [...message.attachments.values()].map((attachment) => attachment.url);
    const combined = [message.content.trim(), ...attachments].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return combined.slice(0, 180);
}
function isAuthorized(request, sharedSecret) {
    return request.headers.authorization === `Bearer ${sharedSecret}`;
}
async function readBody(request) {
    const chunks = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
}
function parseGuildChatPayload(rawBody) {
    const parsed = JSON.parse(rawBody);
    if (parsed.kind !== "guild_chat"
        || typeof parsed.senderName !== "string"
        || typeof parsed.content !== "string"
        || typeof parsed.rawMessage !== "string"
        || typeof parsed.serverAddress !== "string"
        || typeof parsed.timestamp !== "number") {
        throw new Error("Malformed guild chat payload");
    }
    return parsed;
}
function formatGuildChatMessage(payload) {
    const sender = escapeMarkdown(payload.senderName);
    const content = payload.content.trim().slice(0, 1800);
    return `**${sender}**: ${content}`;
}
function enqueueDiscordBroadcast(payload) {
    discordBroadcastHistory.push({
        id: ++nextDiscordMessageId,
        ...payload,
    });
    while (discordBroadcastHistory.length > DISCORD_BROADCAST_HISTORY_LIMIT) {
        discordBroadcastHistory.shift();
    }
}
function buildDiscordPollResponse(requestUrl) {
    const since = parseCursor(requestUrl.searchParams.get("since"));
    if (since < 0) {
        return {
            messages: [],
            cursor: nextDiscordMessageId,
        };
    }
    return {
        messages: discordBroadcastHistory.filter((message) => message.id > since),
        cursor: nextDiscordMessageId,
    };
}
function parseCursor(rawCursor) {
    if (!rawCursor) {
        return 0;
    }
    const cursor = Number.parseInt(rawCursor, 10);
    if (Number.isNaN(cursor)) {
        return 0;
    }
    return cursor;
}
function isDuplicateGuildMessage(payload) {
    const now = Date.now();
    const dedupeKey = [
        payload.serverAddress.trim().toLowerCase(),
        payload.senderName.trim().toLowerCase(),
        payload.content.trim(),
        payload.rawMessage.trim(),
    ].join("\u0000");
    for (const [key, timestamp] of recentGuildMessages) {
        if (now - timestamp > OUTGOING_GUILD_DEDUPE_WINDOW_MS) {
            recentGuildMessages.delete(key);
        }
    }
    const previousTimestamp = recentGuildMessages.get(dedupeKey);
    if (previousTimestamp && now - previousTimestamp <= OUTGOING_GUILD_DEDUPE_WINDOW_MS) {
        return true;
    }
    recentGuildMessages.set(dedupeKey, now);
    return false;
}
function writeJson(response, statusCode, payload) {
    response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
}
