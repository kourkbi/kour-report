// ==UserScript==
// @name         Kour Report
// @namespace    https://kour.io/
// @version      2.0.0
// @description  Kour Report is a community-made userscript for Kour.io that helps players report cheaters and disruptive behavior directly from a match. Submit player reports with the room link and reason, contact the KBI team with Call KBI, and exchange messages with KBI through the built-in chat. Includes manual reporting, report history, message notifications, and configurable in-game controls. Not affiliated with Kour. Join the KBI Discord: https://discord.gg/Ke3a7ZZWMd
// @author       kourkbi
// @license      MIT
// @homepageURL  https://github.com/kourkbi/kour-report
// @updateURL    https://raw.githubusercontent.com/kourkbi/kour-report/main/kour-report.js
// @downloadURL  https://raw.githubusercontent.com/kourkbi/kour-report/main/kour-report.js
// @connect      raw.githubusercontent.com
// @match        *://kour.io/*
// @match        *://*.kour.io/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_info
// @grant        GM.info
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @icon         https://raw.githubusercontent.com/kourkbi/kour-report/main/assets/menu/report-icon.png
// ==/UserScript==

(() => {
    "use strict";

    /***************************************
     * Report API Endpoint
     ***************************************/
    // Production endpoint used when test mode is disabled:
    // https://kour-report-api.kourkbi.workers.dev/api/v2/report
    // Test mode automatically uses this endpoint when enabled in Settings; do not replace the production URL:
    // https://kour-report-api.kourkbi.workers.dev/api/v2/report/test
    // It routes submissions to the public test channel and does not save them in the production API history.
    const REPORT_API_URL = "https://kour-report-api.kourkbi.workers.dev/api/v2/report";
    const TEST_REPORT_API_URL = "https://kour-report-api.kourkbi.workers.dev/api/v2/report/test";
    const REPORT_TOKEN_API_URL = "https://kour-report-api.kourkbi.workers.dev/api/v2/report/token";
    const REPORT_HEALTH_API_URL = "https://kour-report-api.kourkbi.workers.dev/api/v2/health";
    const REPORT_MESSAGES_API_URL = "https://kour-report-api.kourkbi.workers.dev/api/v2/report/messages";
    const SCRIPT_VERSION = (() => {
        try {
            if (typeof GM_info !== "undefined" && GM_info?.script?.version) {
                return String(GM_info.script.version).trim();
            }
            if (typeof GM !== "undefined" && GM?.info?.script?.version) {
                return String(GM.info.script.version).trim();
            }
        } catch (error) {
            console.warn("[Kour Report] Could not detect the installed userscript version:", error);
        }
        return "";
    })();

    // Verification service.
    const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    const TURNSTILE_SITE_KEY = "0x4AAAAAAFh9F7Gz7tkh9rAD";

    // Community, source, and update links.
    const DISCORD_URL = "https://discord.gg/Ke3a7ZZWMd";
    const GITHUB_REPOSITORY_URL = "https://github.com/kourkbi/kour-report";
    const GITHUB_SCRIPT_FILE_URL = "https://github.com/kourkbi/kour-report/blob/main/kour-report.js";
    const GREASYFORK_SCRIPT_URL = "https://greasyfork.org/scripts/602206-kour-report";
    const CHANGELOG_URL = "https://raw.githubusercontent.com/kourkbi/kour-report/main/CHANGELOG.md";
    // Keep version.json synchronized with @version when publishing.
    const VERSION_URL = "https://raw.githubusercontent.com/kourkbi/kour-report/main/version.json";

    // Remote UI assets.
    const PLAYER_AVATAR_URL = "https://raw.githubusercontent.com/kourkbi/kour-report/main/assets/menu/player-avatar.jpg";
    const KBI_AVATAR_URL = "https://raw.githubusercontent.com/kourkbi/kour-report/refs/heads/main/assets/menu/kbi_icon_gold.jpg";
    const INFO_DIALOG_BANNER_URL = "https://raw.githubusercontent.com/kourkbi/kour-report/main/assets/menu/info-dialog-banner.jpg";
    const GREASYFORK_ICON_URL = "https://raw.githubusercontent.com/denilsonsa/denilsonsa.github.io/master/icons/GreasyFork.svg";

    /***************************************
     * Match Detection
     ***************************************/
    /**
     * Packet prefixes used to recognize match and player events.
     * Keep these signatures in sync with the decoder and packet handler below.
     * @see decodeReportMatchPacket
     * @see observeReportMatchPacket
     */
    const REPORT_MATCH_SIGNATURES = {
        welcome: [0xf3, 0x03, 0xe2, 0x00, 0x00, 0x08, 0x05],
        join: [0xf3, 0x04, 0xff, 0x03],
        leave: [[0xf3, 0x04, 0xfe, 0x03], [0xf3, 0x04, 0xfe, 0x04]],
        selfJoin: [0xf3, 0x03, 0xe3, 0x00, 0x00, 0x08, 0x04],
        playerInfo: [0xf3, 0x04, 0xfd, 0x03],
        roomEnd: [
            [0xf3, 0x03, 0xe6, 0x00, 0x00, 0x08, 0x00],
            [0xf3, 0x03, 0xfe, 0x00, 0x00, 0x08, 0x00],
            [0xf3, 0x01, 0x00],
        ],
    };
    // Reuse the ordered packet lookup table instead of allocating it for every socket message.
    const REPORT_MATCH_PACKET_TYPES = [
        ["welcome", REPORT_MATCH_SIGNATURES.welcome],
        ["selfJoin", REPORT_MATCH_SIGNATURES.selfJoin],
        ["join", REPORT_MATCH_SIGNATURES.join],
        ["playerInfo", REPORT_MATCH_SIGNATURES.playerInfo],
        ...REPORT_MATCH_SIGNATURES.leave.map((signature) => ["leave", signature]),
        ...REPORT_MATCH_SIGNATURES.roomEnd.map((signature) => ["roomEnd", signature]),
    ];
    const reportMatchState = {
        active: false,
        localId: null,
        localName: "",
        localRawName: "",
        players: new Map(),
    };
    const REPORT_ROOM_ANNOUNCEMENT =
        `<color=#ed3434>[Kour Report]</color> <color=#ffffff>Report hackers with Kour Report. Search Google for "Kour Report" or join our Discord: <color=#5865f2>${DISCORD_URL}</color></color>`;
    let onReportMatchPlayersUpdated = null;
    let activeReportMatchSocket = null;
    let reportRoomAnnouncementTimer = null;
    let reportRoomAnnouncementSequence = 0;
    let reportRoomAnnouncementAttempted = false;

    /**
     * Send a snapshot of the current roster to the UI callback.
     * @see resetReportMatchPlayers
     * @see observeReportMatchPacket
     * @see renderPlayers
     */
    function notifyReportMatchPlayers() {
        onReportMatchPlayersUpdated?.(
            reportMatchState.active,
            [...reportMatchState.players.values()].map((player) => ({
                ...player,
                local: reportMatchState.localId !== null &&
                    player.key === String(reportMatchState.localId),
            }))
        );
    }

    /**
     * Clear the active room and roster, then refresh the visible player list.
     * @see notifyReportMatchPlayers
     * @see installReportMatchSocketTracker
     */
    function resetReportMatchPlayers() {
        resetReportRoomAnnouncement();
        reportMatchState.active = false;
        reportMatchState.localId = null;
        reportMatchState.localName = "";
        reportMatchState.localRawName = "";
        reportMatchState.players.clear();
        notifyReportMatchPlayers();
    }

    function cancelScheduledReportRoomAnnouncement() {
        if (reportRoomAnnouncementTimer !== null) {
            window.clearTimeout(reportRoomAnnouncementTimer);
            reportRoomAnnouncementTimer = null;
        }
    }

    function resetReportRoomAnnouncement() {
        reportRoomAnnouncementSequence += 1;
        cancelScheduledReportRoomAnnouncement();
        reportRoomAnnouncementAttempted = false;
    }

    function isReportMatchChatReady() {
        return reportMatchState.active &&
            reportMatchState.localId !== null &&
            activeReportMatchSocket !== null &&
            activeReportMatchSocket.readyState === 1;
    }

    function sendReportChatAnnouncement(message) {
        const socket = activeReportMatchSocket;
        if (!isReportMatchChatReady() || !socket) return false;

        const messageBytes = new Uint8Array(message.length);
        for (let index = 0; index < message.length; index += 1) {
            messageBytes[index] = message.charCodeAt(index);
        }
        const lengthBytes = [];
        let remainingLength = messageBytes.length;
        do {
            let byte = remainingLength & 0x7f;
            remainingLength >>>= 7;
            if (remainingLength > 0) byte |= 0x80;
            lengthBytes.push(byte);
        } while (remainingLength > 0);

        const packet = new Uint8Array([
            0xf3, 0x02, 0xfd, 0x03, 0xf6, 0x03, 0x01, 0xf4, 0x22,
            0xf5, 0x17, 0x01, 0x07, ...lengthBytes, ...messageBytes,
        ]);
        try {
            socket.send(packet);
            return true;
        } catch (error) {
            console.error("[Kour Report] Failed to send the room announcement.", error);
            return false;
        }
    }

    let scheduleReportRoomAnnouncement = () => {};

    /**
     * Check whether a packet begins with a known event signature.
     * @see REPORT_MATCH_SIGNATURES
     * @see observeReportMatchPacket
     */
    function reportPacketStartsWith(packet, signature) {
        return packet.length >= signature.length &&
            signature.every((value, index) => packet[index] === value);
    }

    /**
     * Decode the supported Photon value types from a player packet.
     * @param {Uint8Array} packet Raw packet bytes.
     * @param {number} offset First byte after the packet signature.
     * @returns {Map} Decoded packet fields keyed by their numeric IDs.
     * @see REPORT_MATCH_SIGNATURES
     * @see observeReportMatchPacket
     */
    function decodeReportMatchPacket(packet, offset) {
        let position = offset;
        const dataView = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
        const readByte = () => {
            if (position >= packet.length) throw new Error("Unexpected end of player packet.");
            return packet[position++];
        };
        const readBytesAsString = (length) => {
            if (length < 0 || position + length > packet.length) {
                throw new Error("Invalid string length in player packet.");
            }
            let value = "";
            for (const end = position + length; position < end; position++) {
                value += String.fromCharCode(packet[position]);
            }
            return value;
        };
        const readVarint = () => {
            let value = 0;
            let shift = 0;
            for (let index = 0; index < 5; index++) {
                const byte = readByte();
                value |= (byte & 0x7f) << shift;
                if ((byte & 0x80) === 0) return value >>> 0;
                shift += 7;
            }
            throw new Error("Invalid varint in player packet.");
        };
        const readSignedVarint = () => {
            let value = 0;
            let shift = 0;
            for (let index = 0; index < 5; index++) {
                const byte = readByte();
                value |= (byte & 0x7f) << shift;
                shift += 7;
                if ((byte & 0x80) === 0) {
                    if (shift < 32 && (byte & 0x40)) value |= -1 << shift;
                    return value;
                }
            }
            throw new Error("Invalid signed varint in player packet.");
        };
        // Numeric markers carry fixed-width values, compact integers, or no payload.
        const readNumber = (type) => {
            switch (type) {
                case 0x03:
                case 0x0b:
                    return { type, value: readByte() };
                case 0x0c:
                    return { type, value: -readByte() };
                case 0x0d: {
                    const low = readByte();
                    return { type, value: low | (readByte() << 8) };
                }
                case 0x0e: {
                    const low = readByte();
                    return { type, value: -(low | (readByte() << 8)) };
                }
                case 0x05: {
                    if (position + 4 > packet.length) throw new Error("Truncated player number.");
                    const value = dataView.getUint32(position, true);
                    position += 4;
                    return { type, value };
                }
                case 0x06: {
                    if (position + 8 > packet.length) throw new Error("Truncated player number.");
                    const value = dataView.getFloat64(position, true);
                    position += 8;
                    return { type, value };
                }
                case 0x09:
                    return { type, value: readSignedVarint() };
                case 0x1b:
                case 0x1c:
                case 0x1e:
                case 0x20:
                case 0x22:
                    return { type, value: null };
                default:
                    throw new Error(`Unsupported number marker ${type}.`);
            }
        };
        const unwrap = (value) => value && typeof value === "object" && "type" in value
            ? value.value
            : value;
        // Decode nested scalar, string, map, array, and point values recursively.
        const readValue = (depth = 0) => {
            if (depth > 8) throw new Error("Player packet nesting limit exceeded.");
            const marker = packet[position];
            if (marker === undefined) throw new Error("Missing value in player packet.");
            if ([0x03, 0x05, 0x06, 0x09, 0x0b, 0x0c, 0x0d, 0x0e, 0x1b, 0x1c, 0x1e, 0x20, 0x22].includes(marker)) {
                return readNumber(readByte());
            }
            if (marker === 0x07) {
                readByte();
                return readBytesAsString(readVarint());
            }
            if (marker === 0x08) {
                readByte();
                return null;
            }
            if (marker === 0x15) {
                readByte();
                const count = readByte();
                if (count > 128) throw new Error("Player packet map is too large.");
                const values = new Map();
                for (let index = 0; index < count; index++) {
                    values.set(unwrap(readValue(depth + 1)), readValue(depth + 1));
                }
                return values;
            }
            if (marker === 0x17 || marker === 0x40) {
                readByte();
                const count = readByte();
                if (count > 128) throw new Error("Player packet array is too large.");
                return Array.from({ length: count }, () => readValue(depth + 1));
            }
            if (marker === 0x47) {
                readByte();
                const count = readByte();
                if (count > 128) throw new Error("Player packet string array is too large.");
                return Array.from({ length: count }, () => readBytesAsString(readByte()));
            }
            if (marker === 0x49) {
                readByte();
                const count = readByte();
                if (count > 128) throw new Error("Player packet number array is too large.");
                return Array.from({ length: count }, readSignedVarint);
            }
            if (marker === 0x53) {
                readByte();
                const count = readByte();
                if (count > 128 || readByte() !== 0x56) throw new Error("Invalid player point array.");
                return Array.from({ length: count }, () => {
                    if (readByte() !== 0x0c || position + 12 > packet.length) {
                        throw new Error("Invalid player point.");
                    }
                    return [0, 0, 0].map(() => {
                        const value = dataView.getFloat32(position, false);
                        position += 4;
                        return value;
                    });
                });
            }
            if (marker === 0xd1 || marker === 0xd6) {
                readByte();
                const dimensions = marker === 0xd1 ? 4 : 3;
                const pointMarker = readByte();
                if ((dimensions === 4 && pointMarker !== 0x10) ||
                    (dimensions === 3 && pointMarker !== 0x0c) ||
                    position + dimensions * 4 > packet.length) {
                    throw new Error("Invalid player point.");
                }
                return Array.from({ length: dimensions }, () => {
                    const value = dataView.getFloat32(position, false);
                    position += 4;
                    return value;
                });
            }
            if (marker === 0xda) {
                readByte();
                if (position + 5 > packet.length) throw new Error("Truncated player data.");
                const value = packet.slice(position, position + 5);
                position += 5;
                return value;
            }
            throw new Error(`Unsupported player packet value ${marker}.`);
        };
        const fields = new Map();
        while (position < packet.length) fields.set(readByte(), readValue());
        return fields;
    }

    /**
     * Unwrap the decoder's typed numeric values when extracting player IDs.
     * @see decodeReportMatchPacket
     * @see rememberReportMatchPlayer
     */
    function getReportMatchPlayerId(value) {
        return value && typeof value === "object" && "value" in value
            ? value.value
            : value;
    }

    /**
     * Add or update one roster entry, keeping the local player name separate.
     * @see getReportMatchPlayerId
     * @see observeReportMatchPacket
     */
    function rememberReportMatchPlayer(id, stats) {
        id = getReportMatchPlayerId(id);
        if (id === null || id === undefined) return;
        const key = String(id);
        const rawName = stats instanceof Map
            ? (stats.get(0xff) ?? stats.get("name") ?? "")
            : "";
        const name = typeof rawName === "string"
            ? rawName.replace(/<[^>]*>/g, "").trim()
            : "";
        if (reportMatchState.localId !== null && key === String(reportMatchState.localId)) {
            if (name && name.toLowerCase() !== "you") {
                reportMatchState.localName = name;
                reportMatchState.localRawName = typeof rawName === "string"
                    ? rawName.trim()
                    : name;
            }
            return;
        }
        const existing = reportMatchState.players.get(key);
        const playerId = stats instanceof Map ? stats.get("uid") : "";
        reportMatchState.players.set(key, {
            key,
            name: name || existing?.name || `Player ${key}`,
            rawName: typeof rawName === "string" && rawName.trim()
                ? rawName.trim()
                : existing?.rawName || name || `Player ${key}`,
            playerId: typeof playerId === "string" && playerId.trim()
                ? playerId.trim()
                : existing?.playerId || "",
            local: false,
        });
    }

    /**
     * Read a WebSocket Blob using the modern API, with FileReader for older browsers.
     * @param {Blob} blob WebSocket message payload.
     * @returns {Promise<ArrayBuffer>} The binary message contents.
     */
    function readReportMatchBlob(blob) {
        if (typeof blob.arrayBuffer === "function") {
            return Promise.resolve(blob.arrayBuffer());
        }
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.addEventListener("load", () => {
                if (reader.result instanceof ArrayBuffer) {
                    resolve(reader.result);
                } else {
                    reject(new Error("The browser did not return binary player data."));
                }
            }, { once: true });
            reader.addEventListener("error", () => {
                reject(reader.error || new Error("Unable to read match player data."));
            }, { once: true });
            reader.addEventListener("abort", () => {
                reject(new Error("Reading match player data was aborted."));
            }, { once: true });
            reader.readAsArrayBuffer(blob);
        });
    }

    /**
     * Apply recognized match events to the current roster and notify the UI.
     * @param {Blob|ArrayBuffer|ArrayBufferView} data WebSocket message data.
     * @see REPORT_MATCH_SIGNATURES
     * @see decodeReportMatchPacket
     * @see notifyReportMatchPlayers
     */
    async function observeReportMatchPacket(data) {
        if (Object.prototype.toString.call(data) === "[object Blob]") {
            try {
                data = await readReportMatchBlob(data);
            } catch (error) {
                console.warn("[Kour Report] Unable to read match player data.", error);
                return;
            }
        }
        if (ArrayBuffer.isView(data)) {
            data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        } else if (Object.prototype.toString.call(data) === "[object ArrayBuffer]") {
            data = new Uint8Array(data);
        } else {
            return;
        }

        let match = null;
        for (let index = 0; index < REPORT_MATCH_PACKET_TYPES.length; index += 1) {
            const candidate = REPORT_MATCH_PACKET_TYPES[index];
            if (reportPacketStartsWith(data, candidate[1])) {
                match = candidate;
                break;
            }
        }
        if (!match) return;

        try {
            const [type, signature] = match;
            const fields = decodeReportMatchPacket(data, signature.length);
            if (type === "welcome") {
                if (!reportMatchState.active) resetReportRoomAnnouncement();
                reportMatchState.active = true;
                reportMatchState.localId = getReportMatchPlayerId(fields.get(0xfe)) ?? null;
                reportMatchState.localName = "";
                reportMatchState.localRawName = "";
                reportMatchState.players.clear();
                const roster = fields.get(0xf9);
                if (roster instanceof Map) {
                    roster.forEach((stats, id) => rememberReportMatchPlayer(id, stats));
                }
                scheduleReportRoomAnnouncement();
            } else if (type === "selfJoin") {
                reportMatchState.active = true;
                reportMatchState.localName = "";
                reportMatchState.localRawName = "";
                reportMatchState.localId = getReportMatchPlayerId(fields.get(0xfe)) ?? null;
                if (reportMatchState.localId !== null) {
                    rememberReportMatchPlayer(
                        reportMatchState.localId,
                        fields.get(0xf9) ?? fields.get(0xfb)
                    );
                    const localPlayer = reportMatchState.players.get(String(reportMatchState.localId));
                    if (localPlayer?.name && localPlayer.name.toLowerCase() !== "you") {
                        reportMatchState.localName = localPlayer.name;
                    }
                    reportMatchState.players.delete(String(reportMatchState.localId));
                }
                scheduleReportRoomAnnouncement();
            } else if (type === "leave") {
                const id = getReportMatchPlayerId(fields.get(0xfe));
                if (id !== undefined && id !== null) {
                    reportMatchState.players.delete(String(id));
                    if (String(id) === String(reportMatchState.localId)) {
                        resetReportRoomAnnouncement();
                        reportMatchState.active = false;
                        reportMatchState.localId = null;
                        reportMatchState.localName = "";
                        reportMatchState.localRawName = "";
                    }
                }
            } else if (type === "join" || type === "playerInfo") {
                reportMatchState.active = true;
                const id = getReportMatchPlayerId(fields.get(0xfe));
                rememberReportMatchPlayer(id, fields.get(0xf9) ?? fields.get(0xfb));
            } else if (type === "roomEnd") {
                resetReportMatchPlayers();
                return;
            }
            notifyReportMatchPlayers();
        } catch (error) {
            console.warn("[Kour Report] Unable to decode match player data.", error);
        }
    }

    /**
     * Wrap the page WebSocket constructor to observe match-server traffic.
     * Only Exit Games sockets are tracked; closing the active socket clears the roster.
     * @see observeReportMatchPacket
     * @see resetReportMatchPlayers
     */
    function installReportMatchSocketTracker() {
        try {
            const pageWindow = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
            const OriginalWebSocket = pageWindow.WebSocket;
            if (!OriginalWebSocket || OriginalWebSocket.__kourReportMatchTracker) return;

            const TrackedWebSocket = function (...args) {
                const socket = new OriginalWebSocket(...args);
                if (String(args[0] || "").toLowerCase().includes("exitgames")) {
                    let messageQueue = Promise.resolve();
                    socket.addEventListener("open", () => {
                        activeReportMatchSocket = socket;
                        resetReportRoomAnnouncement();
                    });
                    socket.addEventListener("message", (event) => {
                        messageQueue = messageQueue
                            .then(() => observeReportMatchPacket(event.data))
                            .catch((error) => {
                                console.warn("[Kour Report] Unable to process match player data.", error);
                            });
                    });
                    socket.addEventListener("close", () => {
                        if (activeReportMatchSocket !== socket) return;
                        activeReportMatchSocket = null;
                        resetReportRoomAnnouncement();
                        messageQueue = messageQueue.then(resetReportMatchPlayers);
                    });
                }
                return socket;
            };
            TrackedWebSocket.prototype = OriginalWebSocket.prototype;
            if (typeof Object.setPrototypeOf === "function") {
                Object.setPrototypeOf(TrackedWebSocket, OriginalWebSocket);
            }
            Object.defineProperty(TrackedWebSocket, "__kourReportMatchTracker", { value: true });
            pageWindow.WebSocket = TrackedWebSocket;
            if (pageWindow.WebSocket !== TrackedWebSocket) {
                throw new Error("The page WebSocket constructor could not be wrapped.");
            }
        } catch (error) {
            console.warn(
                "[Kour Report] Match player detection is unavailable in this userscript sandbox; manual reporting remains available.",
                error
            );
        }
    }

    installReportMatchSocketTracker();

    /**
     * Build the isolated report UI and connect its controls to match/report state.
     * The shadow root keeps the tool's styles separate from the game page.
     * @see renderPlayers
     * @see setOpen
     * @see sendReport
     */
    function initialize() {
    if (document.getElementById("kour-report-ui")) return;

    /***************************************
     * Configuration
     ***************************************/
    const WINDOW_SIZE_SCALE = 1.08;
    const MAX_REPORT_REASON_LENGTH = 250;
    const MAX_SERVER_RESPONSE_LENGTH = 1200;
    const REPORT_REMINDER_DURATION_MS = 20000;
    const REPORT_HISTORY_CLEAR_PANEL_DURATION_MS = 240;
    const REPORT_HISTORY_TOKEN_DETAILS_DURATION_MS = 280;
    const REPORT_HISTORY_STORAGE_KEY = "kourReportHistory";
    const CLIENT_TOKEN_STORAGE_KEY = "kourReportClientTokenV2Server";
    const API_HEALTH_CHECK_INTERVAL_MS = 60000;
    const API_HEALTH_CHECK_TIMEOUT_MS = 12000;
    const MESSAGE_POLL_INTERVAL_MS = 3000;
    const MESSAGE_POLL_MIN_INTERVAL_MS = 1100;
    const MESSAGE_NOTIFICATION_DURATION_MS = 7000;
    const MESSAGE_NOTIFICATION_ANIMATION_MS = 220;
    const MAX_QUEUED_MESSAGE_NOTIFICATIONS = 3;
    const MESSAGE_STORAGE_KEY = "kourReportMessagesV2";
    const MESSAGE_POLL_COORDINATION_KEY = "kourReportMessagesNextPollAtV2";
    const MESSAGE_SENDER_NAME_STORAGE_KEY = "kourReportMessageSenderNameV2";
    const MAX_STORED_MESSAGES = 100;
    const MAX_REPORT_HISTORY_ITEMS = 25;
    let clientToken = null;
    let clientTokenPromise = null;
    let clientTokenVisible = false;
    let clientTokenRenderAttempt = 0;
    let apiHealthCheckInProgress = false;
    let apiHealthLastCheckedAt = 0;
    let messagePollInProgress = false;
    let customMessages = [];
    const messageNotificationTimers = new Map();
    let messageNotificationQueue = [];
    let messagesCloseFocusTarget = null;
    let clientTokenFeedbackTimer = 0;
    const UI_COLORS = Object.freeze({
        white: "#fff",
        ink: "#111",
    });

    async function getClientToken() {
        if (clientToken) return clientToken;
        if (clientTokenPromise) return clientTokenPromise;

        clientTokenPromise = (async () => {
            let storedToken;
            try {
                storedToken = window.localStorage.getItem(CLIENT_TOKEN_STORAGE_KEY);
            } catch (error) {
                throw new Error(`Could not access local storage for the API client token: ${error.message || error}`);
            }
            if (storedToken !== null) {
                const normalizedStoredToken = storedToken.trim();
                if (normalizedStoredToken.length < 1 || normalizedStoredToken.length > 100) {
                    throw new Error("The saved server-generated API client token is invalid.");
                }
                clientToken = normalizedStoredToken;
                return clientToken;
            }

            let response;
            try {
                response = await fetch(REPORT_TOKEN_API_URL, {
                    method: "POST",
                    cache: "no-store",
                    credentials: "include",
                });
            } catch (error) {
                throw new Error(`Could not obtain the server-generated API client token: ${error.message || error}`);
            }

            const responseText = await response.text();
            let responseData = null;
            if (responseText) {
                try {
                    responseData = JSON.parse(responseText);
                } catch {
                    throw new Error(`The token API returned invalid JSON (HTTP ${response.status}).`);
                }
            }
            const generatedToken = typeof responseData?.clientToken === "string"
                ? responseData.clientToken.trim()
                : "";
            if (!response.ok || responseData?.success !== true ||
                responseData?.code !== "KOUR_REPORT_API_TOKEN_GENERATED" ||
                generatedToken.length < 1 || generatedToken.length > 100) {
                const apiMessage = typeof responseData?.message === "string"
                    ? responseData.message
                    : `HTTP ${response.status}`;
                throw new Error(`Could not obtain the server-generated API client token: ${apiMessage}`);
            }

            try {
                window.localStorage.setItem(CLIENT_TOKEN_STORAGE_KEY, generatedToken);
            } catch (error) {
                throw new Error(`Could not save the server-generated API client token: ${error.message || error}`);
            }
            clientToken = generatedToken;
            return clientToken;
        })();

        try {
            return await clientTokenPromise;
        } catch (error) {
            clientTokenPromise = null;
            throw error;
        }
    }

    function getMessageSenderName() {
        try {
            const savedName = window.localStorage.getItem(MESSAGE_SENDER_NAME_STORAGE_KEY);
            if (typeof savedName === "string" && savedName.trim()) {
                return savedName.trim().slice(0, 100);
            }
        } catch (error) {
            console.warn("[Kour Report] Could not read the saved message sender name:", error);
        }
        return getReportIdentity().reporter || "No detected";
    }

    let reportTextFieldFocused = false;
    let reportTextFields = null;
    let reportShadowRoot = null;
    let textCompositionActive = false;
    const getEventTarget = (event) => {
        if (typeof event.composedPath === "function") {
            const path = event.composedPath();
            if (path && path.length) return path[0];
        }
        return event.target || null;
    };
    const isEditableEventTarget = (target) => {
        if (!target) return false;
        if (typeof target.isContentEditable === "boolean" && target.isContentEditable) return true;
        if (typeof target.matches !== "function") return false;
        try {
            return target.matches(
                "input:not([type='checkbox']):not([type='radio']):not([type='range']):not([type='button']):not([type='submit']):not([type='reset']):not([type='color']):not([type='file']), " +
                "textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']"
            );
        } catch {
            return false;
        }
    };
    const isReportTextFieldFocused = () => {
        if (textCompositionActive) return true;
        if (reportTextFields && reportShadowRoot && "activeElement" in reportShadowRoot) {
            return reportTextFields.has(reportShadowRoot.activeElement);
        }
        return reportTextFieldFocused;
    };
    const shieldReportTextFieldKeys = (event) => {
        if (!isReportTextFieldFocused() || event.key === "Escape") return;
        const target = getEventTarget(event);
        const active = reportShadowRoot?.activeElement;
        if (!isEditableEventTarget(target) &&
            !isEditableEventTarget(active) &&
            !reportTextFields?.has(active)) {
            return;
        }
        const messageInput = active?.classList?.contains("messages-input")
            ? active
            : target?.classList?.contains("messages-input") ? target : null;
        const senderInput = active?.classList?.contains("messages-sender-input")
            ? active
            : target?.classList?.contains("messages-sender-input") ? target : null;
        if (event.type === "keydown" && event.key === "Enter" &&
            (messageInput || senderInput) &&
            !event.isComposing && !textCompositionActive && event.keyCode !== 229) {
            if (senderInput) {
                event.preventDefault();
                reportShadowRoot?.querySelector(".messages-identity-save")?.click();
            } else if (!event.shiftKey) {
                event.preventDefault();
                const composeForm = messageInput.form;
                if (composeForm) {
                    if (typeof composeForm.requestSubmit === "function") {
                        composeForm.requestSubmit();
                    } else {
                        const submitEvent = document.createEvent("Event");
                        submitEvent.initEvent("submit", true, true);
                        composeForm.dispatchEvent(submitEvent);
                    }
                }
            }
        }
        event.stopImmediatePropagation();
    };
    ["keydown", "keyup", "keypress", "beforeinput", "textInput"].forEach((eventType) => {
        window.addEventListener(eventType, shieldReportTextFieldKeys, true);
    });
    const shieldReportTextEntryComposition = (event) => {
        textCompositionActive = event.type !== "compositionend";
        if (!textCompositionActive) return;
        const target = getEventTarget(event);
        if (!isEditableEventTarget(target) && !isEditableEventTarget(reportShadowRoot?.activeElement)) return;
        event.stopImmediatePropagation();
    };
    ["compositionstart", "compositionupdate", "compositionend"].forEach((eventType) => {
        window.addEventListener(eventType, shieldReportTextEntryComposition, true);
    });
    const shieldReportTextEntryPointer = (event) => {
        const target = getEventTarget(event);
        if (!isEditableEventTarget(target) && !isEditableEventTarget(reportShadowRoot?.activeElement)) return;
        if (typeof target.focus === "function") {
            try {
                target.focus({ preventScroll: true });
            } catch {
                target.focus();
            }
        }
        if (document.pointerLockElement && typeof document.exitPointerLock === "function") {
            try {
                document.exitPointerLock();
            } catch {
                // Pointer lock may already be owned or released by the browser.
            }
        }
        event.stopImmediatePropagation();
    };
    ["pointerdown", "mousedown", "touchstart"].forEach((eventType) => {
        window.addEventListener(eventType, shieldReportTextEntryPointer, true);
    });
    const BUTTON_PRESS = Object.freeze({
        scale: 0.93,
        durationMs: 120,
        background: UI_COLORS.white,
        foreground: UI_COLORS.ink,
    });
    const POPUP_EXIT_DURATION_MS = 150;

    /***************************************
     * User Interface and Styles
     ***************************************/
    const host = document.createElement("div");
    host.id = "kour-report-ui";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";

    const shadow = host.attachShadow({ mode: "closed" });
    reportShadowRoot = shadow;
    shadow.addEventListener("dragstart", (event) => {
        const dragSource = event.composedPath().find((target) =>
            target instanceof Element && target.matches("button, a")
        );
        if (dragSource) event.preventDefault();
    }, true);
    // The template holds panel markup and shadow-scoped styles; keep its class names
    // aligned with the selectors and event wiring later in initialize().
    shadow.innerHTML = `
        <style>
            :host {
                all: initial;
                --color-white: ${UI_COLORS.white};
                --color-text-primary: #f4f4f4;
                --color-text-bright: #f3f3f3;
                --color-text-heading: #f5f5f5;
                --color-text-strong: #ededed;
                --color-text-subtle: #dedee1;
                --color-text-description: #d0d0d3;
                --color-text-secondary: #c4c4c7;
                --color-text-muted: #bcbcc0;
                --color-surface-muted: #29292c;
                --color-menu: #171719;
                --color-menu-header: #19191c;
                --color-dialog: #1d2025;
                --color-control: #414146;
                --color-control-highlight: #55555b;
                --color-control-shadow: #39393e;
                --color-border-dialog: #39393d;
                --color-close: #c63b3b;
                --color-discord: #5865f2;
                --color-status-report-start: #d9443e;
                --color-status-report-end: #a9232b;
                --gradient-report: linear-gradient(180deg, var(--color-status-report-start), var(--color-status-report-end));
                --color-status-error: #ed3434;
                --color-status-success: #45b653;
                --color-overlay-dim: rgba(0, 0, 0, 0.72);
                --color-shadow: #0008;
                --color-deep-shadow: #000b;
                --radius-control: 5px;
                --radius-card: 6px;
                --radius-dialog: 8px;
                --radius-large: 10px;
                --radius-medium: 7px;
                --radius-small: 4px;
                --duration-control: ${BUTTON_PRESS.durationMs}ms;
                --duration-fast: 100ms;
                --duration-dropdown: 140ms;
                --duration-exit: ${POPUP_EXIT_DURATION_MS}ms;
                --duration-medium: 240ms;
                --animation-popup-enter: popup-dialog-enter var(--duration-exit) ease-out both;
                --animation-backdrop-enter: popup-backdrop-enter var(--duration-exit) ease-out both;
                --overlay-padding: 18px;
                --shadow-dialog: 0 12px 32px #0009;
                --shadow-dialog-strong: 0 12px 32px var(--color-deep-shadow);
                --tooltip-width: min(300px, calc(100vw - 24px));
                --tooltip-padding: 11px 13px;
                --tooltip-border: 1px solid #45484e;
                --tooltip-radius: var(--radius-control);
                --tooltip-color: #f1f1f2;
                --tooltip-background: var(--color-dialog);
                --tooltip-shadow: 0 8px 22px var(--color-deep-shadow);
                --tooltip-font: 750 13px/1.45 var(--font-decorative);
                --tooltip-text-shadow: 0 1px 2px var(--color-shadow);
                --tooltip-animation: settings-tooltip-enter var(--duration-control) ease-out both;
                --scrollbar-thumb: rgba(190, 190, 200, 0.42);
                --scrollbar-thumb-hover: rgba(220, 220, 230, 0.68);
                --shadow-control-highlight: inset 0 1px 0 #ffffff30;
                --shadow-control-pressed: inset 0 1px 0 var(--color-white);
                --font-ui: "Segoe UI", Arial, sans-serif;
                --font-decorative: "Trebuchet MS", "Segoe UI", Arial, sans-serif;
                --button-press-scale: ${BUTTON_PRESS.scale};
                --button-press-duration: var(--duration-control);
                --button-press-background: ${BUTTON_PRESS.background};
                --button-press-foreground: ${BUTTON_PRESS.foreground};
            }
            .button-press-held { transform: scale(var(--button-press-scale)) !important; }
            * {
                box-sizing: border-box;
                scrollbar-color: var(--scrollbar-thumb) transparent;
                scrollbar-width: thin;
            }
            *::-webkit-scrollbar { width: 9px; height: 9px; }
            *::-webkit-scrollbar-track { border-radius: 999px; background: transparent; }
            *::-webkit-scrollbar-thumb {
                min-height: 28px; border: 2px solid transparent; border-radius: 999px;
                background: var(--scrollbar-thumb); background-clip: padding-box;
            }
            *::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-thumb-hover); background-clip: padding-box; }
            *::-webkit-scrollbar-corner { background: transparent; }
            button, input, select, textarea { font: inherit; }
            .panel {
                position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
                padding: 20px; color: var(--color-text-primary); background: transparent;
                font: 15px/1.4 var(--font-ui); pointer-events: auto;
            }
            .panel.open {
                display: flex; background: var(--color-overlay-dim); animation: var(--animation-backdrop-enter);
            }
            .panel.open .main { animation: var(--animation-popup-enter); }
            .panel.is-closing {
                display: flex; background: var(--color-overlay-dim); pointer-events: none;
                animation: popup-backdrop-exit var(--duration-exit) ease-in both;
            }
            .panel.is-closing .main { animation: popup-dialog-exit var(--duration-exit) ease-in both; }
            .main {
                display: flex; width: min(${Math.round(620 * WINDOW_SIZE_SCALE)}px, 100%);
                max-height: min(${Math.round(680 * WINDOW_SIZE_SCALE)}px, calc(100vh - 40px));
                min-height: 0; flex-direction: column; overflow: hidden;
                border: 1px solid #343434; border-radius: 11px; background: var(--color-menu);
                box-shadow: 0 8px 20px #0006; pointer-events: auto;
            }
            .topbar {
                display: flex; min-height: 62px; align-items: center; justify-content: space-between;
                padding: 0 16px; background: var(--color-menu-header);
            }
            .title-group { display: flex; align-items: center; gap: 9px; }
            .eyebrow { color: var(--color-text-heading); font-size: 19px; font-weight: 800; }
            .top-actions { color: #aaa; font-size: 12px; font-weight: 700; }
            .top-actions[hidden] { display: none; }
            .top-action-button {
                display: inline-flex; min-height: 30px; align-items: center; justify-content: center; gap: 5px;
                padding: 0 9px; border: 0; border-radius: var(--radius-control); color: var(--color-text-primary);
                background: linear-gradient(180deg, var(--color-control-highlight), var(--color-control-shadow)); cursor: pointer;
                font: 700 12px/1 var(--font-decorative);
                box-shadow: var(--shadow-control-highlight);
            }
            .top-action-button:hover { filter: brightness(1.08); }
            .discord-button { background: var(--color-discord); }
            .github-button { background: #35363a; }
            .report-history-button { background: #386b57; }
            .messages-button { position: relative; background: #8a5a24; }
            .top-action-button.messages-button {
                box-sizing: border-box; height: 30px; min-height: 30px; padding: 0 9px; gap: 5px;
                font: 700 12px/1 var(--font-decorative);
            }
            .top-action-button.messages-button svg {
                width: 15px; height: 15px; flex: 0 0 15px;
                fill: none; stroke: currentColor; stroke-width: 1.8;
                stroke-linecap: round; stroke-linejoin: round;
            }
            .messages-count {
                position: absolute; top: -7px; right: -7px; display: grid; min-width: 17px; height: 17px;
                place-items: center; padding: 0 4px; border: 1px solid #171719; border-radius: 999px;
                color: #fff; background: #d32f3f; font: 800 10px/1 Arial, sans-serif; box-shadow: 0 1px 3px #0009;
            }
            .messages-count[hidden] { display: none; }
            .info-button { background: #3f6178; }
            .top-action-button svg { width: 15px; height: 15px; fill: currentColor; }
            .report-history-button svg { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
            .top-action-button .info-icon {
                display: grid; width: 14px; height: 14px; place-items: center;
                border: 1.5px solid currentColor; border-radius: 50%; font: 800 10px/1 Arial, sans-serif;
            }
            .settings-button {
                width: auto; height: auto; background: #554d68;
            }
            .settings-button svg { width: 15px; height: 15px; }
            .menu-footer { display: flex; flex-direction: column; align-items: center; gap: 9px; margin-top: 14px; }
            .menu-footer-actions { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; }
            .menu-update {
                display: flex; width: 100%; max-width: 480px; min-width: 0;
                align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px;
                padding: 7px 10px; border: 1px solid #59633a; border-radius: var(--radius-control);
                color: #e5efc8; background: #25291f; font: 700 12px/1.3 var(--font-decorative);
                animation: update-notice-enter var(--duration-exit) ease-out both;
            }
            .menu-update[hidden] { display: none; }
            .menu-update-copy {
                display: flex; min-width: 0; flex: 1 1 180px; flex-direction: column; gap: 3px;
                overflow-wrap: anywhere; text-align: center;
            }
            .menu-update-details {
                display: -webkit-box; width: 100%; height: 2.6em; max-height: 2.6em; overflow: hidden;
                padding: 0; border: 0; color: var(--color-text-muted); background: transparent; cursor: help;
                font-family: inherit; text-align: center;
                font-size: 11px; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere;
                white-space: pre-line; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
            }
            .menu-update-details[hidden] { display: none; }
            .menu-update .update-button { min-height: 26px; flex: 0 0 auto; background: #53662f; }
            @keyframes update-notice-enter {
                from { opacity: 0; transform: translateY(4px); }
                to { opacity: 1; transform: translateY(0); }
            }
            @media (prefers-reduced-motion: reduce) {
                .menu-update { animation: none; }
            }
            .menu-footer-note {
                margin: 0; color: var(--color-text-muted); font: 700 12px/1.35 var(--font-decorative);
                letter-spacing: -0.1px; text-align: center; text-shadow: 0 1px 1px var(--color-shadow);
            }
            .menu-footer-version {
                display: flex; width: 100%; align-self: stretch; align-items: center; justify-content: center;
                flex-wrap: wrap; gap: 5px;
                margin: -5px 0 0; color: #858589; font: 600 10px/1 Arial, sans-serif; text-align: center;
            }
            .menu-footer-version-link {
                padding: 0; border: 0; color: inherit; background: transparent;
                font: inherit; cursor: pointer; transition: color 140ms ease;
            }
            .menu-footer-version-link:hover, .menu-footer-version-link:focus-visible {
                color: #ffe2a1; text-decoration: underline; text-underline-offset: 2px; outline: none;
            }
            .menu-footer-version-separator {
                color: #626267; font-size: 13px;
            }
            .menu-footer-api-health {
                display: inline-flex; align-items: center; padding: 0; border: 0;
                color: inherit; background: transparent; font: inherit; cursor: pointer;
                transition: color 140ms ease;
            }
            .menu-footer-api-health:hover:not(:disabled),
            .menu-footer-api-health:focus-visible {
                color: #91c5a2; text-decoration: underline; text-underline-offset: 2px; outline: none;
            }
            .menu-footer-api-health.is-error,
            .menu-footer-api-health.is-error:hover:not(:disabled),
            .menu-footer-api-health.is-error:focus-visible { color: #e27d7d; }
            .menu-footer-api-health:disabled { cursor: wait; opacity: .85; }
            .close {
                position: relative; z-index: 0;
                width: 32px; height: 32px; border: 0; border-radius: var(--radius-control);
                color: var(--color-white); background: transparent; cursor: pointer; font-size: 24px; font-weight: 800; line-height: 1;
            }
            .content { min-height: 0; flex: 1; overflow: auto; padding: 14px 15px 16px; }
            .players-heading {
                margin: 0 0 10px; color: #d7d7d9; font-size: 13px; font-weight: 800;
                text-align: center; text-transform: uppercase;
            }
            .players-heading[hidden] { display: none; }
            .player-list {
                display: flex; flex-direction: column; gap: 5px; overflow-x: hidden; overflow-y: auto;
            }
            .player-row {
                display: flex; min-height: 52px; flex: 0 0 auto; align-items: center; gap: 8px;
                padding: 5px 8px; border: 1px solid #303034; border-radius: var(--radius-control);
                background: #242427;
            }
            .player-row-enter { animation: player-row-enter var(--duration-medium) ease-out both; }
            @keyframes player-row-enter {
                from { opacity: 0; transform: translateY(8px); }
                to { opacity: 1; transform: translateY(0); }
            }
            @media (prefers-reduced-motion: reduce) {
                .player-row-enter { animation: none; }
            }
            .player-avatar {
                display: grid; width: 38px; height: 38px; flex: 0 0 38px; place-items: center;
                border-radius: var(--radius-small); color: var(--color-text-bright); background: linear-gradient(145deg, #a95c25, #55351e);
                font-size: 17px; font-weight: 800; text-transform: uppercase;
            }
            .player-avatar img { display: block; width: 100%; height: 100%; border-radius: inherit; object-fit: cover; }
            .player-info { min-width: 0; flex: 1; }
            .player-name {
                display: block; min-width: 0; overflow: hidden; color: var(--color-text-strong); font-size: 15px; font-weight: 800;
                text-overflow: ellipsis; white-space: nowrap;
            }
            .player-status { color: #858589; font-size: 10px; font-weight: 600; }
            .player-actions { display: flex; flex: 0 0 auto; gap: 9px; }
            .player-action {
                min-width: 100px; min-height: 36px; padding: 0 12px; border: 0; border-radius: var(--radius-dialog);
                color: var(--color-white); background: linear-gradient(180deg, var(--color-control-highlight), var(--color-control-shadow)); cursor: pointer;
                font-size: 14px; font-weight: 800; text-shadow: 0 1px 2px var(--color-shadow);
                box-shadow: var(--shadow-control-highlight); white-space: nowrap;
                transform: scale(1);
            }
            .player-action:hover { transform: scale(1.04); }
            .player-action.report { background: var(--gradient-report); }
            /* Keep the pulse/ring limited to active calls; error and cooldown states use their own colors. */
            .player-action.call-kbi {
                position: relative;
                display: inline-flex; align-items: center; justify-content: center; gap: 6px;
                line-height: 1;
                border: 1px solid #65df91;
                background: linear-gradient(180deg, #218d53, #17653e);
                animation: call-kbi-pulse 1.3s ease-in-out infinite;
                transition: border-color 240ms ease, box-shadow 240ms ease, filter 240ms ease;
            }
            .launcher-call-kbi {
                position: fixed !important; z-index: 2147483647;
                width: 72px; min-width: 72px; height: 72px; min-height: 72px;
                box-sizing: border-box; padding: 7px 5px;
                flex-direction: column; gap: 5px;
                border: 2px solid #242424;
                border-radius: 0;
                color: var(--color-white);
                background: linear-gradient(90deg, #383838 0%, #303030 100%);
                box-shadow: 0 2px 7px rgba(0,0,0,0.45), inset 0 1px 0 #505050, inset 0 -2px 0 #222;
                animation: none;
                opacity: 0; visibility: hidden; pointer-events: none;
                transform: scale(.94);
                transform-origin: 100% 100%;
                transition: opacity 180ms ease, transform 180ms ease, visibility 0s linear 180ms;
            }
            .launcher-call-kbi.is-visible:hover {
                background: #a5a5a5;
                box-shadow: 0 5px 16px rgba(0,0,0,.55), inset 0 1px 0 #626262, inset 0 -2px 0 #222;
            }
            .launcher-call-kbi .call-kbi-icon {
                width: var(--launcher-call-icon-size, 26px);
                height: var(--launcher-call-icon-size, 26px);
                flex-basis: var(--launcher-call-icon-size, 26px);
            }
            .launcher-call-kbi .call-kbi-icon svg {
                width: var(--launcher-call-icon-size, 26px);
                height: var(--launcher-call-icon-size, 26px);
            }
            .launcher-call-kbi .call-kbi-label {
                font-weight: 700; line-height: 1.1; letter-spacing: -.25px;
                font-family: "Trebuchet MS", Arial, sans-serif;
            }
            .launcher-call-kbi.is-visible {
                opacity: 1; visibility: visible; pointer-events: auto;
                transform: scale(1);
                transition-delay: 0s;
            }
            .launcher-call-kbi.is-visible.is-hovered { transform: scale(1.12); }
            .launcher-call-kbi.is-visible.neighbor-hover { border-bottom-color: transparent; }
            .launcher-call-kbi .launcher-hover-seam {
                position: absolute; left: 14%; bottom: -2px; width: 72%; height: 2px;
                background: #242424; opacity: 0; pointer-events: none;
                transition: opacity 180ms ease;
            }
            .launcher-call-kbi.is-visible.neighbor-hover .launcher-hover-seam { opacity: 1; }
            .launcher-quick-messages {
                position: fixed !important; z-index: 2147483647;
                display: flex; box-sizing: border-box;
                width: 72px; min-width: 72px; height: 72px; min-height: 72px;
                flex-direction: column; align-items: center; justify-content: center;
                gap: 5px; padding: 7px 5px;
                border: 2px solid #242424; border-radius: 0;
                color: var(--color-white);
                background: linear-gradient(180deg, #9470bd, #6f4f93);
                box-shadow: 0 2px 7px rgba(0,0,0,.45), inset 0 1px 0 #b999d8, inset 0 -2px 0 #4a3265;
                opacity: 0; visibility: hidden; pointer-events: none;
                transform: scale(.94);
                transform-origin: 100% 0%;
                transition: opacity 180ms ease, transform 180ms ease, visibility 0s linear 180ms,
                    background 180ms ease, box-shadow 180ms ease, border-color 180ms ease,
                    top 180ms ease;
            }
            .launcher-quick-messages.is-visible {
                opacity: 1; visibility: visible; pointer-events: auto;
                transform: scale(1); transition-delay: 0s;
            }
            .launcher-quick-messages.is-visible:hover,
            .launcher-quick-messages.is-visible.is-hovered {
                background: linear-gradient(180deg, #aa86ce, #81619f);
                box-shadow: 0 5px 16px rgba(0,0,0,.55), inset 0 1px 0 #cbb2df, inset 0 -2px 0 #4a3265;
                transform: scale(1.12);
            }
            .launcher-quick-messages.is-visible.button-pressable:active,
            .launcher-quick-messages.is-visible.button-pressable.is-pressed {
                color: var(--button-press-foreground);
                background: var(--button-press-background);
                border-color: var(--button-press-background);
                box-shadow: var(--shadow-control-pressed);
            }
            .launcher-quick-messages .launcher-message-icon {
                display: inline-flex; width: var(--launcher-message-icon-size, 24px);
                height: var(--launcher-message-icon-size, 24px); align-items: center; justify-content: center;
                position: relative; z-index: 1;
            }
            .launcher-quick-messages .launcher-message-icon svg {
                width: var(--launcher-message-icon-size, 24px);
                height: var(--launcher-message-icon-size, 24px); fill: none;
                stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;
            }
            .launcher-quick-messages .launcher-message-label {
                position: relative; z-index: 1; font-weight: 700; line-height: 1.1;
                letter-spacing: -.25px; font-family: "Trebuchet MS", Arial, sans-serif;
            }
            .launcher-quick-messages .messages-count {
                top: -5px; right: auto; left: -5px; min-width: 20px; height: 20px;
                border-color: #242424; font-size: 10px;
            }
            .launcher-shortcut-wheel {
                position: fixed; inset: 0; z-index: 2147483647;
                pointer-events: none;
            }
            .launcher-shortcut-wheel[hidden] { display: none; }
            .launcher-shortcut-hidden {
                visibility: hidden !important; opacity: 0 !important; pointer-events: none !important;
            }
            .launcher-shortcut-wheel::before {
                position: absolute; inset: 0;
                background: rgba(8, 10, 9, .42);
                content: ""; pointer-events: none;
                -webkit-backdrop-filter: blur(6px);
                backdrop-filter: blur(6px);
            }
            .launcher-shortcut-options {
                position: fixed; top: 50%; left: 50%; display: flex;
                width: min(560px, calc(100vw - 32px)); justify-content: center; gap: 18px;
                padding: 28px; border: 1px solid #ffffff20; border-radius: 20px;
                background: linear-gradient(145deg, #202522f5, #17191bf5);
                box-shadow: 0 24px 70px #000b, 0 0 40px #39c96b18;
                transform: translate(-50%, -50%); pointer-events: none;
            }
            .launcher-shortcut-hint {
                position: absolute; top: 0; left: 50%;
                padding: 7px 12px; border: 1px solid #ffffff24; border-radius: 7px;
                color: #d7e8dc; background: #171719ef; font: 700 12px/1.2 Arial, sans-serif;
                text-align: center; white-space: nowrap; transform: translate(-50%, -50%);
            }
            .launcher-shortcut-option {
                position: relative; display: flex; min-width: 0; min-height: 150px; flex: 1 1 0;
                flex-direction: column; align-items: center; justify-content: center; gap: 15px;
                padding: 18px; border: 1px solid #55555a; border-radius: 14px;
                color: #f5f5f5; background: linear-gradient(180deg, #38383c, #242427);
                box-shadow: 0 8px 22px #0008; cursor: pointer; font: 800 17px/1.2 Arial, sans-serif;
                pointer-events: auto; transition: background 180ms ease, border-color 180ms ease, transform 180ms ease, box-shadow 180ms ease;
            }
            .launcher-shortcut-option svg { width: 34px; height: 34px; flex: 0 0 34px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
            .launcher-shortcut-option.is-selected {
                z-index: 1; border-color: #fff; background: linear-gradient(180deg, #56565b, #39393e);
                box-shadow: 0 14px 34px #000b, 0 0 0 3px #ffffff18;
                transform: translateY(-4px) scale(1.04);
            }
            .launcher-shortcut-option.menu.is-selected {
                border-color: #ff8a84; color: #fff;
                background: linear-gradient(160deg, #a93636, #612323);
                box-shadow: 0 0 30px #ec484852, inset 0 1px 0 #ffffff35;
            }
            .launcher-shortcut-option.call {
                border-color: #42bd70; color: #eaffef;
                background: linear-gradient(160deg, #287d4a, #174b30);
                box-shadow: 0 0 20px #38d97532, inset 0 1px 0 #ffffff26;
            }
            .launcher-shortcut-option.call::after {
                position: absolute; inset: -5px; border: 1px solid #58df8b90;
                border-radius: 18px; content: ""; pointer-events: none;
                animation: shortcut-call-ring 1.8s ease-out infinite;
            }
            .launcher-shortcut-option.call.is-selected {
                border-color: #a0ffbd; color: #fff;
                background: linear-gradient(160deg, #35a862, #1e7040);
                box-shadow: 0 0 32px #39e77978, inset 0 1px 0 #ffffff45;
                transform: translateY(-4px) scale(1.04);
            }
            @keyframes shortcut-call-ring {
                0% { opacity: .8; transform: scale(.98); }
                100% { opacity: 0; transform: scale(1.06); }
            }
            @media (max-width: 480px) {
                .launcher-shortcut-options { width: calc(100vw - 24px); gap: 10px; padding: 22px 14px 14px; }
                .launcher-shortcut-option { min-height: 124px; gap: 10px; padding: 12px 8px; font-size: 14px; }
                .launcher-shortcut-option svg { width: 28px; height: 28px; flex-basis: 28px; }
            }
            @media (prefers-reduced-motion: reduce) {
                .launcher-shortcut-option, .launcher-shortcut-option.call::after { transition: none; animation: none; }
            }
            .launcher-call-kbi::before { border-radius: inherit; }
            .launcher-call-kbi::after { inset: -5px; display: none; }
            .player-action.call-kbi::before {
                position: absolute; z-index: 0; inset: 0; border-radius: inherit;
                background: linear-gradient(180deg, #218d53, #17653e);
                content: ""; opacity: 0; pointer-events: none;
                transition: opacity 260ms ease, background 260ms ease;
            }
            .player-action.call-kbi:not(.is-error):not(.is-success):not(.is-cooldown)::after {
                position: absolute; z-index: 0; inset: -4px;
                border: 2px solid #65df91; border-radius: inherit;
                content: ""; pointer-events: none;
                box-shadow: 0 0 10px #43df8ab0;
                animation: call-kbi-ring 1.3s ease-out infinite;
            }
            .call-kbi-icon, .call-kbi-label { position: relative; z-index: 1; }
            .call-kbi-label { display: inline-block; }
            .call-kbi-label.is-changing { animation: call-kbi-label-enter 220ms ease-out both; }
            .call-kbi-icon { display: inline-flex; width: 16px; height: 16px; flex: 0 0 16px; align-items: center; justify-content: center; }
            .call-kbi-icon svg { width: 16px; height: 16px; fill: currentColor; }
            .player-action.call-kbi.is-loading { cursor: progress; }
            .player-action.call-kbi.is-loading:disabled { opacity: 1; }
            .player-action.call-kbi.is-loading .call-kbi-icon {
                border: 2px solid #ffffff70; border-top-color: var(--color-white); border-radius: 50%;
                animation: call-kbi-spin .75s linear infinite;
            }
            .player-action.call-kbi.is-loading .call-kbi-icon svg { display: none; }
            .player-action.call-kbi.is-success { border-color: #9af0b4; background: #17653e; }
            .player-action.call-kbi.is-error {
                border-color: #ff9a9a;
                animation: none; box-shadow: 0 0 8px #ed343470;
            }
            .player-action.call-kbi.is-error::before {
                background: linear-gradient(180deg, #a83232, #7d2020);
                opacity: 1;
            }
            .player-action.call-kbi.is-error::after { display: none; }
            .player-action.call-kbi.is-cooldown {
                cursor: not-allowed; border-color: #ffe36e;
                animation: none; box-shadow: 0 0 8px #f4c84270;
            }
            .player-action.call-kbi.is-cooldown::before {
                background: linear-gradient(180deg, #a98218, #70530d);
                opacity: 1;
            }
            .player-action.call-kbi.is-cooldown::after { display: none; }
            .player-action.call-kbi.is-cooldown:disabled { opacity: 1; }
            .player-action.call-kbi.is-pressed {
                color: var(--button-press-foreground);
                background: var(--button-press-background);
                border-color: var(--button-press-background);
                animation: none; box-shadow: var(--shadow-control-pressed);
            }
            .player-action.call-kbi.is-pressed::before { opacity: 0; }
            @keyframes call-kbi-pulse {
                0%, 100% { box-shadow: 0 0 5px #43df8a85, var(--shadow-control-highlight); }
                50% { box-shadow: 0 0 18px #43df8ae0, var(--shadow-control-highlight); }
            }
            @keyframes call-kbi-ring {
                0% { opacity: .95; transform: scale(.94); }
                100% { opacity: 0; transform: scale(1.24); }
            }
            @keyframes call-kbi-label-enter {
                from { opacity: 0; transform: translateY(4px) scale(.96); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
            @keyframes call-kbi-spin { to { transform: rotate(360deg); } }
            @media (prefers-reduced-motion: reduce) {
                .player-action.call-kbi, .player-action.call-kbi::before,
                .player-action.call-kbi::after, .call-kbi-label.is-changing,
                .player-action.call-kbi.is-loading .call-kbi-icon { animation: none; }
                .player-action.call-kbi, .player-action.call-kbi::before { transition: none; }
                .launcher-call-kbi { transition: none; }
            }
            .player-action:active, .player-action.is-pressed {
                text-shadow: none; box-shadow: var(--shadow-control-pressed);
            }
            .player-action:disabled { opacity: .45; cursor: not-allowed; }
            .empty-state {
                display: flex; flex-direction: column; align-items: center; gap: 12px;
                margin: 12px 0; padding: 17px 14px; border: 1px solid #343438; border-radius: var(--radius-card);
                color: var(--color-text-description); background: #202023; font: 700 14px/1.45 var(--font-decorative);
                letter-spacing: -0.1px; text-align: center; text-shadow: 0 1px 1px var(--color-shadow);
            }
            .empty-state[hidden] { display: none; }
            .menu-report-actions {
                display: flex; justify-content: center; flex-wrap: wrap; gap: 9px;
                margin: 12px 0;
            }
            .empty-state .menu-report-actions { margin: 0; }
            .manual-report-button {
                min-width: 150px; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
            }
            .manual-report-button svg { width: 17px; height: 17px; flex: 0 0 17px; fill: currentColor; }
            .menu-call-kbi { min-width: 150px; }
            .popup-layer {
                position: fixed; inset: 0; z-index: 3; display: grid; place-items: center;
                padding: var(--overlay-padding); background: var(--color-overlay-dim); pointer-events: auto;
            }
            .popup-layer:not(.is-closing) { animation: var(--animation-backdrop-enter); }
            .popup-layer:not(.is-closing) > .info-dialog,
            .popup-layer:not(.is-closing) > .changelog-dialog,
            .popup-layer:not(.is-closing) > .settings-dialog,
            .popup-layer:not(.is-closing) > .report-dialog,
            .popup-layer:not(.is-closing) > .report-history-dialog,
            .popup-layer:not(.is-closing) > .messages-dialog,
            .popup-layer:not(.is-closing) > .report-details-dialog,
            .popup-layer:not(.is-closing) > .verification-dialog,
            .popup-layer:not(.is-closing) > .menu-call-link-dialog,
            .popup-layer:not(.is-closing) > .update-method-dialog {
                animation: var(--animation-popup-enter);
            }
            .popup-layer.is-closing {
                pointer-events: none; animation: popup-backdrop-exit var(--duration-exit) ease-in both;
            }
            .popup-layer.is-closing > .info-dialog,
            .popup-layer.is-closing > .changelog-dialog,
            .popup-layer.is-closing > .settings-dialog,
            .popup-layer.is-closing > .report-dialog,
            .popup-layer.is-closing > .report-history-dialog,
            .popup-layer.is-closing > .messages-dialog,
            .popup-layer.is-closing > .report-details-dialog,
            .popup-layer.is-closing > .verification-dialog,
            .popup-layer.is-closing > .menu-call-link-dialog,
            .popup-layer.is-closing > .update-method-dialog {
                animation: popup-dialog-exit var(--duration-exit) ease-in both;
            }
            @keyframes popup-backdrop-exit {
                to { opacity: 0; }
            }
            @keyframes popup-backdrop-enter {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            @keyframes popup-dialog-exit {
                to { opacity: 0; transform: translateY(18px); }
            }
            @keyframes popup-dialog-enter {
                from { opacity: 0; transform: translateY(18px); }
                to { opacity: 1; transform: translateY(0); }
            }
            .info-dialog-layer[hidden] { display: none; }
            .changelog-layer { z-index: 6; }
            .changelog-layer[hidden] { display: none; }
            .dialog-header { display: flex; min-width: 0; align-items: center; gap: 11px; }
            .dialog-title {
                min-width: 0; margin: 0; color: var(--color-text-heading);
                font: 800 18px/1.3 var(--font-ui);
            }
            .dialog-close {
                position: relative; z-index: 0; display: grid; width: 32px; height: 32px; flex: 0 0 32px; place-items: center;
                padding: 0; border: 0; border-radius: var(--radius-control);
                color: var(--color-white); background: transparent; cursor: pointer;
                font: 800 22px/1 var(--font-ui);
            }
            .dialog-close:focus-visible { outline: 2px solid #d8ff52; outline-offset: 2px; }
            .changelog-dialog {
                display: flex; width: min(580px, 100%); max-height: calc(100vh - 36px);
                flex-direction: column; overflow: hidden; padding: 18px;
                border: 1px solid var(--color-border-dialog); border-radius: var(--radius-large);
                color: var(--color-text-primary); background: var(--color-menu-header); box-shadow: var(--shadow-dialog);
            }
            .changelog-header { margin-bottom: 10px; }
            .changelog-status { min-height: 18px; margin: 0 0 8px; color: var(--color-text-muted); font: 600 11px/1.4 var(--font-ui); }
            .changelog-list {
                display: flex; min-height: 0; flex: 1 1 auto; flex-direction: column; gap: 10px; overflow-y: auto; padding: 0 4px 0 0;
            }
            .changelog-release {
                padding: 12px; border: 1px solid #38383c; border-radius: var(--radius-control); background: #222225;
            }
            .changelog-release-header { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
            .changelog-release-title { margin: 0; color: var(--color-text-heading); font: 800 15px/1.3 var(--font-ui); }
            .changelog-release-date { color: var(--color-text-muted); font: 600 10px/1.3 var(--font-ui); }
            .changelog-section + .changelog-section { margin-top: 9px; }
            .changelog-section-title { margin: 0 0 4px; color: #d9c18f; font: 800 11px/1.3 var(--font-ui); }
            .changelog-items { margin: 0; padding-left: 18px; color: var(--color-text-description); font: 600 12px/1.5 var(--font-ui); }
            .changelog-items li + li { margin-top: 3px; }
            .update-method-layer { z-index: 6; }
            .update-method-layer[hidden] { display: none; }
            .update-method-dialog {
                display: flex; width: min(440px, 100%); max-height: calc(100vh - 36px);
                flex-direction: column; overflow: hidden; border: 1px solid var(--color-border-dialog);
                border-radius: var(--radius-dialog); color: var(--color-text-primary);
                background: var(--color-menu); box-shadow: var(--shadow-dialog-strong);
            }
            .update-method-header {
                min-height: 58px;
                padding: 9px 14px; background: var(--color-menu-header);
            }
            .update-method-title { font-size: 19px; font-weight: 850; }
            .update-method-content {
                display: flex; max-height: min(560px, calc(100vh - 112px)); flex-direction: column;
                gap: 11px; overflow-y: auto; padding: 16px;
            }
            .update-method-description {
                margin: 0 0 2px; color: var(--color-text-description); font-size: 13px;
                font-weight: 600; line-height: 1.45;
            }
            .update-method-option {
                display: flex; width: 100%; min-width: 0; align-items: center; gap: 12px;
                padding: 12px; border: 1px solid var(--color-border-dialog); border-radius: var(--radius-card);
                color: var(--color-text-primary); background: #222226; cursor: pointer; text-align: left;
                text-decoration: none; transition: border-color var(--duration-control), background-color var(--duration-control);
            }
            .update-method-option:hover { border-color: #72727a; background: #29292e; }
            .update-method-option:focus-visible { outline: 2px solid #d6d6d6; outline-offset: 2px; }
            .update-method-option.recommended { border-color: #667a3c; background: #25291f; }
            .update-method-option.recommended:hover { border-color: #91a75e; background: #2b3022; }
            .update-method-icon {
                display: grid; width: 42px; height: 42px; flex: 0 0 42px;
                place-items: center; overflow: hidden; border-radius: 50%; background: #f1f1f1;
            }
            .update-method-icon img { display: block; width: 27px; height: 27px; object-fit: contain; }
            .update-method-icon.github { color: #fff; background: #24292f; }
            .update-method-icon.github svg { width: 25px; height: 25px; fill: currentColor; }
            .update-method-copy { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
            .update-method-option-title { display: flex; align-items: center; gap: 7px; color: var(--color-text-bright); font-size: 14px; font-weight: 800; }
            .update-method-badge {
                padding: 2px 5px; border-radius: 3px; color: #f0f5df; background: #53662f;
                font: 800 9px/1.2 var(--font-decorative); letter-spacing: .3px; text-transform: uppercase;
            }
            .update-method-option-description { color: var(--color-text-muted); font: 600 12px/1.4 var(--font-ui); }
            .settings-layer {
                position: fixed; inset: 0; z-index: 5; display: grid; place-items: center;
                padding: var(--overlay-padding); background: var(--color-overlay-dim); pointer-events: auto;
            }
            .settings-layer[hidden] { display: none; }
            .settings-dialog {
                display: flex; width: min(${Math.round(620 * WINDOW_SIZE_SCALE)}px, 100%); max-height: calc(100vh - 36px);
                flex-direction: column; overflow: hidden; border: 1px solid var(--color-border-dialog); border-radius: var(--radius-dialog);
                color: var(--color-text-primary); background: var(--color-menu); box-shadow: var(--shadow-dialog-strong);
            }
            .settings-header {
                min-height: 58px;
                padding: 9px 14px; background: var(--color-menu-header);
            }
            .settings-title { font-size: 20px; font-weight: 850; }
            .settings-content {
                min-height: 0; overflow: auto; padding: 12px 18px 17px;
            }
            .settings-row {
                display: flex; min-height: 58px; align-items: center; justify-content: space-between;
                gap: 16px; padding: 8px 5px; border-bottom: 1px solid var(--color-surface-muted);
            }
            .settings-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
            .settings-label { color: var(--color-text-bright); font-size: 14px; font-weight: 800; }
            .settings-test-mode-label { color: #ffd166; }
            .settings-label-with-help { display: flex; align-items: center; gap: 7px; }
            .settings-help {
                display: inline-grid; width: 17px; height: 17px; flex: 0 0 17px; place-items: center; padding: 0;
                border: 1px solid #77777d; border-radius: 50%; color: var(--color-text-secondary);
                background: transparent; cursor: help; font: 800 11px/1 Arial, sans-serif;
            }
            .settings-help:hover, .settings-help:focus-visible { border-color: var(--color-white); color: var(--color-white); }
            .settings-section-title {
                margin: 18px 5px 4px; color: var(--color-text-muted); font: 800 11px/1.3 var(--font-ui);
                letter-spacing: .8px; text-transform: uppercase;
            }
            .settings-default { color: #77777b; font-size: 10px; font-weight: 700; }
            .settings-announcement-tooltip strong { color: #ed3434; }
            .settings-client-token-row {
                display: flex; flex-direction: column; gap: 7px; padding: 10px 5px 12px;
                border-bottom: 1px solid var(--color-surface-muted);
            }
            .settings-client-token-heading { display: flex; align-items: center; gap: 7px; }
            .settings-client-token-controls { display: flex; min-width: 0; align-items: center; gap: 7px; }
            .settings-client-token-value {
                min-width: 0; min-height: 34px; flex: 1; overflow-wrap: anywhere; padding: 8px 9px;
                border: 1px solid var(--color-surface-muted); border-radius: var(--radius-control);
                color: var(--color-text-primary); background: var(--color-control);
                font: 700 11px/1.4 Consolas, "Courier New", monospace;
            }
            .settings-client-token-action {
                display: inline-flex; min-width: 62px; min-height: 34px; align-items: center; justify-content: center;
                gap: 6px; padding: 0 10px; border: 1px solid var(--color-control-highlight);
                border-radius: var(--radius-control); color: var(--color-text-primary);
                background: linear-gradient(180deg, var(--color-control-highlight), var(--color-control-shadow));
                cursor: pointer; font: 800 11px/1 var(--font-ui);
                transition: color var(--duration-control) ease, border-color var(--duration-control) ease,
                    background var(--duration-control) ease, box-shadow var(--duration-control) ease;
            }
            .settings-client-token-action:hover:not(:disabled) {
                border-color: var(--color-white); color: var(--color-white); filter: brightness(1.08);
                box-shadow: var(--shadow-control-highlight);
            }
            .settings-client-token-action:disabled { opacity: .55; cursor: not-allowed; }
            .settings-client-token-action svg { width: 14px; height: 14px; flex: 0 0 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
            .settings-client-token-copy .client-token-copy-success-icon { display: none; }
            .settings-client-token-copy.is-copied {
                border-color: #64b98a; color: #d7ffe7;
                background: linear-gradient(180deg, #28784e, #185537);
                box-shadow: 0 0 0 1px #64b98a33, 0 3px 10px #0e392766;
            }
            .settings-client-token-copy.is-copied .client-token-copy-icon { display: none; }
            .settings-client-token-copy.is-copied .client-token-copy-success-icon { display: block; }
            .settings-client-token-status {
                display: flex; width: fit-content; max-width: 100%; min-height: 25px; align-items: center; gap: 6px;
                margin: 0; padding: 4px 9px; border: 1px solid transparent; border-radius: 999px;
                overflow-wrap: anywhere; font: 700 10px/1.3 var(--font-ui);
                animation: client-token-status-enter 180ms ease-out both;
            }
            .settings-client-token-status:empty { display: none; }
            .settings-client-token-status.is-error { border-color: #c9666666; color: #ffd1d1; background: #692f3270; }
            @keyframes client-token-status-enter {
                from { opacity: 0; transform: translateY(-3px); }
                to { opacity: 1; transform: translateY(0); }
            }
            .tooltip {
                position: fixed; z-index: 10; display: block; width: var(--tooltip-width); margin: 0;
                padding: var(--tooltip-padding); border: var(--tooltip-border); border-radius: var(--tooltip-radius);
                color: var(--tooltip-color); background: var(--tooltip-background); box-shadow: var(--tooltip-shadow);
                font: var(--tooltip-font); text-shadow: var(--tooltip-text-shadow); white-space: pre-line;
                pointer-events: none; overflow-wrap: anywhere;
                animation: var(--tooltip-animation);
            }
            .tooltip[hidden] { display: none; }
            @keyframes settings-tooltip-enter {
                from { opacity: 0; transform: translateY(3px); }
                to { opacity: 1; transform: translateY(0); }
            }
            .room-full-report-tooltip { z-index: 21; }
            .settings-checkbox {
                display: grid; width: 20px; height: 20px; flex: 0 0 20px; place-content: center;
                appearance: none; border: 1px solid var(--color-control-highlight); border-radius: var(--radius-control);
                background: var(--color-control); cursor: pointer;
            }
            .settings-checkbox::after {
                width: 5px; height: 9px; border: solid var(--button-press-foreground); border-width: 0 2px 2px 0;
                content: ""; opacity: 0; transform: rotate(45deg) translate(-1px, -1px);
            }
            .settings-checkbox:checked { border-color: var(--color-text-muted); background: var(--color-text-muted); }
            .settings-checkbox:checked::after { opacity: 1; }
            .settings-checkbox:hover { border-color: var(--color-text-muted); background: var(--color-text-muted); }
            .settings-checkbox:focus-visible {
                outline: 2px solid #d8ff52; outline-offset: 3px;
            }
            .settings-range-group {
                display: flex; min-width: min(220px, 45%); align-items: center; gap: 9px;
            }
            .settings-range {
                width: 100%; accent-color: var(--color-text-muted); cursor: pointer;
                transition: accent-color var(--duration-fast) ease;
            }
            .settings-range:active, .settings-range.is-pressed { accent-color: var(--color-white); }
            .settings-value {
                box-sizing: border-box; width: 52px; flex: 0 0 52px; padding: 2px 4px;
                border-radius: 3px; color: var(--color-text-strong); background: var(--color-surface-muted);
                font-size: 11px; font-weight: 800; text-align: center; white-space: nowrap;
            }
            .settings-key-button {
                min-width: 92px; min-height: 32px; padding: 0 10px; border: 0; border-radius: var(--radius-control);
                color: var(--color-text-primary); background: var(--color-control); cursor: pointer; font-size: 12px; font-weight: 800;
            }
            .settings-key-hint {
                margin: 7px 5px 0; color: var(--color-text-muted); font-size: 11px; font-weight: 700;
            }
            .settings-key-hint[hidden] { display: none; }
            .settings-room-announcement-status {
                margin: 6px 5px 0; color: var(--color-text-muted);
                font: 700 11px/1.35 var(--font-ui);
            }
            .settings-room-announcement-status.is-error { color: #e27d7d; }
            .settings-room-announcement-status[hidden] { display: none; }
            .settings-reset {
                display: block; width: min(300px, 100%); min-height: 40px; margin: 15px auto 0;
                border: 0; border-radius: var(--radius-control); color: var(--color-white); background: #8e2020;
                cursor: pointer; font-size: 13px; font-weight: 850;
            }
            .settings-reset:hover { background: #a72b2b; }
            .info-dialog {
                display: flex; width: min(${Math.round(760 * WINDOW_SIZE_SCALE)}px, 100%); max-height: calc(100vh - 36px);
                flex-direction: column; overflow: hidden; border: 1px solid var(--color-border-dialog); border-radius: var(--radius-large);
                color: var(--color-text-primary); background: var(--color-dialog); box-shadow: var(--shadow-dialog);
            }
            .info-dialog-banner {
                position: relative; display: flex; min-height: 150px; flex: 0 0 auto;
                align-items: center; overflow: hidden; padding: 20px 20px 20px 78px;
                background: #252a30;
            }
            .info-dialog-banner::after {
                position: absolute; inset: 0; background: linear-gradient(90deg, #111a 0%, #1119 55%, #1113 100%);
                content: "";
            }
            .info-dialog-banner img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
            .info-dialog-close {
                position: absolute; z-index: 1; left: 16px; top: 50%; width: 46px; height: 46px;
                border: 0; border-radius: var(--radius-medium); color: var(--color-white); background: transparent; cursor: pointer;
                font: 800 28px/1 "Trebuchet MS", Arial, sans-serif; transform: translateY(-50%);
            }
            .button-press-held.info-dialog-close { transform: translateY(-50%) scale(var(--button-press-scale)) !important; }
            .close::before, .dialog-close::before {
                position: absolute; z-index: -1; inset: 0; border-radius: inherit;
                background: var(--color-close); content: ""; transition: transform var(--button-press-duration) ease;
            }
            .close:hover::before, .dialog-close:hover::before { transform: scale(1.08); }
            .info-dialog-close:hover::before { background: #d34343; }
            .close:active::before, .close.is-pressed::before,
            .dialog-close:active::before, .dialog-close.is-pressed::before {
                background: var(--button-press-background); transform: scale(1);
            }
            .info-dialog-heading { position: relative; z-index: 1; }
            .info-dialog-title { margin: 0; color: var(--color-white); font-size: 30px; font-weight: 850; line-height: 1.1; text-shadow: 0 2px 5px var(--color-deep-shadow); }
            .info-dialog-subtitle {
                margin: 5px 0 0; color: var(--color-white); font: 800 16px/1.25 var(--font-decorative);
                text-shadow: 0 2px 5px var(--color-deep-shadow);
            }
            .info-dialog-content {
                min-height: 0; overflow: auto; padding: 23px 27px 27px;
            }
            .info-dialog-content h3 {
                margin: 0 0 12px; color: var(--color-text-bright);
                font: 800 20px/1.3 var(--font-decorative);
            }
            .info-dialog-content p {
                margin: 0 0 12px; color: #e0e1e3;
                font: 700 15px/1.55 var(--font-decorative);
            }
            .info-dialog-contributors {
                display: flex; flex-direction: column; gap: 6px; margin: 18px 0 14px;
            }
            .info-dialog-contributors h3 { margin-bottom: 4px; }
            .contributor-row { min-height: 50px; }
            .contributor-row .player-name { display: flex; align-items: center; gap: 6px; }
            .contributor-clan { color: #e54343; }
            .contributor-clan.xkbi { color: #ff0000; }
            .contributor-clan.ktbi { color: #2aff8d; }
            .contributor-clan.tfz { color: #7d80ff; }
            .contributor-row .player-status {
                color: var(--color-text-muted); font: 700 10px/1.3 var(--font-decorative);
                letter-spacing: -0.1px; text-shadow: 0 1px 1px var(--color-shadow);
            }
            .info-dialog-links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 5px; }
            .info-dialog-discord, .info-dialog-github {
                display: inline-flex; min-height: 38px; align-items: center; gap: 8px; margin-top: 5px; padding: 0 14px;
                border-radius: var(--radius-control); color: var(--color-white); background: var(--color-discord); font-size: 13px; font-weight: 800;
                text-decoration: none;
            }
            .info-dialog-links .info-dialog-discord, .info-dialog-links .info-dialog-github { margin-top: 0; }
            .info-dialog-discord svg, .info-dialog-github svg { width: 17px; height: 17px; flex: 0 0 17px; fill: currentColor; }
            .info-dialog-github { background: #35363a; }
            .info-dialog-discord:hover, .info-dialog-github:hover { filter: brightness(1.08); }
            .report-dialog-layer {
                position: fixed; inset: 0; z-index: 2; display: grid; place-items: center;
                padding: var(--overlay-padding); background: var(--color-overlay-dim); pointer-events: auto;
            }
            .report-dialog-layer[hidden] { display: none; }
            .verification-layer {
                position: fixed; inset: 0; z-index: 4; display: grid; place-items: center;
                padding: var(--overlay-padding); background: var(--color-overlay-dim); pointer-events: auto;
            }
            .verification-layer[hidden] { display: none; }
            .verification-dialog {
                width: min(${Math.round(440 * WINDOW_SIZE_SCALE)}px, 100%); padding: 20px; border: 1px solid var(--color-border-dialog);
                border-radius: var(--radius-dialog); color: var(--color-text-primary); background: var(--color-dialog);
                box-shadow: var(--shadow-dialog);
            }
            .menu-call-link-layer { z-index: 3; }
            .menu-call-link-layer[hidden] { display: none; }
            .menu-call-warning-layer { z-index: 3; }
            .menu-call-warning-layer[hidden] { display: none; }
            .menu-call-link-dialog {
                position: relative; overflow: hidden;
                width: min(${Math.round(440 * WINDOW_SIZE_SCALE)}px, 100%); padding: 20px;
                border: 1px solid #34764f; border-radius: var(--radius-dialog);
                color: var(--color-text-primary);
                background: linear-gradient(145deg, #202a25 0%, var(--color-dialog) 42%, #1b1d21 100%);
                box-shadow: 0 16px 42px #000b, 0 0 28px #25a85b25;
                animation: call-link-dialog-enter 360ms cubic-bezier(.2, .8, .2, 1) both;
            }
            .menu-call-link-dialog::before {
                position: absolute; top: 0; right: 0; left: 0; height: 3px;
                background: linear-gradient(90deg, #30d878, #a4ffc5, #30d878);
                content: ""; transform-origin: left center;
                animation: call-link-accent-enter 650ms ease-out both;
            }
            .menu-call-link-heading {
                display: flex; align-items: center; gap: 13px; margin-bottom: 8px;
            }
            .menu-call-link-icon {
                position: relative; display: grid; width: 48px; height: 48px; flex: 0 0 48px;
                place-items: center; border: 1px solid #63d98d; border-radius: 14px;
                color: #b8ffcf; background: linear-gradient(145deg, #25844c, #155331);
                box-shadow: 0 0 18px #42d87945, inset 0 1px 0 #ffffff35;
                animation: call-link-icon-pulse 1.8s ease-in-out infinite;
            }
            .menu-call-link-icon::after {
                position: absolute; inset: -5px; border: 1px solid #58df8b80;
                border-radius: 17px; content: ""; pointer-events: none;
                animation: call-link-icon-ring 1.8s ease-out infinite;
            }
            .menu-call-link-icon svg {
                width: 25px; height: 25px; fill: none; stroke: currentColor;
                stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;
            }
            .menu-call-link-eyebrow {
                margin: 0 0 3px; color: #7fe6a2;
                font: 800 10px/1.2 var(--font-ui); letter-spacing: 1.3px;
            }
            .menu-call-link-title { margin: 0; }
            .menu-call-link-description {
                margin: 12px 0 18px; padding-left: 61px;
            }
            .menu-call-link-form .report-field label { color: #c9f0d5; }
            .menu-call-link-form input {
                touch-action: manipulation; -webkit-user-select: text; user-select: text;
            }
            .menu-call-link-form input:focus {
                border-color: #59cf82; background: #252d29;
                box-shadow: 0 0 0 3px #36b86625;
            }
            .menu-call-link-form { display: flex; flex-direction: column; gap: 12px; }
            .menu-call-link-status[hidden] { display: none; }
            .menu-call-warning-dialog { max-width: 470px; }
            .menu-call-warning-dialog .menu-call-link-description { padding-left: 0; }
            .menu-call-warning-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
            @keyframes call-link-dialog-enter {
                from { opacity: 0; transform: translateY(12px) scale(.97); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
            @keyframes call-link-accent-enter {
                from { transform: scaleX(0); }
                to { transform: scaleX(1); }
            }
            @keyframes call-link-icon-pulse {
                0%, 100% { box-shadow: 0 0 12px #42d87935, inset 0 1px 0 #ffffff35; }
                50% { box-shadow: 0 0 24px #42d87975, inset 0 1px 0 #ffffff45; }
            }
            @keyframes call-link-icon-ring {
                0% { opacity: .8; transform: scale(.9); }
                100% { opacity: 0; transform: scale(1.2); }
            }
            @media (prefers-reduced-motion: reduce) {
                .menu-call-link-dialog, .menu-call-link-dialog::before,
                .menu-call-link-icon, .menu-call-link-icon::after { animation: none; }
            }
            .verification-title {
                margin: 0; color: var(--color-text-heading);
                font: 800 18px/1.25 var(--font-ui);
                letter-spacing: 0; text-shadow: 0 1px 1px var(--color-shadow);
            }
            .verification-description {
                margin: 8px 0 18px; color: var(--color-text-description);
                font: 700 14px/1.45 var(--font-decorative);
                letter-spacing: -.1px; text-shadow: 0 1px 1px var(--color-shadow);
            }
            .verification-widget { display: flex; min-height: 66px; justify-content: center; align-items: center; overflow: hidden; }
            .verification-status {
                min-width: 0; min-height: 18px; margin: 10px 0 0; color: var(--color-text-primary);
                font: 800 13px/1.4 Arial, Helvetica, sans-serif;
                letter-spacing: 0; text-align: center; overflow-wrap: anywhere;
            }
            .verification-actions { display: flex; justify-content: flex-end; margin-top: 14px; }
            .report-dialog {
                width: min(${Math.round(440 * WINDOW_SIZE_SCALE)}px, 100%); max-height: calc(100vh - 36px); overflow: auto;
                padding: 18px; border: 1px solid var(--color-border-dialog); border-radius: var(--radius-large);
                color: var(--color-text-primary); background: var(--color-menu-header); box-shadow: var(--shadow-dialog);
            }
            .report-history-dialog {
                display: flex; width: min(520px, 100%); max-height: calc(100vh - 36px);
                flex-direction: column; overflow: hidden; padding: 18px;
                border: 1px solid var(--color-border-dialog); border-radius: var(--radius-large);
                color: var(--color-text-primary); background: var(--color-menu); box-shadow: var(--shadow-dialog);
            }
            .messages-layer { z-index: 6; }
            .messages-layer[hidden] { display: none; }
            .verification-layer { z-index: 9; }
            .messages-dialog {
                display: flex; box-sizing: border-box;
                width: min(720px, calc(100vw - 36px));
                max-height: calc(100vh - 36px); max-height: calc(100dvh - 36px);
                flex-direction: column; overflow: hidden; padding: 18px;
                border: 1px solid var(--color-border-dialog); border-radius: var(--radius-large);
                color: var(--color-text-primary);
                background: var(--color-menu); box-shadow: var(--shadow-dialog);
            }
            .messages-header {
                min-height: 58px; flex: 0 0 auto; margin: -18px -18px 12px; padding: 9px 14px;
                border-bottom: 1px solid var(--color-surface-muted); background: var(--color-menu-header);
            }
            .messages-description {
                flex: 0 0 auto; margin: 0 0 12px; color: var(--color-text-muted);
                font: 650 12px/1.45 var(--font-ui);
            }
            .messages-empty { margin: 8px 0; color: var(--color-text-muted); font: 700 13px/1.45 var(--font-ui); text-align: center; }
            .messages-list {
                display: flex; min-height: min(280px, 30vh); max-height: min(52vh, 560px);
                flex-direction: column; gap: 10px;
                overflow: auto; padding: 16px 12px; border: 1px solid #343438; border-radius: var(--radius-medium);
                background: #202023;
            }
            .messages-list[hidden], .messages-empty[hidden] { display: none; }
            .messages-header-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
            .messages-tool-button {
                width: 34px; height: 34px; display: grid; place-items: center; padding: 0;
                border: 1px solid #49494f; border-radius: 8px; color: var(--color-text-primary);
                background: #35363a;
                cursor: pointer; font: 800 15px/1 var(--font-ui);
            }
            .messages-tool-button svg {
                width: 15px; height: 15px;
                fill: currentColor;
            }
            .messages-tool-button:hover { filter: brightness(1.1); }
            .messages-tool-button:focus-visible { outline: 2px solid #b8b8bf; outline-offset: 2px; }
            .messages-tool-button.is-pressed,
            .messages-clear-confirm-action.is-pressed,
            .messages-send.is-pressed { transform: scale(.94); transition: transform 80ms ease; }
            .messages-identity-toggle.is-active {
                border-color: #77777d; color: #f0f0f2; background: #414146;
            }
            .messages-identity-toggle { transition: border-color 180ms ease, color 180ms ease, background-color 180ms ease, filter 120ms ease; }
            .messages-header .messages-close {
                width: 34px; height: 34px; flex-basis: 34px; margin-left: 4px;
                border-radius: 8px;
            }
            .messages-settings-layer {
                position: absolute; z-index: 8; inset: 0; display: grid; place-items: center;
                padding: 18px; background: rgba(0, 0, 0, .68);
            }
            .messages-settings-layer[hidden] { display: none; }
            .messages-settings-dialog {
                display: flex; width: min(440px, 100%); max-height: calc(100% - 20px);
                flex-direction: column; overflow: hidden; border: 1px solid var(--color-border-dialog);
                border-radius: var(--radius-large); color: var(--color-text-primary);
                background: var(--color-menu); box-shadow: var(--shadow-dialog-strong);
                animation: messages-settings-in 180ms cubic-bezier(.2,.8,.2,1);
            }
            .messages-settings-header {
                display: flex; min-height: 58px; flex: 0 0 auto; align-items: center;
                justify-content: space-between; gap: 12px; padding: 9px 14px;
                border-bottom: 1px solid var(--color-surface-muted); background: var(--color-menu-header);
            }
            .messages-settings-title { margin: 0; color: var(--color-text-heading); font: 800 17px/1.3 var(--font-ui); }
            .messages-settings-close { margin-left: auto; }
            .messages-settings-content {
                display: grid; min-height: 0; gap: 12px; overflow: auto; padding: 14px;
            }
            .messages-settings-card {
                display: grid; gap: 10px; padding: 12px;
                border: 1px solid #39393f; border-radius: var(--radius-medium);
                background: linear-gradient(180deg, #222226, #1d1d20);
            }
            .messages-settings-card.is-danger { border-color: #553b3b; }
            .messages-settings-card-heading { display: grid; gap: 3px; }
            .messages-settings-card-title { margin: 0; color: var(--color-text-primary); font: 800 12px/1.3 var(--font-ui); }
            .messages-settings-card-description {
                margin: 0; color: var(--color-text-muted); font: 650 11px/1.45 var(--font-ui);
            }
            .messages-identity-current {
                display: flex; min-width: 0; align-items: center; gap: 8px;
                padding: 9px; border: 1px solid #34343a; border-radius: var(--radius-control);
                background: #1a1a1d;
            }
            .messages-identity-label { color: var(--color-text-muted); font: 700 10px/1.3 var(--font-ui); }
            .messages-identity-value {
                min-width: 0; flex: 1 1 auto; color: var(--color-text-primary);
                font: 800 12px/1.35 var(--font-ui); overflow-wrap: anywhere;
            }
            .messages-identity-edit { min-height: 30px; flex: 0 0 auto; padding: 0 10px; font-size: 10px; }
            .messages-identity {
                display: grid; gap: 8px; padding: 10px;
                border: 1px solid #414147; border-radius: var(--radius-control); background: #19191c;
                animation: messages-settings-in 180ms cubic-bezier(.2,.8,.2,1);
            }
            .messages-identity[hidden] { display: none; }
            @keyframes messages-settings-in {
                from { opacity: 0; transform: translateY(-6px) scale(.985); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
            .messages-identity label { color: var(--color-text-muted); font: 700 10px/1.2 var(--font-ui); }
            .messages-sender-input {
                width: 100%; min-width: 0; border: 1px solid #48484e; border-radius: 8px;
                padding: 7px 9px; color: var(--color-text-primary); background: #29292d;
                font: 750 12px/1.35 var(--font-ui); outline: none;
                touch-action: manipulation; -webkit-user-select: text; user-select: text;
            }
            .messages-sender-input:focus { border-color: #85858b; box-shadow: 0 0 0 2px #bcbcc01c; }
            .messages-identity-actions, .messages-settings-footer {
                display: flex; justify-content: flex-end; gap: 7px;
            }
            .messages-identity-action, .messages-settings-done {
                min-height: 32px; padding: 0 11px; border: 1px solid #55555b;
                border-radius: var(--radius-control); color: var(--color-text-primary);
                background: #35363a; cursor: pointer; font: 750 11px/1.2 var(--font-ui);
            }
            .messages-identity-action.is-primary, .messages-settings-done {
                border-color: #69696f; background: linear-gradient(180deg, #55555b, #414146);
            }
            .messages-identity-action:hover, .messages-settings-done:hover { filter: brightness(1.1); }
            .messages-settings-footer { flex: 0 0 auto; padding: 0 14px 14px; }
            .messages-settings-status {
                min-height: 16px; margin: 0; padding: 0 14px; color: var(--color-text-muted);
                font: 650 10px/1.4 var(--font-ui); overflow-wrap: anywhere;
            }
            .messages-settings-status:empty { display: none; }
            .messages-clear.report-history-action {
                justify-self: start; min-height: 34px; padding: 0 11px;
                border-color: #714646; color: #f0caca; background: #432d2d;
            }
            .messages-clear-confirmation {
                display: grid; gap: 9px; padding: 10px; border: 1px solid #654747;
                border-radius: var(--radius-control); background: #292323;
                animation: messages-confirm-in 180ms cubic-bezier(.2,.8,.2,1);
            }
            .messages-clear-confirmation[hidden] { display: none; }
            .messages-clear-confirmation p { margin: 0; color: #edb0b0; font: 700 12px/1.35 var(--font-ui); }
            .messages-clear-confirm-actions { display: flex; justify-content: flex-end; gap: 7px; }
            .messages-clear-confirm-action {
                min-height: 34px; padding: 7px 11px; border: 1px solid #55555b;
                border-radius: var(--radius-control); color: var(--color-text-primary);
                background: #35363a;
                cursor: pointer; font: 700 12px/1.2 var(--font-decorative);
            }
            .messages-clear-confirm-action.is-danger { border-color: #885050; background: #7d3d3d; }
            .messages-clear-confirm-action:focus-visible { outline: 2px solid #b8b8bf; outline-offset: 2px; }
            @keyframes messages-confirm-in {
                from { opacity: 0; transform: translateY(6px) scale(.985); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
            .messages-compose { display: flex; flex: 0 0 auto; align-items: flex-end; gap: 8px; margin-top: 10px; }
            .messages-input {
                min-width: 0; flex: 1 1 auto; resize: vertical; min-height: 40px; max-height: 120px;
                border: 1px solid #38383c; border-radius: var(--radius-control); outline: none;
                padding: 9px 11px; color: var(--color-text-primary); background: #222225;
                font: 750 13px/1.45 var(--font-ui);
                touch-action: manipulation; -webkit-user-select: text; user-select: text;
                transition: border-color var(--duration-control) ease, background var(--duration-control) ease, box-shadow var(--duration-control) ease;
            }
            .messages-input::placeholder {
                color: #828286; opacity: 1;
            }
            .messages-input:focus {
                border-color: #77777d; background: #29292d;
                box-shadow: 0 0 0 1px rgba(220, 220, 225, .12);
            }
            .messages-send {
                flex: 0 0 auto; min-width: 82px; min-height: 40px; padding: 8px 12px;
                font: 700 13px/1.45 var(--font-decorative);
                transition: filter var(--duration-fast) ease, transform var(--button-press-duration) ease;
            }
            .messages-send.report-history-action {
                display: inline-flex; align-items: center; justify-content: center; gap: 7px;
                border-color: #55555b; color: var(--color-text-primary);
                background: #35363a; box-shadow: var(--shadow-control-highlight);
            }
            .messages-send.report-history-action:hover { filter: brightness(1.12); }
            .messages-send:disabled { opacity: .55; cursor: default; }
            .messages-row {
                position: relative; z-index: 0;
                display: flex; flex: 0 0 auto; align-self: stretch; box-sizing: border-box;
                width: 100%; align-items: flex-end; justify-content: flex-start; gap: 8px;
            }
            .messages-row.is-new {
                animation: messages-bubble-in 180ms cubic-bezier(.2,.8,.2,1) both;
            }
            .messages-row.is-new.is-outgoing {
                animation: messages-send-from-bottom 320ms cubic-bezier(.18,.78,.24,1) both;
            }
            .messages-row.is-outgoing { justify-content: flex-end; }
            .messages-entry {
                position: relative;
                flex: 0 1 auto; max-width: min(82%, 480px); min-width: 64px; padding: 10px 13px 8px;
                border: 1px solid #45454b; border-radius: 15px 15px 15px 4px;
                background: #2b2b30; box-shadow: 0 4px 12px rgba(0, 0, 0, .16);
            }
            .messages-entry-sender { padding-right: 24px; }
            .messages-entry-actions { position: static; }
            .messages-activity .messages-entry-actions {
                position: absolute; inset: 0; pointer-events: none;
            }
            .messages-entry-more {
                position: absolute; z-index: 5; top: 4px; right: 4px;
                display: grid; width: 24px; height: 24px; place-items: center; padding: 0;
                border: 0; color: #dedee2; background: transparent; box-shadow: none;
                cursor: pointer; font: 900 17px/1 Arial, sans-serif;
                transition: transform 140ms ease, color 140ms ease, text-shadow 140ms ease;
                touch-action: manipulation;
            }
            .messages-activity .messages-entry-more,
            .messages-activity .messages-entry-menu { pointer-events: auto; }
            .messages-entry-more:hover {
                color: #fff; transform: scale(1.12);
            }
            .messages-entry-more:focus-visible {
                outline: none; color: #f0f0f2; text-shadow: 0 0 7px #dedee280;
            }
            .messages-entry-more.button-pressable.is-pressed,
            .messages-entry-more.button-pressable:active {
                color: var(--button-press-foreground); background: transparent;
                box-shadow: none; transform: scale(.88);
            }
            .messages-entry-menu, .messages-entry-delete-confirm {
                position: absolute; z-index: 4; top: 31px;
                display: grid; width: min(250px, calc(100vw - 140px)); gap: 7px;
                padding: 10px; border: 1px solid #55555d; border-radius: 9px;
                color: var(--color-text-primary); background: #242428;
                box-shadow: 0 8px 22px #000b; font: 650 11px/1.35 var(--font-ui);
                animation: messages-action-menu-in 150ms cubic-bezier(.2,.8,.2,1) both;
            }
            .messages-row:not(.is-outgoing) .messages-entry-menu,
            .messages-row:not(.is-outgoing) .messages-entry-delete-confirm { left: 0; right: auto; }
            .messages-row.is-outgoing .messages-entry-menu,
            .messages-row.is-outgoing .messages-entry-delete-confirm { right: 0; }
            .messages-row.is-activity .messages-entry-menu { right: 0; left: auto; }
            .messages-entry-menu[hidden], .messages-entry-delete-confirm[hidden] { display: none; }
            @keyframes messages-action-menu-in {
                from { opacity: 0; transform: translateY(-4px) scale(.98); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
            .messages-entry-id-label { color: var(--color-text-muted); font-weight: 800; }
            .messages-entry-id {
                display: block; overflow-wrap: anywhere; color: #dedee2;
                font: 600 10px/1.4 ui-monospace, Consolas, monospace;
                user-select: text; -webkit-user-select: text;
            }
            .messages-error-log {
                display: grid; max-height: 190px; min-width: 0; gap: 6px; overflow: auto;
                padding: 8px; border: 1px solid #684343; border-radius: 6px; background: #211a1a;
                overscroll-behavior: contain;
            }
            .messages-error-log[hidden] { display: none; }
            .messages-error-log-title {
                color: #f0caca; font: 800 9px/1.25 var(--font-ui); letter-spacing: .55px;
                text-transform: uppercase;
            }
            .messages-error-log-value {
                min-width: 0; margin: 0; color: #e5d7d7;
                font: 600 10px/1.45 ui-monospace, Consolas, monospace;
                overflow-wrap: anywhere; white-space: pre-wrap; user-select: text; -webkit-user-select: text;
            }
            .messages-entry-token-value {
                display: grid; max-height: 150px; gap: 6px; overflow: auto; padding: 8px;
                border: 1px solid #44444b; border-radius: 6px; background: #19191c;
                overscroll-behavior: contain;
            }
            .messages-entry-token-value[hidden] { display: none; }
            .messages-entry-token-label { color: var(--color-text-muted); font: 800 9px/1.2 var(--font-ui); }
            .messages-entry-token-code {
                color: #dedee2; font: 600 10px/1.4 ui-monospace, Consolas, monospace;
                overflow-wrap: anywhere; user-select: text; -webkit-user-select: text;
            }
            .messages-entry-token-warning {
                margin: 0; color: #e6d49c; font: 700 10px/1.35 var(--font-ui);
            }
            .messages-entry-token-actions { display: flex; gap: 6px; }
            .messages-entry-token-actions .messages-entry-action {
                min-height: 28px; flex: 1; padding: 5px 7px; text-align: center;
            }
            .messages-entry-action {
                min-height: 30px; padding: 6px 8px; border: 1px solid #505057;
                border-radius: 6px; color: var(--color-text-primary); background: #38383e;
                cursor: pointer; font: 700 11px/1.25 var(--font-ui); text-align: left;
                transition: transform 120ms ease, color 120ms ease, background 120ms ease, border-color 120ms ease;
            }
            .messages-entry-action:hover { filter: brightness(1.13); }
            .messages-entry-action:focus-visible { outline: 2px solid #b8b8bf; outline-offset: 2px; }
            .messages-settings-dialog .report-history-action:focus-visible,
            .messages-identity-action:focus-visible, .messages-settings-done:focus-visible,
            .messages-settings-close:focus-visible {
                outline: 2px solid #b8b8bf; outline-offset: 2px;
            }
            .messages-entry-action:disabled { opacity: .55; cursor: not-allowed; filter: none; }
            .messages-entry-action.is-danger { border-color: #714646; color: #ffc3c3; background: #4a2d2d; }
            .messages-entry-delete-confirm {
                width: min(280px, calc(100vw - 140px));
                border-color: #755252; background: #302525;
            }
            .messages-entry-delete-confirm p { margin: 0; color: #f0caca; }
            .messages-entry-delete-actions { display: flex; justify-content: flex-end; gap: 6px; }
            .messages-entry:not(.is-outgoing)::before,
            .messages-entry:not(.is-outgoing)::after,
            .messages-entry.is-outgoing::before,
            .messages-entry.is-outgoing::after {
                position: absolute; width: 0; height: 0;
                border-top: 7px solid transparent; border-bottom: 7px solid transparent;
                content: ""; pointer-events: none;
            }
            .messages-entry:not(.is-outgoing)::before {
                bottom: 7px; left: -9px; border-right: 9px solid #45454b;
            }
            .messages-entry:not(.is-outgoing)::after {
                bottom: 8px; left: -7px;
                border-top-width: 6px; border-bottom-width: 6px; border-right: 8px solid #2b2b30;
            }
            .messages-row:not(.is-outgoing) .messages-entry { margin-right: auto; }
            .messages-row.is-outgoing .messages-entry { margin-left: auto; }
            .messages-entry.is-outgoing {
                border-color: #675638;
                background: #302d26;
            }
            .messages-entry.is-outgoing::before {
                right: -9px; bottom: 7px; border-left: 9px solid #675638;
            }
            .messages-entry.is-outgoing::after {
                right: -7px; bottom: 8px;
                border-top-width: 6px; border-bottom-width: 6px; border-left: 8px solid #302d26;
            }
            .messages-row.is-activity { justify-content: flex-end; padding: 3px 0; }
            .messages-activity {
                position: relative;
                display: grid; box-sizing: border-box; width: min(82%, 480px);
                margin-right: 46px; margin-left: auto;
                grid-template-columns: 42px minmax(0, 1fr);
                align-items: start; gap: 11px; padding: 12px;
                border: 1px solid #414148; border-radius: var(--radius-control);
                background: linear-gradient(145deg, #29292e, #222226);
                box-shadow: var(--shadow-control-highlight), inset 0 1px 0 #ffffff0b;
            }
            .messages-activity-avatar, .messages-activity-icon {
                display: grid; width: 42px; height: 42px; flex: 0 0 42px; place-items: center;
                overflow: hidden; border: 1px solid #55555b; border-radius: var(--radius-control);
                background: #252529; box-shadow: 0 2px 6px #0005;
            }
            .messages-activity-avatar { object-fit: cover; }
            .messages-activity-icon {
                color: #9ee5ad; border-color: #39744c; background: linear-gradient(145deg, #287444, #174c30);
            }
            .messages-activity-icon.is-call {
                position: relative; isolation: isolate; overflow: visible;
                border-color: #64c887;
                color: #e0ffe8;
                background: radial-gradient(circle at 28% 20%, #398654, #21653e 58%, #17482e);
                box-shadow: 0 3px 8px #0007, inset 0 1px 0 #ffffff35, inset 0 -2px 0 #0d3821;
            }
            .messages-activity-icon.is-call::before {
                position: absolute; z-index: -1; inset: 3px; border: 1px solid #ffffff22;
                border-radius: 4px; content: ""; pointer-events: none;
            }
            .messages-activity-icon svg {
                width: 23px; height: 23px; fill: none; stroke: currentColor;
                stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
            }
            .messages-activity-icon.is-call svg {
                width: 26px; height: 26px; filter: drop-shadow(0 1px 1px #0b2a18);
            }
            .messages-activity-call-tag {
                position: absolute; right: -4px; bottom: -3px; padding: 2px 3px;
                border: 1px solid #21492f; border-radius: 3px;
                color: #edfff1; background: linear-gradient(180deg, #397c4e, #205333);
                box-shadow: 0 1px 3px #0008; font: 900 6px/1 var(--font-ui); letter-spacing: .25px;
            }
            .messages-activity-content { display: grid; min-width: 0; gap: 5px; }
            .messages-activity-heading {
                display: flex; min-width: 0; align-items: center; justify-content: space-between;
                flex-wrap: wrap; gap: 4px 8px; padding-right: 24px;
            }
            .messages-activity-title {
                color: #c8c8ce; font: 800 10px/1.3 var(--font-ui);
                letter-spacing: .45px; text-transform: uppercase;
            }
            .messages-activity-target {
                min-width: 0; color: #f0f0f2; font: 800 13px/1.35 var(--font-ui);
                overflow-wrap: anywhere;
            }
            .messages-activity-meta {
                display: flex; flex-wrap: wrap; gap: 4px 10px; color: #9fa0a7;
                font: 650 10px/1.4 var(--font-ui);
            }
            .messages-activity-id {
                overflow-wrap: anywhere; color: #c5c5cc;
                font-family: ui-monospace, Consolas, monospace;
            }
            .messages-activity-room { overflow-wrap: anywhere; }
            .messages-activity-view {
                justify-self: start; min-height: 28px; margin-top: 2px; padding: 0 11px;
                border-radius: var(--radius-control); color: var(--color-white);
                font: 800 11px/1 var(--font-decorative);
            }
            .messages-entry.is-unread { border-left: 3px solid #77c8f2; }
            .messages-entry-avatar {
                display: block; flex: 0 0 38px; width: 38px; height: 38px; border: 1px solid #55555b;
                border-radius: var(--radius-control); object-fit: cover; background: #252525;
                box-shadow: 0 2px 6px rgba(0, 0, 0, .28);
            }
            .messages-entry-sender {
                display: flex; min-width: 0; align-items: center; gap: 4px;
                margin-bottom: 4px; color: #aebdc6;
                font: 800 10px/1.2 var(--font-ui); letter-spacing: .2px;
            }
            .messages-verified-badge {
                display: inline-flex; flex: 0 0 15px; width: 15px; height: 15px;
                align-items: center; justify-content: center;
            }
            .messages-verified-badge svg { display: block; width: 100%; height: 100%; }
            .icons8-attribution-link { color: #80c9f0; text-decoration: underline; }
            .messages-entry-sender-name { min-width: 0; overflow-wrap: anywhere; }
            .messages-entry.is-outgoing .messages-entry-sender-name { color: #e2bd78; }
            .messages-entry-body {
                margin: 0; color: var(--color-text-primary); font: 650 13px/1.5 var(--font-ui);
                overflow-wrap: anywhere; white-space: pre-wrap;
            }
            .messages-entry-meta {
                display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px 8px;
                margin-top: 5px; color: #9fa4a8; font: 650 9px/1.35 var(--font-ui);
            }
            .messages-entry-status {
                display: block; width: 62px; min-height: 12px; flex: 0 0 62px;
                color: #d0d0d4; text-align: right; white-space: nowrap;
                transition: color 180ms ease, opacity 180ms ease;
            }
            .messages-entry-status.is-error {
                color: #ffaaaa;
            }
            @keyframes messages-bubble-in {
                from { opacity: 0; transform: translateY(7px) scale(.98); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
            @keyframes messages-send-from-bottom {
                from { opacity: 0; transform: translateY(30px) scale(.96); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
            .messages-status { flex: 0 0 auto; margin: 7px 0 0; color: var(--color-text-muted); font: 600 11px/1.4 var(--font-ui); }
            .messages-status:empty { display: none; }
            .message-notification-stack {
                position: fixed; z-index: 22; top: max(16px, env(safe-area-inset-top)); left: 50%;
                display: grid; width: min(350px, calc(100vw - 24px)); max-height: min(150px, calc(100vh - 32px));
                overflow: hidden; pointer-events: none; transform: translateX(-50%);
            }
            .message-notification-stack[hidden] { display: none; }
            .message-notification-toast {
                position: relative; width: 100%; overflow: hidden; pointer-events: auto;
                border: 1px solid #3c5962; border-radius: 12px;
                color: var(--color-text-description);
                background: linear-gradient(145deg, #263238, #1d2529);
                box-shadow: 0 8px 22px #0009, inset 0 1px 0 #ffffff0d;
                font: 650 12px/1.45 var(--font-ui); text-shadow: 0 1px 1px var(--color-shadow);
            }
            .message-notification-toast.is-entering { animation: message-notification-enter ${MESSAGE_NOTIFICATION_ANIMATION_MS}ms cubic-bezier(.2, .8, .2, 1) both; }
            .message-notification-toast.is-closing {
                pointer-events: none;
                animation: message-notification-exit ${MESSAGE_NOTIFICATION_ANIMATION_MS}ms ease-in both;
            }
            .message-notification-open {
                position: relative; z-index: 1; display: grid; width: 100%;
                grid-template-columns: minmax(0, 1fr) 30px; align-items: center; gap: 8px;
                padding: 10px 11px 12px; border: 0; border-radius: inherit;
                color: inherit; background: transparent; cursor: pointer; text-align: left;
                font: inherit; text-shadow: inherit;
                transition: background 160ms ease, transform 140ms ease;
                touch-action: manipulation;
            }
            .message-notification-open:hover,
            .message-notification-open:focus-visible { background: #9acbd10c; }
            .message-notification-open:focus-visible { outline: 2px solid #6fa7b4; outline-offset: -3px; }
            .message-notification-open:active { transform: scale(.99); }
            .message-notification-open:disabled { cursor: default; }
            .message-notification-header {
                display: flex; min-width: 0; grid-column: 1 / -1;
                align-items: center; gap: 9px; padding-right: 58px;
            }
            .message-notification-icon {
                display: grid; width: 32px; height: 32px; flex: 0 0 32px; place-items: center;
                border: 1px solid #5b829050; border-radius: 9px;
                color: #a4cbd3; background: #456a751e;
            }
            .message-notification-icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
            .message-notification-heading { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
            .message-notification-eyebrow { color: #91bbc5; font: 800 8px/1.2 var(--font-ui); letter-spacing: .6px; text-transform: uppercase; }
            .message-notification-header strong { color: #e5eef0; font: 800 12px/1.3 var(--font-ui); }
            .message-notification-copy {
                display: -webkit-box; grid-column: 1; max-height: 2.8em; overflow: hidden; margin: 0;
                color: #bcc9cc; font: 600 11px/1.4 var(--font-ui);
                overflow-wrap: anywhere; white-space: pre-wrap; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
            }
            .message-notification-view-icon {
                display: grid; width: 28px; height: 28px; grid-column: 2; grid-row: 2;
                place-items: center; border: 1px solid #5b82905c; border-radius: 8px;
                color: #a8cbd2; background: #456a7525;
                transition: color 160ms ease, background 160ms ease, transform 160ms ease;
            }
            .message-notification-open:hover .message-notification-view-icon,
            .message-notification-open:focus-visible .message-notification-view-icon {
                color: #e5f6f8; background: #456a7560; transform: scale(1.04);
            }
            .message-notification-view-icon svg {
                width: 15px; height: 15px; fill: none; stroke: currentColor;
                stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;
            }
            .message-notification-mute {
                position: absolute; z-index: 2; top: 7px; right: 42px;
                display: grid; width: 26px; height: 26px; place-items: center; padding: 0;
                border: 1px solid #54717a66; border-radius: 8px; color: #abc2c7;
                background: #34444a; cursor: pointer;
                transition: color 140ms ease, background 140ms ease, transform 140ms ease;
                touch-action: manipulation;
            }
            .message-notification-mute:hover,
            .message-notification-mute:focus-visible { color: #fff; background: #46616a; }
            .message-notification-mute:focus-visible { outline: 2px solid #6fa7b4; outline-offset: 2px; }
            .message-notification-mute:active { transform: scale(.92); }
            .message-notification-mute svg {
                width: 15px; height: 15px; fill: none; stroke: currentColor;
                stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;
            }
            .message-notification-mute[hidden] { display: none; }
            .message-notification-close { position: absolute; z-index: 2; top: 5px; right: 5px; width: 30px; height: 30px; }
            .message-notification-progress { position: absolute; right: 0; bottom: 0; left: 0; height: 2px; background: #ffffff12; }
            .message-notification-progress-fill {
                display: block; width: 100%; height: 100%; background: linear-gradient(90deg, #4a8290, #9bcbd3);
                transform-origin: left center;
            }
            .message-notification-progress-fill.is-running {
                animation: message-notification-countdown ${MESSAGE_NOTIFICATION_DURATION_MS}ms linear forwards;
            }
            @keyframes message-notification-enter {
                from { opacity: 0; filter: blur(3px); transform: translateY(-8px) scale(.98); }
                to { opacity: 1; filter: blur(0); transform: translateY(0) scale(1); }
            }
            @keyframes message-notification-exit {
                to { opacity: 0; filter: blur(2px); transform: translateY(-6px) scale(.98); }
            }
            @keyframes message-notification-countdown {
                from { transform: scaleX(1); }
                to { transform: scaleX(0); }
            }
            @media (prefers-reduced-motion: reduce) {
                .message-notification-toast.is-entering, .message-notification-toast.is-closing,
                .message-notification-progress-fill.is-running { animation: none; }
                .message-notification-open, .message-notification-view-icon,
                .message-notification-mute { transition: none; }
            }
            .report-details-layer { z-index: 7; background: rgba(0, 0, 0, 0.46); }
            .report-details-layer[hidden] { display: none; }
            .report-details-dialog {
                display: flex; width: min(470px, 100%); max-height: calc(100vh - 36px);
                flex-direction: column; overflow: hidden; padding: 18px;
                border: 1px solid var(--color-border-dialog); border-radius: var(--radius-large);
                color: var(--color-text-primary); background: var(--color-menu-header); box-shadow: var(--shadow-dialog);
            }
            .report-details-content { min-height: 0; overflow: auto; padding: 1px 3px 4px 1px; }
            .report-history-layer { z-index: 6; }
            .report-history-layer[hidden] { display: none; }
            .report-history-header {
                min-height: 58px; flex: 0 0 auto; margin: -18px -18px 12px; padding: 9px 14px;
                border-bottom: 1px solid var(--color-surface-muted); background: var(--color-menu-header);
            }
            .report-history-tabs {
                display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 3px;
                margin: 0 0 12px; padding: 4px; border: 1px solid #343438;
                border-radius: var(--radius-medium); background: #1d1d20;
                box-shadow: inset 0 1px 2px #0005;
            }
            .report-history-tab {
                display: flex; min-width: 0; min-height: 34px; align-items: center; justify-content: center;
                gap: 6px; padding: 0 7px; border: 1px solid transparent;
                border-radius: var(--radius-control); color: #a7a7ad;
                background: transparent; cursor: pointer; font: 750 11px/1 var(--font-decorative);
                transition: color 140ms ease, background 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
            }
            .report-history-tab:hover { color: #e8e1d4; background: #ffffff08; }
            .report-history-tab[aria-pressed="true"] {
                border-color: #62563d; color: #f0dfba;
                background: linear-gradient(180deg, #3b3529, #2c2923);
                box-shadow: inset 0 1px 0 #ffffff12, 0 2px 5px #0005;
            }
            .report-history-tab:focus-visible { outline: 2px solid #c5a96a; outline-offset: 2px; }
            .report-history-tab-count {
                min-width: 17px; padding: 3px 5px; border: 1px solid #44444a; border-radius: 999px;
                color: #a7a7ad; background: #29292d; font: 700 9px/1 var(--font-ui); text-align: center;
            }
            .report-history-tab[aria-pressed="true"] .report-history-tab-count {
                border-color: #746342; color: #f0dfba; background: #49402f;
            }
            .report-history-empty { margin: 8px 0; color: var(--color-text-muted); font: 700 13px/1.45 var(--font-ui); text-align: center; }
            .report-history-tools { flex: 0 0 auto; margin: 0 0 8px; }
            .report-history-clear-open {
                display: block; min-height: 30px; margin-left: auto; padding: 0 12px;
                color: var(--color-white); font: 800 12px/1 var(--font-decorative);
            }
            .report-history-clear-open:disabled,
            .report-history-clear-choice:disabled { opacity: .45; cursor: not-allowed; filter: none; }
            .report-history-clear-panel {
                display: flex; max-height: 0; flex-direction: column; gap: 8px; overflow: hidden;
                margin-top: 0; padding: 0 10px; border: 1px solid transparent;
                border-radius: var(--radius-control); background: #222225;
                opacity: 0; pointer-events: none; transform: translateY(-5px);
                transition: max-height ${REPORT_HISTORY_CLEAR_PANEL_DURATION_MS}ms cubic-bezier(.2, .8, .2, 1),
                    margin-top ${REPORT_HISTORY_CLEAR_PANEL_DURATION_MS}ms ease,
                    padding ${REPORT_HISTORY_CLEAR_PANEL_DURATION_MS}ms ease,
                    border-color 160ms ease, opacity 160ms ease, transform 200ms ease;
            }
            .report-history-clear-panel.is-open {
                max-height: 240px; margin-top: 8px; padding: 10px; border-color: #38383c;
                opacity: 1; pointer-events: auto; transform: translateY(0);
            }
            .report-history-clear-panel[hidden],
            .report-history-clear-options[hidden],
            .report-history-clear-confirmation[hidden],
            .report-history-clear-status[hidden] { display: none; }
            .report-history-clear-description {
                margin: 0; color: var(--color-text-description); font: 700 12px/1.4 var(--font-ui);
            }
            .report-history-clear-options { display: flex; flex-direction: column; gap: 8px; }
            .report-history-clear-choice-row,
            .report-history-clear-confirmation-actions {
                display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 7px;
            }
            .report-history-clear-choice,
            .report-history-clear-cancel,
            .report-history-clear-confirm {
                min-height: 29px; padding: 0 10px; font: 700 11px/1 var(--font-decorative);
            }
            .report-history-clear-confirm {
                border-color: #784343; color: #ffe4e4; background: linear-gradient(180deg, #623737, #432626);
            }
            .report-history-clear-confirm:hover { filter: brightness(1.12); }
            .report-history-clear-status {
                flex: 0 0 auto; margin: 4px 0 8px; color: var(--color-text-description);
                font: 700 12px/1.4 var(--font-ui);
            }
            .report-history-list { display: flex; min-height: 0; flex-direction: column; gap: 8px; overflow: auto; }
            .report-history-list[hidden] { display: none; }
            .report-history-entry {
                display: grid; grid-template-columns: 42px minmax(0, 1fr) auto; align-items: start;
                column-gap: 10px; row-gap: 8px; padding: 10px;
                border: 1px solid #38383c; border-radius: var(--radius-control); background: #222225;
            }
            .report-history-avatar { width: 42px; height: 42px; border-radius: var(--radius-control); object-fit: cover; }
            .report-history-entry-content { grid-column: 2; min-width: 0; }
            .report-history-entry-heading { display: flex; min-width: 0; align-items: flex-start; }
            .report-history-entry-heading-copy { min-width: 0; flex: 1; }
            .report-history-target { display: block; color: var(--color-text-heading); font: 800 14px/1.3 var(--font-ui); overflow-wrap: anywhere; }
            .report-history-meta { display: block; margin-top: 3px; color: var(--color-text-muted); font: 600 11px/1.35 var(--font-ui); }
            .report-history-id-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 9px; }
            .report-history-token-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 8px; }
            .report-history-token-toggle {
                min-height: 27px; padding: 0 9px; color: var(--color-text-secondary);
                font: 750 10px/1 var(--font-ui);
            }
            .report-history-token-toggle:disabled { opacity: .55; cursor: not-allowed; filter: none; }
            .report-history-token-value {
                display: grid; max-height: 150px; min-width: 0; gap: 6px; overflow: auto;
                margin-top: 8px; padding: 8px 9px;
                border: 1px solid #3c3c42; border-radius: var(--radius-control); background: #171719;
                overscroll-behavior: contain;
            }
            .report-history-token-value[hidden] { display: none; }
            .report-history-token-value:not([hidden]) {
                transform-origin: top center;
                animation: report-history-token-enter ${REPORT_HISTORY_TOKEN_DETAILS_DURATION_MS}ms cubic-bezier(.2, .8, .2, 1) both;
            }
            @keyframes report-history-token-enter {
                from { opacity: 0; transform: translateY(-8px) scaleY(.88); }
                to { opacity: 1; transform: translateY(0) scaleY(1); }
            }
            .report-history-token-value.is-closing {
                transform-origin: top center;
                animation: report-history-token-exit ${REPORT_HISTORY_TOKEN_DETAILS_DURATION_MS}ms cubic-bezier(.4, 0, .8, .2) both;
            }
            @keyframes report-history-token-exit {
                from { opacity: 1; transform: translateY(0) scaleY(1); }
                to { opacity: 0; transform: translateY(-8px) scaleY(.88); }
            }
            .report-history-token-label {
                color: var(--color-text-muted); font: 800 9px/1.2 var(--font-ui); letter-spacing: .55px;
            }
            .report-history-token-value code {
                color: #d7d7de; font: 650 11px/1.4 Consolas, "Courier New", monospace;
                overflow-wrap: anywhere; user-select: text;
            }
            .report-history-token-warning {
                margin: 0; color: #e6d49c; font: 700 10px/1.35 var(--font-ui);
            }
            .report-history-token-controls { display: flex; gap: 6px; }
            .report-history-token-controls .report-history-action {
                min-height: 28px; flex: 1; padding: 5px 7px; font-size: 10px; text-align: center;
            }
            .report-history-token-controls .report-history-action:disabled {
                opacity: .55; cursor: not-allowed; filter: none;
            }
            .report-history-id-value {
                display: inline-flex; min-height: 28px; align-items: center; gap: 7px;
                padding: 3px 9px; border: 1px solid #44444a; border-radius: var(--radius-small); background: #171719;
            }
            .report-history-id-label { color: #a4a4aa; font: 800 9px/1 var(--font-ui); letter-spacing: .65px; }
            .report-history-id-row code {
                color: #fff; font: 800 13px/1.2 ui-monospace, Consolas, monospace; letter-spacing: .5px;
            }
            .report-history-action {
                border: 1px solid #49494f; border-radius: var(--radius-control);
                color: var(--color-text-primary);
                background: linear-gradient(180deg, var(--color-control-highlight), var(--color-control-shadow));
                box-shadow: var(--shadow-control-highlight); cursor: pointer;
                font-family: var(--font-decorative); font-weight: 700;
                transition: filter var(--duration-fast) ease;
            }
            .report-history-action:hover { filter: brightness(1.08); }
            .report-history-action:focus-visible { outline: 2px solid #d8ff52; outline-offset: 2px; }
            .report-history-details-toggle {
                grid-column: 3; align-self: center; justify-self: end; min-width: 104px; min-height: 30px;
                padding: 0 13px; border-color: #55555b; border-radius: var(--radius-control);
                color: var(--color-white); background: linear-gradient(180deg, var(--color-control-highlight), var(--color-control-shadow));
                font: 800 12px/1 var(--font-decorative);
            }
            .report-details-summary {
                display: flex; align-items: center; gap: 13px; padding: 14px;
                border: 1px solid #3b3b40; border-radius: var(--radius-control); background: #222225;
            }
            .report-details-avatar {
                width: 54px; height: 54px; flex: 0 0 54px;
                border: 1px solid #505056; border-radius: var(--radius-control); object-fit: cover;
            }
            .report-details-summary-copy { min-width: 0; flex: 1; }
            .report-details-copyable { display: flex; min-width: 0; align-items: center; gap: 8px; }
            .report-details-copyable > [data-report-detail] { min-width: 0; flex: 1; }
            .report-details-player { margin: 0; color: var(--color-text-heading); font: 850 18px/1.25 var(--font-ui); overflow-wrap: anywhere; }
            .report-details-state { margin: 4px 0 0; color: var(--color-text-muted); font: 600 11px/1.4 var(--font-ui); }
            .report-details-reason {
                margin-top: 11px; padding: 12px 13px; border-left: 3px solid #68686f;
                border-radius: 0 var(--radius-control) var(--radius-control) 0; background: #222225;
            }
            .report-details-section-label {
                display: block; color: var(--color-text-muted); font: 800 9px/1.4 var(--font-ui);
                letter-spacing: .65px; text-transform: uppercase;
            }
            .report-details-reason-value { align-items: flex-start; margin-top: 5px; }
            .report-details-reason-text {
                margin: 0; color: var(--color-text-primary); font: 650 13px/1.5 var(--font-ui);
                overflow-wrap: anywhere; white-space: pre-wrap;
            }
            .report-details-facts {
                display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 10px;
            }
            .report-details-fact {
                display: flex; min-width: 0; flex-direction: column; gap: 4px; padding: 9px 10px;
                border: 1px solid #38383d; border-radius: var(--radius-control); background: #222225;
            }
            .report-details-fact[hidden] { display: none; }
            .report-details-fact span {
                color: #969ba1; font: 800 9px/1.4 var(--font-ui); letter-spacing: .55px; text-transform: uppercase;
            }
            .report-details-fact strong {
                min-width: 0; color: var(--color-text-primary); font: 650 11px/1.45 var(--font-ui);
                overflow-wrap: anywhere; word-break: break-word;
            }
            .report-details-fact-wide { grid-column: 1 / -1; }
            .report-details-copy {
                position: relative; align-self: center; overflow: visible; appearance: none; box-sizing: border-box;
                display: grid; width: 28px; height: 28px; flex: 0 0 28px; place-items: center;
                margin: 0; padding: 0; border-radius: var(--radius-control); line-height: 0;
            }
            .report-copy-icon-stack { position: relative; display: grid; width: 18px; height: 18px; place-items: center; }
            .report-copy-icon-stack svg {
                position: absolute; inset: 0; width: 18px; height: 18px; overflow: visible;
                fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round;
                opacity: 0; transform: scale(.72);
                transition: opacity 150ms ease, transform 260ms cubic-bezier(.2, .8, .2, 1);
            }
            .report-copy-icon-stack svg .report-copy-back {
                fill: currentColor; stroke: none; opacity: .3;
            }
            .report-copy-icon-stack svg .report-copy-line { stroke-width: 2; opacity: .82; }
            .report-copy-icon-stack svg.report-copy-icon-copy { opacity: 1; transform: scale(1); }
            .report-copy-icon-stack svg.report-copy-icon-success { stroke-width: 1.9; }
            .report-details-copy.is-copied .report-copy-icon-copy { opacity: 0; transform: scale(.72) rotate(-8deg); }
            .report-details-copy.is-copied .report-copy-icon-success { opacity: 1; transform: scale(1); }
            .report-details-copy.is-copy-failed .report-copy-icon-copy { opacity: 0; transform: scale(.72) rotate(8deg); }
            .report-details-copy.is-copy-failed .report-copy-icon-failure { opacity: 1; transform: scale(1); }
            .report-details-copy.is-copied { border-color: #717178; color: #fff; background: #4a4a50; }
            .report-details-copy.is-copied { animation: report-copy-confirm 520ms cubic-bezier(.2, .8, .2, 1); }
            .report-details-copy.is-copied::after {
                position: absolute; inset: -3px; border: 1px solid #c9c9cf;
                border-radius: inherit; content: ""; pointer-events: none;
                animation: report-copy-ring 420ms ease-out both;
            }
            .report-details-copy.is-copy-failed { border-color: #9c4a4a; color: #ffc0c0; background: #3b2222; }
            @keyframes report-copy-confirm {
                0% { transform: scale(.9); }
                52% { transform: scale(1.14); }
                100% { transform: scale(1); }
            }
            @keyframes report-copy-ring {
                from { opacity: .75; transform: scale(.78); }
                to { opacity: 0; transform: scale(1.55); }
            }
            @media (max-width: 420px) {
                .report-history-entry { grid-template-columns: 42px minmax(0, 1fr); }
                .report-history-details-toggle { grid-column: 1 / -1; align-self: auto; }
                .report-details-facts { grid-template-columns: minmax(0, 1fr); }
                .report-details-fact-wide { grid-column: auto; }
            }
            .report-id-copy {
                width: 28px; min-height: 28px; padding: 0;
                border-color: #4b6255; color: #e4f3e8;
                background: linear-gradient(180deg, #3d7556, #28563d);
            }
            .report-id-copy:disabled { cursor: wait; }
            .report-id-copy.is-copied { border-color: #76a98a; color: #fff; background: #39734f; }
            .report-id-copy.is-copy-failed { border-color: #9c4a4a; color: #ffc0c0; background: #3b2222; }
            .report-history-status {
                position: absolute; width: 1px; height: 1px; overflow: hidden;
                clip: rect(0, 0, 0, 0); clip-path: inset(50%); white-space: nowrap;
            }
            .report-dialog-header {
                display: flex; align-items: center; gap: 11px; margin-bottom: 16px;
            }
            .report-dialog-header > div { min-width: 0; flex: 1; }
            .report-dialog-avatar {
                width: 48px; height: 48px; flex: 0 0 48px; border-radius: var(--radius-card); object-fit: cover;
            }
            .report-dialog-title {
                min-width: 0; overflow: hidden; margin: 0; color: var(--color-white); font-size: 18px; font-weight: 800;
                text-overflow: ellipsis; white-space: nowrap;
            }
            .report-dialog-subtitle {
                color: var(--color-text-secondary); font: 700 12px/1.35 var(--font-decorative);
                letter-spacing: -0.15px; text-shadow: 0 1px 1px var(--color-shadow);
            }
            .report-form { display: flex; flex-direction: column; gap: 12px; }
            .report-field { display: flex; flex-direction: column; gap: 5px; }
            .report-field label { color: var(--color-text-subtle); font-size: 12px; font-weight: 750; }
            .report-target-label-row { display: flex; align-items: center; gap: 6px; }
            .report-target-help {
                display: grid; width: 17px; height: 17px; place-items: center; padding: 0;
                border: 1px solid #77777d; border-radius: 50%; color: var(--color-text-secondary);
                background: transparent; cursor: help; font: 800 11px/1 Arial, sans-serif;
            }
            .report-target-help[hidden] { display: none; }
            .report-target-help:hover, .report-target-help:focus-visible {
                border-color: var(--color-white); color: var(--color-white);
            }
            .report-field input, .report-field select, .report-field textarea {
                width: 100%; border: 1px solid #38383c; border-radius: var(--radius-medium); outline: none;
                padding: 11px 13px; color: var(--color-text-primary); background: #222225;
                font: inherit; font-size: 15px; font-weight: 750; transition: background var(--duration-control) ease, border-color var(--duration-control) ease;
                touch-action: manipulation; -webkit-user-select: text; user-select: text;
            }
            .report-field input::placeholder, .report-field textarea::placeholder { color: #828286; opacity: 1; }
            .report-field input:focus, .report-field textarea:focus {
                border-color: #77777d; background: #29292d;
            }
            .report-field textarea {
                min-height: 92px; resize: vertical; line-height: 1.45;
            }
            .report-character-count {
                align-self: flex-end; color: var(--color-text-muted);
                font: 600 11px/1.3 var(--font-ui); text-align: right;
            }
            .report-character-count[data-limit-reached="true"] { color: #ff7777; }
            .reason-select { position: relative; }
            .reason-control { display: flex; flex-direction: column; gap: 5px; transform: scale(1); transition: transform var(--button-press-duration) ease; }
            .reason-trigger {
                display: flex; width: 100%; min-height: 40px; align-items: center; justify-content: space-between;
                padding: 0 11px; border: 0; border-radius: var(--radius-control); color: var(--color-text-primary);
                background: #3c3c3f; cursor: pointer; font-size: 14px; font-weight: 750; text-align: left;
            }
            .reason-trigger:hover { background: #464649; }
            .reason-trigger:focus-visible, .reason-option:focus-visible {
                outline: 2px solid #d6d6d6; outline-offset: 1px;
            }
            .reason-options {
                position: absolute; z-index: 3; top: calc(100% + 4px); right: 0; left: 0;
                max-height: 220px; overflow-y: auto; overflow-x: hidden; padding: 4px; border: 1px solid #4a4a4d;
                border-radius: var(--radius-card); background: #3b3b3e; box-shadow: 0 8px 20px var(--color-shadow);
                transform-origin: top center; animation: reason-options-enter var(--duration-dropdown) ease-out both;
            }
            .reason-chevron { margin-left: 10px; color: var(--color-text-primary); font-size: 12px; line-height: 1; }
            .reason-options[hidden] { display: none; }
            @keyframes reason-options-enter {
                from { opacity: 0; transform: scaleY(.94); }
                to { opacity: 1; transform: scaleY(1); }
            }
            .reason-option {
                display: flex; width: 100%; min-height: 40px; align-items: center; gap: 9px;
                padding: 4px 8px; border: 0; border-radius: var(--radius-small); color: var(--color-text-bright);
                background: transparent; cursor: pointer; font-size: 14px; font-weight: 750; text-align: left;
            }
            .reason-option:hover, .reason-option[aria-selected="true"] { background: #4b4b4e; }
            .reason-option-icon {
                display: grid; width: 25px; height: 25px; flex: 0 0 25px; place-items: center;
                clip-path: polygon(14% 0, 86% 0, 100% 20%, 92% 72%, 50% 100%, 8% 72%, 0 20%);
                color: var(--color-menu); background: #d6d6d6; font-size: 15px; font-weight: 900;
                line-height: 1; text-shadow: 0 1px 0 #ffffff70;
            }
            .reason-option-icon svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
            .reason-option-icon.cheating { color: var(--color-white); background: #d83232; }
            .reason-option-icon.harassment { color: var(--color-white); background: #9c44b7; }
            .reason-option-icon.inappropriate { background: #f3d32c; }
            .reason-option-icon.griefing { color: var(--color-white); background: #3aa84d; }
            .reason-option-icon.invisibility { color: var(--color-white); background: #48a9b8; }
            .reason-option-icon.aimbot { color: var(--color-white); background: #e37b32; }
            .reason-option-icon.flying { color: var(--color-white); background: #438dd2; }
            .reason-option-icon.wallhack { color: var(--color-white); background: #855ac2; }
            .reason-option-icon.other { background: #a9a9ac; }
            .reason-option-check { margin-left: auto; font-size: 17px; }
            .button-pressable {
                transition:
                    transform var(--button-press-duration) ease,
                    background-color var(--button-press-duration) ease,
                    color var(--button-press-duration) ease,
                    border-color var(--button-press-duration) ease,
                    filter var(--button-press-duration) ease;
            }
            .launcher-call-kbi.button-pressable {
                transition: transform 180ms ease, box-shadow 180ms ease,
                    border-color 180ms ease, opacity 180ms ease, visibility 0s linear 180ms;
            }
            .launcher-quick-messages.button-pressable {
                transition: opacity 180ms ease, transform 180ms ease, visibility 0s linear 180ms,
                    background 180ms ease, box-shadow 180ms ease, border-color 180ms ease,
                    top 260ms cubic-bezier(.22, .61, .36, 1);
            }
            .launcher-call-kbi.is-visible.button-pressable,
            .launcher-quick-messages.is-visible.button-pressable {
                transition-delay: 0s;
            }
            @media (prefers-reduced-motion: reduce) {
                .info-dialog, .changelog-dialog, .settings-dialog, .report-dialog, .report-history-dialog, .messages-dialog, .report-details-dialog, .verification-layer, .verification-dialog, .update-method-dialog, .reason-options,
                .popup-layer.is-closing, .popup-layer.is-closing > .info-dialog, .popup-layer.is-closing > .changelog-dialog, .popup-layer.is-closing > .settings-dialog,
                .popup-layer.is-closing > .report-dialog, .popup-layer.is-closing > .report-history-dialog, .popup-layer.is-closing > .messages-dialog, .popup-layer.is-closing > .report-details-dialog, .popup-layer.is-closing > .verification-dialog, .popup-layer.is-closing > .update-method-dialog,
                .popup-layer.is-closing > .menu-call-link-dialog,
                .popup-layer:not(.is-closing), .popup-layer:not(.is-closing) > .info-dialog, .popup-layer:not(.is-closing) > .changelog-dialog,
                .popup-layer:not(.is-closing) > .settings-dialog, .popup-layer:not(.is-closing) > .report-dialog,
                .popup-layer:not(.is-closing) > .report-history-dialog, .popup-layer:not(.is-closing) > .messages-dialog, .popup-layer:not(.is-closing) > .report-details-dialog, .popup-layer:not(.is-closing) > .verification-dialog, .popup-layer:not(.is-closing) > .update-method-dialog,
                .popup-layer:not(.is-closing) > .menu-call-link-dialog,
                .panel.open, .panel.open .main, .panel.is-closing, .panel.is-closing .main { animation: none; }
                .button-pressable, .reason-control,
                .launcher-call-kbi.button-pressable,
                .launcher-quick-messages,
                .launcher-quick-messages.button-pressable { transition: none; }
                .settings-client-token-action { transition: none; }
                .settings-client-token-status { animation: none; }
                .report-history-clear-panel { transition: none; }
                .report-history-tab { transition: none; }
                .report-copy-icon-stack svg, .report-details-copy.is-copied,
                .report-details-copy.is-copied::after { animation: none; transition: none; }
                .report-history-token-value:not([hidden]),
                .report-history-token-value.is-closing { animation: none; }
                .messages-row, .messages-row.is-new, .messages-entry, .messages-entry-menu, .messages-entry-delete-confirm,
                .messages-settings-dialog, .messages-identity:not([hidden]), .messages-clear-confirmation { animation: none; }
                .messages-entry-status { transition: none; }
                .messages-identity-toggle, .messages-send.report-history-action { transition: none; }
            }
            .report-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 3px; }
            .report-dialog-button {
                min-height: 36px; padding: 0 13px; border: 0; border-radius: var(--radius-card);
                color: var(--color-white); background: var(--color-control); cursor: pointer;
                font: 800 13px/1 var(--font-ui);
                transform: scale(1);
            }
            .report-dialog-button.submit { background: var(--gradient-report); }
            .report-dialog-button:disabled { opacity: .55; cursor: not-allowed; filter: none; }
            .report-dialog-button:hover { filter: brightness(1.08); }
            .report-form-status {
                min-width: 0; max-height: 88px; overflow: auto; margin: 0; padding: 3px 0; color: var(--color-text-primary);
                font: 800 14px/1.35 Arial, Helvetica, sans-serif;
                letter-spacing: 0; overflow-wrap: anywhere; word-break: break-word; white-space: pre-wrap;
            }
            .status-prefix { font-weight: 900; }
            .status-prefix[data-kind="error"], .verification-status .status-prefix[data-kind="error"] { color: var(--color-status-error); }
            .status-prefix[data-kind="success"], .verification-status .status-prefix[data-kind="success"] { color: var(--color-status-success); }
            .status-prefix[data-kind="info"], .verification-status .status-prefix[data-kind="info"] { color: var(--color-text-secondary); }
            .report-form-status[data-kind="error"] .status-message { color: var(--color-white); }
            .report-form-status[hidden] { display: none; }
            .report-success-report-id {
                display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 7px; margin-top: 3px;
                color: inherit; font: inherit;
            }
            .report-success-report-id code {
                min-width: 0; color: inherit; font: inherit; letter-spacing: inherit; overflow-wrap: anywhere;
            }
            .report-success-copy { width: 26px; height: 26px; flex-basis: 26px; }
            .report-reminder-toast {
                position: fixed; z-index: 20; top: max(16px, env(safe-area-inset-top)); left: 50%;
                width: min(520px, calc(100vw - 24px)); padding: 14px 52px 18px 16px; overflow: hidden;
                border: 1px solid var(--color-border-dialog); border-radius: var(--radius-large);
                color: var(--color-text-description); background: var(--color-menu-header); box-shadow: var(--shadow-dialog);
                font: 700 14px/1.45 var(--font-decorative); letter-spacing: -.1px;
                text-align: left; text-shadow: 0 1px 1px var(--color-shadow);
                transform: translateX(-50%); pointer-events: auto;
            }
            .report-reminder-toast[hidden] { display: none; }
            .report-reminder-close { position: absolute; z-index: 1; top: 7px; right: 8px; }
            .report-reminder-toast strong {
                display: block; margin-bottom: 4px; color: var(--color-text-heading);
                font: 800 15px/1.35 var(--font-ui);
            }
            .report-reminder-toast p { margin: 0; }
            .report-reminder-progress {
                position: absolute; right: 0; bottom: 0; left: 0; height: 3px;
                background: #ffffff12;
            }
            .report-reminder-progress-fill {
                display: block; width: 100%; height: 100%;
                background: #f59e0b; transform-origin: right center;
            }
            .report-reminder-progress-fill.is-running {
                animation: report-reminder-countdown ${REPORT_REMINDER_DURATION_MS}ms linear forwards;
            }
            @media (max-width: 560px) {
                .report-history-dialog { padding: 14px; }
                .messages-dialog { width: min(720px, calc(100vw - 24px)); padding: 14px; }
                .messages-header { margin: -14px -14px 12px; }
                .messages-list {
                    min-height: min(220px, 28vh); max-height: min(48vh, 560px); padding: 12px 10px;
                }
                .messages-header-actions { gap: 4px; }
                .messages-tool-button { width: 32px; height: 32px; }
                .report-details-dialog { padding: 14px; }
                .report-history-header { margin: -14px -14px 12px; }
                .changelog-dialog { padding: 14px; }
            }
            @keyframes report-reminder-countdown {
                from { transform: scaleX(1); }
                to { transform: scaleX(0); }
            }
            @media (max-width: 560px) {
                .panel { padding: 12px; }
                .main { max-height: calc(100vh - 24px); }
                .eyebrow { font-size: 16px; }
                .topbar { min-height: 54px; padding: 0 10px; }
                .content { padding: 12px 9px; }
                .player-row { flex-wrap: wrap; }
                .player-info { flex-basis: calc(100% - 58px); }
                .player-actions { width: 100%; padding-left: 48px; }
                .player-action { flex: 1; }
                .report-dialog { padding: 14px; }
                .info-dialog-banner { min-height: 132px; padding-left: 72px; }
                .info-dialog-close { left: 12px; width: 42px; height: 42px; }
                .info-dialog-title { font-size: 23px; }
                .info-dialog-subtitle { font-size: 13px; }
                .info-dialog-content { padding: 19px 18px 22px; }
            }
            .button-pressable:active, .button-pressable.is-pressed {
                color: var(--button-press-foreground);
                background: var(--button-press-background);
                border-color: var(--button-press-background);
            }
            .close.button-pressable:active, .close.button-pressable.is-pressed,
            .dialog-close.button-pressable:active, .dialog-close.button-pressable.is-pressed {
                color: var(--button-press-foreground); background: transparent; border-color: transparent;
            }
        </style>
        <section class="panel" role="dialog" aria-label="Kour Report" aria-hidden="true">
            <div class="main">
                <header class="topbar">
                    <div class="title-group"><button class="close" type="button" aria-label="Close menu">×</button><span class="eyebrow">REPORTS</span></div>
                    <div class="top-actions" data-player-count hidden></div>
                </header>
                <main class="content">
                    <h2 class="players-heading" hidden>Players</h2>
                    <div class="player-list" aria-live="polite"></div>
                    <div class="empty-state">
                        <span class="empty-state-message">The player list is unavailable right now. If you're in a match, match detection may not be working. You can still submit a manual report.</span>
                        <div class="menu-report-actions">
                            <button class="report-dialog-button submit manual-report-button" type="button">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4.42 0-8 2.24-8 5v1h12.1a6.5 6.5 0 0 1-.1-1 6.5 6.5 0 0 1 2.05-4.74A13.2 13.2 0 0 0 12 14Zm6 0v3h-3v2h3v3h2v-3h3v-2h-3v-3h-2Z"/></svg>
                                <span>Report manually</span>
                            </button>
                            <button class="player-action call-kbi menu-call-kbi" type="button" data-call-player-key="__menu__" data-player-name="the current match">
                                <span class="call-kbi-icon" aria-hidden="true"></span>
                                <span class="call-kbi-label"></span>
                            </button>
                        </div>
                    </div>
                    <footer class="menu-footer">
                        <div class="menu-footer-actions">
                            <button class="top-action-button discord-button" type="button" aria-label="Discord">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.7 5.2A18.3 18.3 0 0 0 15.2 3.8l-.6 1.2a16.8 16.8 0 0 0-5.2 0l-.6-1.2a18.3 18.3 0 0 0-4.5 1.4C1.5 9.4.7 13.5 1.1 17.5a18.4 18.4 0 0 0 5.5 2.8l1.2-2a11.8 11.8 0 0 1-1.9-.9l.5-.4a13.1 13.1 0 0 0 11.2 0l.5.4a11.8 11.8 0 0 1-1.9.9l1.2 2a18.4 18.4 0 0 0 5.5-2.8c.5-4.7-.8-8.8-3.2-12.3ZM8.7 14.8c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2Zm6.6 0c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2Z"/></svg>
                                <span>Discord</span>
                            </button>
                            <button class="top-action-button github-button" type="button" aria-label="GitHub repository">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .9a11.1 11.1 0 0 0-3.51 21.63c.56.1.76-.24.76-.54v-2.08c-3.1.67-3.75-1.32-3.75-1.32-.51-1.29-1.24-1.63-1.24-1.63-1.01-.69.08-.68.08-.68 1.12.08 1.71 1.15 1.71 1.15 1 .1.98 2.2 3.34 1.57.1-.72.39-1.21.71-1.49-2.48-.28-5.09-1.24-5.09-5.52 0-1.22.44-2.22 1.15-3-.12-.28-.5-1.42.11-2.96 0 0 .94-.3 3.05 1.15a10.6 10.6 0 0 1 5.55 0c2.12-1.44 3.05-1.15 3.05-1.15.61 1.54.23 2.68.11 2.96.72.78 1.15 1.78 1.15 3 0 4.29-2.61 5.23-5.1 5.51.4.35.76 1.02.76 2.06v3.06c0 .3.2.65.77.54A11.1 11.1 0 0 0 12 .9Z"/></svg>
                                <span>GitHub</span>
                            </button>
                            <button class="top-action-button info-button" type="button" aria-label="Information">
                                <span class="info-icon" aria-hidden="true">i</span><span>Info</span>
                            </button>
                            <button class="top-action-button report-history-button" type="button" aria-haspopup="dialog" aria-label="Report history">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5m4-1v5l3 2"/></svg>
                                <span>History <span class="report-history-count">0</span></span>
                            </button>
                            <button class="top-action-button messages-button" type="button" aria-haspopup="dialog" aria-label="Messages, 0 unread">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>
                                <span>Messages</span><span class="messages-count" hidden></span>
                            </button>
                            <button class="top-action-button settings-button" type="button" aria-label="Settings">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94a7.49 7.49 0 0 0 .05-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.28 7.28 0 0 0-1.63-.95l-.36-2.54A.49.49 0 0 0 13.95 2h-3.9a.49.49 0 0 0-.49.42L9.2 4.96a7.28 7.28 0 0 0-1.63.95l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.49a.5.5 0 0 0 .12.64l2.03 1.58a7.49 7.49 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96a7.28 7.28 0 0 0 1.63.95l.36 2.54a.49.49 0 0 0 .49.42h3.9a.49.49 0 0 0 .49-.42l.36-2.54a7.28 7.28 0 0 0 1.63-.95l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/></svg>
                                <span>Settings</span>
                            </button>
                        </div>
                        <div class="menu-update" data-update-notice role="status" aria-live="polite" hidden>
                            <span class="menu-update-copy">
                                <span data-update-label></span>
                                <button class="menu-update-details" data-update-details type="button" hidden></button>
                            </span>
                            <button class="top-action-button update-button" type="button">Update</button>
                        </div>
                        <p class="menu-footer-note">Reports are reviewed in real time.</p>
                        <span class="menu-footer-version">
                            <span>Kour Report</span>
                            <span class="menu-footer-version-separator" aria-hidden="true">·</span>
                            <button class="menu-footer-version-link changelog-button" type="button" aria-haspopup="dialog" aria-label="Open changelog for version ${SCRIPT_VERSION}" title="Click to view the changelog">v${SCRIPT_VERSION}</button>
                            <span class="menu-footer-version-separator" aria-hidden="true">·</span>
                            <button class="menu-footer-api-health is-checking" data-api-health type="button" aria-live="polite" aria-label="API status: checking" title="Check API health">
                                <span data-api-health-label>API checking…</span>
                            </button>
                        </span>
                    </footer>
                </main>
            </div>
            <div class="menu-call-link-layer popup-layer" hidden>
                <section class="menu-call-link-dialog" role="dialog" aria-modal="true" aria-labelledby="menu-call-link-title">
                    <header class="menu-call-link-heading">
                        <span class="menu-call-link-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24"><path d="M7.2 3.8 10 3l2 4.8-2.1 1.6a15 15 0 0 0 4.7 4.7l1.6-2.1 4.8 2-.8 2.8a3 3 0 0 1-3.3 2.1A17.5 17.5 0 0 1 5.1 7.1a3 3 0 0 1 2.1-3.3Z"/></svg>
                        </span>
                        <span>
                            <span class="menu-call-link-eyebrow">KBI CALL REQUEST</span>
                            <h2 class="verification-title menu-call-link-title" id="menu-call-link-title">Call KBI</h2>
                        </span>
                    </header>
                    <p class="verification-description menu-call-link-description" id="menu-call-link-description">Enter the Kour room link so KBI can identify the match. If you don't have one, join a match first.</p>
                    <form class="menu-call-link-form">
                        <div class="report-field">
                            <label for="menu-call-room-link">Room link</label>
                            <input id="menu-call-room-link" type="text" autocomplete="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" aria-describedby="menu-call-link-description" placeholder="https://kour.io/#ABC123">
                        </div>
                        <p class="report-form-status menu-call-link-status" role="status" aria-live="polite" hidden></p>
                        <div class="report-dialog-actions">
                            <button class="report-dialog-button menu-call-link-cancel" type="button">Cancel</button>
                            <button class="report-dialog-button submit" type="submit">Continue</button>
                        </div>
                    </form>
                </section>
            </div>
            <div class="menu-call-warning-layer popup-layer" hidden>
                <section class="menu-call-link-dialog menu-call-warning-dialog" role="dialog" aria-modal="true" aria-labelledby="menu-call-warning-title">
                    <header class="menu-call-link-heading">
                        <span class="menu-call-link-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24"><path d="M7.2 3.8 10 3l2 4.8-2.1 1.6a15 15 0 0 0 4.7 4.7l1.6-2.1 4.8 2-.8 2.8a3 3 0 0 1-3.3 2.1A17.5 17.5 0 0 1 5.1 7.1a3 3 0 0 1 2.1-3.3Z"/></svg>
                        </span>
                        <span>
                            <span class="menu-call-link-eyebrow">PLAYERS DETECTED</span>
                            <h2 class="verification-title menu-call-link-title" id="menu-call-warning-title">Choose who to call</h2>
                        </span>
                    </header>
                    <p class="verification-description menu-call-link-description">Players are visible in this room. We recommend selecting a player to call KBI, and using Call Room only if you don't see a player you want to call.</p>
                    <div class="menu-call-warning-actions">
                        <button class="report-dialog-button menu-call-warning-choose" type="button">Choose a player</button>
                        <button class="report-dialog-button submit menu-call-warning-continue" type="button">Continue anyway</button>
                    </div>
                </section>
            </div>
            <div class="update-method-layer popup-layer" hidden>
                <section class="update-method-dialog" role="dialog" aria-modal="true" aria-labelledby="update-method-title">
                    <header class="update-method-header dialog-header">
                        <button class="update-method-close dialog-close" type="button" aria-label="Close update options">×</button>
                        <h2 class="update-method-title dialog-title" id="update-method-title">Choose an update method</h2>
                    </header>
                    <div class="update-method-content">
                        <p class="update-method-description">Choose how you want to get the latest version of Kour Report.</p>
                        <a class="update-method-option recommended" href="${GREASYFORK_SCRIPT_URL}" target="_blank" rel="noopener noreferrer">
                            <span class="update-method-icon" aria-hidden="true">
                                <img src="${GREASYFORK_ICON_URL}" alt="">
                            </span>
                            <span class="update-method-copy">
                                <span class="update-method-option-title">Greasy Fork <span class="update-method-badge">Recommended</span></span>
                                <span class="update-method-option-description">Open the script page and press <strong>Update</strong> to install the latest version.</span>
                            </span>
                        </a>
                        <a class="update-method-option" href="${GITHUB_SCRIPT_FILE_URL}" target="_blank" rel="noopener noreferrer">
                            <span class="update-method-icon github" aria-hidden="true">
                                <svg viewBox="0 0 24 24"><path d="M12 .9a11.1 11.1 0 0 0-3.51 21.63c.56.1.76-.24.76-.54v-2.08c-3.1.67-3.75-1.32-3.75-1.32-.51-1.29-1.24-1.63-1.24-1.63-1.01-.69.08-.68.08-.68 1.12.08 1.71 1.15 1.71 1.15 1 .1.98 2.2 3.34 1.57.1-.72.39-1.21.71-1.49-2.48-.28-5.09-1.24-5.09-5.52 0-1.22.44-2.22 1.15-3-.12-.28-.5-1.42.11-2.96 0 0 .94-.3 3.05 1.15a10.6 10.6 0 0 1 5.55 0c2.12-1.44 3.05-1.15 3.05-1.15.61 1.54.23 2.68.11 2.96.72.78 1.15 1.78 1.15 3 0 4.29-2.61 5.23-5.1 5.51.4.35.76 1.02.76 2.06v3.06c0 .3.2.65.77.54A11.1 11.1 0 0 0 12 .9Z"/></svg>
                            </span>
                            <span class="update-method-copy">
                                <span class="update-method-option-title">GitHub</span>
                                <span class="update-method-option-description">Open the script file, copy its code, then paste it into Tampermonkey or your userscript manager.</span>
                            </span>
                        </a>
                    </div>
                </section>
            </div>
            <div class="info-dialog-layer popup-layer" hidden>
                <section class="info-dialog" role="dialog" aria-modal="true" aria-labelledby="info-dialog-title">
                    <header class="info-dialog-banner">
                        <img src="${INFO_DIALOG_BANNER_URL}" alt="">
                        <button class="info-dialog-close dialog-close" type="button" aria-label="Close information">×</button>
                        <div class="info-dialog-heading">
                            <h2 class="info-dialog-title" id="info-dialog-title">KBI Reports</h2>
                            <p class="info-dialog-subtitle">Kour Bureau of Investigations</p>
                        </div>
                    </header>
                    <div class="info-dialog-content">
                        <h3>About KBI Reports</h3>
                        <p>KBI Reports was created by the community. Our team has tools to help deal with cheaters disrupting your room. Reports are reviewed in real time, and appropriate action is taken when needed.</p>
                        <p>We are not affiliated with Kour. This is a community-run project created because the game is not actively moderated.</p>
                        <p>Anyone is welcome to integrate this reporting system into their own platform, menu, or project and use it as they see fit, as long as it is not abused or used to spam reports.</p>
                        <p>Reports are reviewed by the community team in real time.</p>
                        <p>Verified badge icon by <a class="icons8-attribution-link" href="https://icons8.com/icon/F8sJNbgWH2bt/verified-badge" target="_blank" rel="noopener noreferrer">Icons8</a>.</p>
                        <div class="info-dialog-contributors" aria-label="Community contributors">
                            <h3>Community contributors</h3>
                            <div class="player-row contributor-row">
                                <div class="player-avatar" aria-hidden="true"><img class="contributor-avatar" alt=""></div>
                                <div class="player-info"><div class="player-name"><span class="contributor-clan xkbi">[XKBI]</span><span>user71184</span></div><div class="player-status">CREATOR</div></div>
                            </div>
                            <div class="player-row contributor-row">
                                <div class="player-avatar" aria-hidden="true"><img class="contributor-avatar" alt=""></div>
                                <div class="player-info"><div class="player-name"><span class="contributor-clan tfz">[TFZ]</span><span class="contributor-name tfz">zombiezach12</span></div><div class="player-status">CONTRIBUTOR CODER</div></div>
                            </div>
                            <div class="player-row contributor-row">
                                <div class="player-avatar" aria-hidden="true"><img class="contributor-avatar" alt=""></div>
                                <div class="player-info"><div class="player-name"><span class="contributor-clan ktbi">[KTBI]</span><span class="contributor-name ktbi">qimxzflzs</span></div><div class="player-status">CONTRIBUTOR CODE SUPPLIER</div></div>
                            </div>
                        </div>
                        <div class="info-dialog-links">
                            <a class="info-dialog-discord" href="${DISCORD_URL}" target="_blank" rel="noopener noreferrer">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.7 5.2A18.3 18.3 0 0 0 15.2 3.8l-.6 1.2a16.8 16.8 0 0 0-5.2 0l-.6-1.2a18.3 18.3 0 0 0-4.5 1.4C1.5 9.4.7 13.5 1.1 17.5a18.4 18.4 0 0 0 5.5 2.8l1.2-2a11.8 11.8 0 0 1-1.9-.9l.5-.4a13.1 13.1 0 0 0 11.2 0l.5.4a11.8 11.8 0 0 1-1.9.9l1.2 2a18.4 18.4 0 0 0 5.5-2.8c.5-4.7-.8-8.8-3.2-12.3ZM8.7 14.8c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2Zm6.6 0c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2Z"/></svg>
                                <span>Join the official KBI Discord</span>
                            </a>
                            <a class="info-dialog-github" href="${GITHUB_REPOSITORY_URL}" target="_blank" rel="noopener noreferrer">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .9a11.1 11.1 0 0 0-3.51 21.63c.56.1.76-.24.76-.54v-2.08c-3.1.67-3.75-1.32-3.75-1.32-.51-1.29-1.24-1.63-1.24-1.63-1.01-.69.08-.68.08-.68 1.12.08 1.71 1.15 1.71 1.15 1 .1.98 2.2 3.34 1.57.1-.72.39-1.21.71-1.49-2.48-.28-5.09-1.24-5.09-5.52 0-1.22.44-2.22 1.15-3-.12-.28-.5-1.42.11-2.96 0 0 .94-.3 3.05 1.15a10.6 10.6 0 0 1 5.55 0c2.12-1.44 3.05-1.15 3.05-1.15.61 1.54.23 2.68.11 2.96.72.78 1.15 1.78 1.15 3 0 4.29-2.61 5.23-5.1 5.51.4.35.76 1.02.76 2.06v3.06c0 .3.2.65.77.54A11.1 11.1 0 0 0 12 .9Z"/></svg>
                                <span>GitHub</span>
                            </a>
                        </div>
                    </div>
                </section>
            </div>
            <div class="changelog-layer popup-layer" hidden>
                <section class="changelog-dialog" role="dialog" aria-modal="true" aria-labelledby="changelog-title">
                    <header class="changelog-header dialog-header">
                        <button class="changelog-close dialog-close" type="button" aria-label="Close changelog">×</button>
                        <h2 class="changelog-title dialog-title" id="changelog-title">Kour Report Changelog</h2>
                    </header>
                    <p class="changelog-status" role="status" aria-live="polite">Release history will load when the menu opens.</p>
                    <div class="changelog-list" role="list" aria-label="Release history" tabindex="0"></div>
                </section>
            </div>
            <div class="settings-layer popup-layer" hidden>
                <section class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
                    <header class="settings-header dialog-header">
                        <button class="settings-close dialog-close" type="button" aria-label="Close settings">×</button>
                        <h2 class="settings-title dialog-title" id="settings-title">Kour Report Settings</h2>
                    </header>
                    <div class="settings-content">
                        <div class="settings-row">
                            <span class="settings-copy">
                                <span class="settings-label">Enable moving the report icon</span>
                                <span class="settings-default">Default: Off · Drag the icon to reposition</span>
                            </span>
                            <input class="settings-checkbox" data-setting="moveIcon" type="checkbox" aria-label="Enable moving the report icon">
                        </div>
                        <div class="settings-row" data-setting-row="hideIcon">
                            <span class="settings-copy">
                                <span class="settings-label">Hide the Report button only</span>
                                <span class="settings-default">Default: Off</span>
                            </span>
                            <input class="settings-checkbox" data-setting="hideIcon" type="checkbox" aria-label="Hide the Report button only">
                        </div>
                        <div class="settings-row">
                            <span class="settings-copy">
                                <span class="settings-label">Hide the Call KBI button only</span>
                                <span class="settings-default">Default: Off</span>
                            </span>
                            <input class="settings-checkbox" data-setting="hideCallIcon" type="checkbox" aria-label="Hide the Call KBI button only">
                        </div>
                        <div class="settings-row">
                            <span class="settings-copy">
                                <span class="settings-label">Hide Report, Call KBI, and Messages buttons</span>
                                <span class="settings-default">Default: Off</span>
                            </span>
                            <input class="settings-checkbox" data-setting="hideBothButtons" type="checkbox" aria-label="Hide Report, Call KBI, and Messages buttons">
                        </div>
                        <div class="settings-row">
                            <span class="settings-copy">
                                <span class="settings-label">Hide the Messages button only</span>
                                <span class="settings-default">Default: Off</span>
                            </span>
                            <input class="settings-checkbox" data-setting="hideMessageIcon" type="checkbox" aria-label="Hide the Messages button only">
                        </div>
                        <div class="settings-row">
                            <label class="settings-copy" for="settings-opacity">
                                <span class="settings-label">Icon opacity</span>
                                <span class="settings-default">Default: 100%</span>
                            </label>
                            <span class="settings-range-group">
                                <input class="settings-range" id="settings-opacity" data-setting="opacity" type="range" min="10" max="100" step="5">
                                <output class="settings-value" data-value="opacity">100%</output>
                            </span>
                        </div>
                        <div class="settings-row">
                            <label class="settings-copy" for="settings-size">
                                <span class="settings-label">Icon size</span>
                                <span class="settings-default">Default: 72 px</span>
                            </label>
                            <span class="settings-range-group">
                                <input class="settings-range" id="settings-size" data-setting="size" type="range" min="44" max="140" step="1">
                                <output class="settings-value" data-value="size">72 px</output>
                            </span>
                        </div>
                        <div class="settings-row">
                            <span class="settings-copy">
                                <span class="settings-label">Open menu key</span>
                                <span class="settings-default">Default: Left Alt</span>
                            </span>
                            <button class="settings-key-button" data-key-setting="openKey" type="button">Left Alt</button>
                        </div>
                        <div class="settings-row">
                            <span class="settings-copy">
                                <span class="settings-label">Show/hide report icon key</span>
                                <span class="settings-default">Default: Right Alt</span>
                            </span>
                            <button class="settings-key-button" data-key-setting="toggleIconKey" type="button">Right Alt</button>
                        </div>
                        <h3 class="settings-section-title">Updates</h3>
                        <div class="settings-row">
                            <span class="settings-copy">
                                <span class="settings-label">Show update notifications</span>
                                <span class="settings-default">Default: On · Show the Report badge, menu notice, and in-game update alert</span>
                            </span>
                            <input class="settings-checkbox" data-setting="showUpdateNotifications" type="checkbox" aria-label="Show update notifications">
                        </div>
                        <h3 class="settings-section-title">Messages</h3>
                        <div class="settings-row">
                            <span class="settings-copy">
                                <span class="settings-label">Show incoming message notifications</span>
                                <span class="settings-default">Default: On · Unread messages still appear in the Messages counter when notifications are off</span>
                            </span>
                            <input class="settings-checkbox" data-setting="showMessageNotifications" type="checkbox" aria-label="Show incoming message notifications">
                        </div>
                        <div class="settings-row" data-setting-row="announceRoomJoin">
                            <span class="settings-copy">
                                <span class="settings-label">Announce Kour Report when joining a room</span>
                                <span class="settings-default">Default: On · Invite players to search Google for Kour Report or join Discord</span>
                            </span>
                            <input class="settings-checkbox" data-setting="announceRoomJoin" type="checkbox" aria-label="Announce Kour Report when joining a room" aria-describedby="room-announcement-tooltip">
                        </div>
                        <div class="settings-row">
                            <span class="settings-copy">
                                <span class="settings-label">Send room-entry announcement</span>
                                <span class="settings-default">Send the Kour Report message to the current room chat.</span>
                            </span>
                            <button class="settings-client-token-action" data-room-announcement-send type="button">Send</button>
                        </div>
                        <p class="settings-room-announcement-status" data-room-announcement-status role="status" aria-live="polite" hidden></p>
                        <h3 class="settings-section-title">Report token</h3>
                        <div class="settings-client-token-row" data-client-token-row>
                            <div class="settings-client-token-heading">
                                <span class="settings-label">Client token</span>
                                <button class="settings-help" type="button" aria-label="About the client token" aria-describedby="client-token-tooltip">?</button>
                            </div>
                            <span class="settings-default">Sent with reports and message checks so KBI staff can reply to your reports.</span>
                            <div class="settings-client-token-controls">
                                <code class="settings-client-token-value" data-client-token-value aria-live="polite">Unavailable</code>
                                <button class="settings-client-token-action" data-client-token-toggle type="button" aria-label="Show client token" aria-describedby="client-token-tooltip" aria-pressed="false">Show</button>
                                <button class="settings-client-token-action settings-client-token-copy" data-client-token-copy type="button" aria-label="Copy client token" aria-describedby="client-token-tooltip">
                                    <svg class="client-token-copy-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"></rect><path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h2"></path></svg>
                                    <svg class="client-token-copy-success-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>
                                    <span data-client-token-copy-label>Copy</span>
                                </button>
                            </div>
                            <p class="settings-client-token-status" data-client-token-status role="status" aria-live="polite"></p>
                        </div>
                        <h3 class="settings-section-title">Developer / Test</h3>
                        <div class="settings-row" data-setting-row="testMode">
                            <span class="settings-copy">
                                <span class="settings-label-with-help">
                                    <span class="settings-label settings-test-mode-label">Send submissions to the test channel</span>
                                    <button class="settings-help" type="button" aria-label="About test submission mode" aria-describedby="test-mode-tooltip">?</button>
                                </span>
                                <span class="settings-default">Default: Off · Routes every report and KBI call to public testing</span>
                            </span>
                            <input class="settings-checkbox" data-setting="testMode" type="checkbox" aria-label="Enable test submission mode" aria-describedby="test-mode-tooltip">
                        </div>
                        <p class="settings-key-hint" role="status" hidden></p>
                        <button class="settings-reset" type="button">RESET DEFAULT</button>
                    </div>
                </section>
                <div class="tooltip settings-warning-tooltip" data-hide-icon-warning role="tooltip" hidden></div>
                <div class="tooltip settings-test-mode-tooltip" id="test-mode-tooltip" role="tooltip" hidden>Test mode routes all submissions—including player reports, manual reports, and every KBI call—to the public Discord test channel using https://kour-report-api.kourkbi.workers.dev/api/v2/report/test. Test submissions are not saved to the API's production report history, and their report IDs may not be unique. Turn this off before sending real reports.</div>
                <div class="tooltip settings-client-token-tooltip" id="client-token-tooltip" role="tooltip" hidden>This token is used to securely send reports and communicate with KBI staff. Under no circumstances should you share it with anyone.</div>
                <div class="tooltip settings-announcement-tooltip" id="room-announcement-tooltip" role="tooltip" data-preserve-markup hidden><strong>Important:</strong> Please support us by keeping this option enabled. It helps more players report hackers and clean up the room.</div>
            </div>
            <div class="report-dialog-layer popup-layer" hidden>
                <section class="report-dialog" role="dialog" aria-modal="true" aria-labelledby="report-dialog-title">
                    <header class="report-dialog-header">
                        <img class="report-dialog-avatar" alt="">
                        <div>
                            <h2 class="report-dialog-title" id="report-dialog-title">Report player</h2>
                            <div class="report-dialog-subtitle">Confirm the player and report details</div>
                        </div>
                    </header>
                    <form class="report-form">
                        <div class="report-field">
                            <div class="report-target-label-row">
                                <label for="report-target">Reported player</label>
                                <button class="report-target-help" type="button" aria-label="Help for reported player name" aria-describedby="manual-report-help-tooltip">?</button>
                            </div>
                            <input id="report-target" name="target" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" required>
                        </div>
                        <div class="report-field">
                            <label for="report-session-link">Room link</label>
                            <input id="report-session-link" name="sessionLink" type="text" placeholder="https://kour.io/#ABC123" autocomplete="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" required>
                        </div>
                        <div class="report-field">
                            <div class="reason-control">
                                <label for="report-reason">Reason</label>
                                <div class="reason-select">
                                    <button class="reason-trigger" id="report-reason" type="button" aria-haspopup="listbox" aria-expanded="false">
                                        <span class="reason-trigger-label">Select a reason</span><span class="reason-chevron" aria-hidden="true">▼</span>
                                    </button>
                                    <div class="reason-options" role="listbox" aria-label="Report reason" hidden>
                                    <button class="reason-option" type="button" role="option" aria-selected="false" data-reason="Invisibility"><span class="reason-option-icon invisibility"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.7 2.7"/><path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c5.5 0 9 7 9 7a15 15 0 0 1-3.1 3.8M6.2 6.3C3.9 8 3 12 3 12s3.5 7 9 7c1 0 2-.2 2.8-.6"/></svg></span><span>Invisibility</span><span class="reason-option-check" aria-hidden="true"></span></button>
                                    <button class="reason-option" type="button" role="option" aria-selected="false" data-reason="Aimbot"><span class="reason-option-icon aimbot"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/></svg></span><span>Aimbot</span><span class="reason-option-check" aria-hidden="true"></span></button>
                                    <button class="reason-option" type="button" role="option" aria-selected="false" data-reason="Flying"><span class="reason-option-icon flying"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21V8m0 0-5 5m5-5 5 5M4 8l4 1 4-5 4 5 4-1"/></svg></span><span>Flying</span><span class="reason-option-check" aria-hidden="true"></span></button>
                                    <button class="reason-option" type="button" role="option" aria-selected="false" data-reason="Wallhack"><span class="reason-option-icon wallhack"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h7v6H3zm11 0h7v6h-7zM3 14h4v6H3zm8 0h4v6h-4zm8 0h2v6h-2z"/><path d="M8 12s1.6-2.5 4-2.5 4 2.5 4 2.5-1.6 2.5-4 2.5S8 12 8 12z"/><circle cx="12" cy="12" r="1"/></svg></span><span>Wallhack</span><span class="reason-option-check" aria-hidden="true"></span></button>
                                    <button class="reason-option" type="button" role="option" aria-selected="false" data-reason="Other"><span class="reason-option-icon other">…</span><span>Other</span><span class="reason-option-check" aria-hidden="true"></span></button>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div class="report-field">
                            <label for="report-details">Additional detail (optional)</label>
                            <textarea id="report-details" autocapitalize="sentences" spellcheck="true" aria-describedby="report-details-count" placeholder="Optional: add details or evidence."></textarea>
                            <span class="report-character-count" id="report-details-count">250 characters remaining</span>
                        </div>
                        <input id="report-combined-reason" name="reason" type="hidden">
                        <p class="report-form-status" role="status" hidden></p>
                        <div class="report-dialog-actions">
                            <button class="report-dialog-button cancel-report" type="button">Cancel</button>
                            <button class="report-dialog-button submit" type="submit">Send report</button>
                        </div>
                    </form>
                </section>
                <div class="tooltip manual-report-help-tooltip" id="manual-report-help-tooltip" role="tooltip" hidden>If you don't know the player's full name or it's difficult to spell, leave this field empty or enter only the part you know.</div>
            </div>
        </section>
        <div class="verification-layer popup-layer" hidden>
            <section class="verification-dialog" role="dialog" aria-modal="true" aria-labelledby="verification-title">
                <h2 class="verification-title" id="verification-title">Security check</h2>
                <p class="verification-description" id="verification-description">Complete this check to send your report.</p>
                <div class="verification-widget"></div>
                <p class="verification-status" role="status" aria-live="polite"></p>
                <div class="verification-actions">
                    <button class="report-dialog-button cancel-verification" type="button">Cancel</button>
                </div>
            </section>
        </div>
        <div class="report-reminder-toast" role="status" aria-live="polite" hidden>
            <button class="report-reminder-close dialog-close" type="button" aria-label="Close KBI report reminder">×</button>
            <strong>KBI Report Reminder</strong>
            <p>If the room is full, please keep submitting reports or try again when fewer than 6 players are in the room. If the room allows more than 6 players, please continue submitting reports.</p>
            <div class="report-reminder-progress" aria-hidden="true">
                <span class="report-reminder-progress-fill"></span>
            </div>
        </div>
        <div class="message-notification-stack" aria-live="polite" aria-relevant="additions" hidden></div>
        <template class="message-notification-template">
            <div class="message-notification-toast" role="status" aria-atomic="true">
                <button class="message-notification-open" type="button" aria-label="Open new message from KBI">
                    <span class="message-notification-header">
                        <span class="message-notification-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>
                        </span>
                        <span class="message-notification-heading">
                            <span class="message-notification-eyebrow">Personal message</span>
                            <strong>New message from KBI</strong>
                        </span>
                    </span>
                    <span class="message-notification-copy"></span>
                    <span class="message-notification-view-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>
                    </span>
                </button>
                <button class="message-notification-mute" type="button" aria-label="Mute message notifications"
                    title="Mute message notifications">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M11 5 6 9H3v6h3l5 4V5Z"/>
                        <path d="m16 9 5 6m0-6-5 6"/>
                    </svg>
                </button>
                <button class="message-notification-close dialog-close" type="button" aria-label="Dismiss message notification">×</button>
                <div class="message-notification-progress" aria-hidden="true">
                    <span class="message-notification-progress-fill"></span>
                </div>
            </div>
        </template>
        <div class="report-history-layer popup-layer" hidden>
            <section class="report-history-dialog" role="dialog" aria-modal="true" aria-labelledby="report-history-title">
                <header class="report-history-header dialog-header">
                    <button class="report-history-close dialog-close" type="button" aria-label="Close report history">×</button>
                    <h2 class="report-history-title dialog-title" id="report-history-title">Report history</h2>
                </header>
                <div class="report-history-tabs" role="group" aria-label="Filter report history">
                    <button class="report-history-tab" type="button" data-report-history-filter="all" aria-pressed="true">
                        <span>All</span><span class="report-history-tab-count" data-report-history-count="all">0</span>
                    </button>
                    <button class="report-history-tab" type="button" data-report-history-filter="real" aria-pressed="false">
                        <span>Real</span><span class="report-history-tab-count" data-report-history-count="real">0</span>
                    </button>
                    <button class="report-history-tab" type="button" data-report-history-filter="test" aria-pressed="false">
                        <span>Test</span><span class="report-history-tab-count" data-report-history-count="test">0</span>
                    </button>
                </div>
                <div class="report-history-tools">
                    <button class="report-history-clear-open report-history-action" type="button"
                        aria-expanded="false" aria-controls="report-history-clear-panel">Clear history</button>
                    <div class="report-history-clear-panel" id="report-history-clear-panel" hidden>
                        <div class="report-history-clear-options">
                            <p class="report-history-clear-description">Choose which saved entries to delete:</p>
                            <div class="report-history-clear-choice-row">
                                <button class="report-history-clear-choice report-history-action" type="button" data-delete-scope="all">All reports</button>
                                <button class="report-history-clear-choice report-history-action" type="button" data-delete-scope="test">Test reports</button>
                                <button class="report-history-clear-choice report-history-action" type="button" data-delete-scope="real">Real reports</button>
                                <button class="report-history-clear-cancel report-history-action" type="button">Cancel</button>
                            </div>
                        </div>
                        <div class="report-history-clear-confirmation" hidden>
                            <p class="report-history-clear-description"></p>
                            <div class="report-history-clear-confirmation-actions">
                                <button class="report-history-clear-cancel report-history-action" type="button">Cancel</button>
                                <button class="report-history-clear-confirm report-history-action" type="button">Delete</button>
                            </div>
                        </div>
                    </div>
                </div>
                <p class="report-history-clear-status" role="status" aria-live="polite" hidden></p>
                <p class="report-history-empty">Reports confirmed by the API on this browser will appear here.</p>
                <div class="report-history-list" role="list"></div>
                <p class="report-history-status" role="status" aria-live="polite"></p>
            </section>
        </div>
        <div class="messages-layer popup-layer" hidden>
            <section class="messages-dialog" role="dialog" aria-modal="true" aria-labelledby="messages-title">
                <header class="messages-header dialog-header">
                    <h2 class="messages-title dialog-title" id="messages-title">Messages from KBI</h2>
                    <div class="messages-header-actions">
                        <button class="messages-identity-toggle messages-tool-button" type="button"
                            aria-label="Open chat settings" title="Chat settings" aria-haspopup="dialog"
                            aria-controls="messages-settings-layer"
                            aria-expanded="false">
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M19.14 12.94a7.49 7.49 0 0 0 .05-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.28 7.28 0 0 0-1.63-.95l-.36-2.54A.49.49 0 0 0 13.95 2h-3.9a.49.49 0 0 0-.49.42L9.2 4.96a7.28 7.28 0 0 0-1.63.95l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.49a.5.5 0 0 0 .12.64l2.03 1.58a7.49 7.49 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96a7.28 7.28 0 0 0 1.63.95l.36 2.54a.49.49 0 0 0 .49.42h3.9a.49.49 0 0 0 .49-.42l.36-2.54a7.28 7.28 0 0 0 1.63-.95l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/>
                            </svg>
                        </button>
                        <button class="messages-close dialog-close" type="button" aria-label="Close messages">×</button>
                    </div>
                </header>
                <p class="messages-description">Personalized messages delivered to this client appear here.</p>
                <p class="messages-empty">You don't have any messages yet.</p>
                <div class="messages-list" role="list" aria-label="Personalized messages"></div>
                <form class="messages-compose">
                    <textarea class="messages-input" maxlength="2000" rows="1"
                        autocapitalize="sentences" spellcheck="true"
                        aria-label="Message to KBI" placeholder="Message to KBI"></textarea>
                    <button class="messages-send report-history-action" type="submit" disabled>
                        <span>Send</span>
                        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                            <path d="M4 12 20 4l-5 16-3-7-8-1Zm8 1 4-5" fill="none"
                                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </button>
                </form>
                <p class="messages-status" role="status" aria-live="polite"></p>
            </section>
            <div class="messages-settings-layer" id="messages-settings-layer" hidden>
                <section class="messages-settings-dialog" role="dialog" aria-modal="true"
                    aria-labelledby="messages-settings-title">
                    <header class="messages-settings-header">
                        <h2 class="messages-settings-title" id="messages-settings-title">Messages settings</h2>
                        <button class="messages-settings-close dialog-close" type="button"
                            aria-label="Close chat settings">×</button>
                    </header>
                    <div class="messages-settings-content">
                        <section class="messages-settings-card" aria-labelledby="messages-identity-title">
                            <div class="messages-settings-card-heading">
                                <h3 class="messages-settings-card-title" id="messages-identity-title">Your chat name</h3>
                                <p class="messages-settings-card-description">
                                    Choose the name shown when you send a message to KBI.
                                </p>
                            </div>
                            <div class="messages-identity-current">
                                <span class="messages-identity-label">Sending as</span>
                                <strong class="messages-identity-value">No detected</strong>
                                <button class="messages-identity-edit report-history-action" type="button">Edit</button>
                            </div>
                            <div class="messages-identity" hidden>
                                <label for="messages-sender-input">Display name</label>
                                <input class="messages-sender-input" id="messages-sender-input" maxlength="100"
                                    autocomplete="off" autocapitalize="off" autocorrect="off"
                                    spellcheck="false" placeholder="No detected">
                                <div class="messages-identity-actions">
                                    <button class="messages-identity-action messages-identity-cancel" type="button">Cancel</button>
                                    <button class="messages-identity-action is-primary messages-identity-save" type="button">Save name</button>
                                </div>
                            </div>
                        </section>
                        <section class="messages-settings-card is-danger" aria-labelledby="messages-clear-title">
                            <div class="messages-settings-card-heading">
                                <h3 class="messages-settings-card-title" id="messages-clear-title">Message history</h3>
                                <p class="messages-settings-card-description">
                                    Clear messages and activity cards saved on this device. Server copies are not affected.
                                </p>
                            </div>
                            <button class="messages-clear report-history-action" type="button">Clear message history</button>
                            <div class="messages-clear-confirmation" hidden>
                                <p>Clear all messages from this device? This cannot be undone.</p>
                                <div class="messages-clear-confirm-actions">
                                    <button class="messages-clear-confirm-action messages-clear-cancel" type="button">Cancel</button>
                                    <button class="messages-clear-confirm-action is-danger messages-clear-confirm" type="button">Clear all</button>
                                </div>
                            </div>
                        </section>
                    </div>
                    <p class="messages-settings-status" role="status" aria-live="polite"></p>
                    <footer class="messages-settings-footer">
                        <button class="messages-settings-done" type="button">Done</button>
                    </footer>
                </section>
            </div>
        </div>
        <div class="report-details-layer popup-layer" hidden>
            <section class="report-details-dialog" role="dialog" aria-modal="true" aria-labelledby="report-details-title">
                <header class="report-history-header dialog-header">
                    <button class="report-history-close report-details-close dialog-close" type="button" aria-label="Close report details">×</button>
                    <h2 class="report-history-title dialog-title" id="report-details-title">Report details</h2>
                </header>
                <div class="report-details-content">
                    <div class="report-details-summary">
                        <img class="report-details-avatar" alt="">
                        <div class="report-details-summary-copy">
                            <div class="report-details-copyable">
                                <h3 class="report-details-player" data-report-detail="target"></h3>
                            </div>
                            <p class="report-details-state">Report submitted successfully</p>
                        </div>
                    </div>
                    <section class="report-details-reason" aria-labelledby="report-details-reason-label">
                        <span class="report-details-section-label" id="report-details-reason-label">Reason for report</span>
                        <div class="report-details-copyable report-details-reason-value">
                            <p class="report-details-reason-text" data-report-detail="reason"></p>
                        </div>
                    </section>
                    <div class="report-details-facts">
                        <div class="report-details-fact">
                            <span>Reported by</span>
                            <div class="report-details-copyable"><strong data-report-detail="reporter"></strong></div>
                        </div>
                        <div class="report-details-fact">
                            <span>Submitted</span>
                            <div class="report-details-copyable"><strong data-report-detail="submitted"></strong></div>
                        </div>
                        <div class="report-details-fact">
                            <span>Room ID</span>
                            <div class="report-details-copyable"><strong data-report-detail="roomId"></strong></div>
                        </div>
                        <div class="report-details-fact report-details-fact-wide">
                            <span>Room link</span>
                            <div class="report-details-copyable"><strong data-report-detail="sessionLink"></strong></div>
                        </div>
                        <div class="report-details-fact" data-report-detail-fact="playerCount" hidden>
                            <span>Players in room</span>
                            <div class="report-details-copyable"><strong data-report-detail="playerCount"></strong></div>
                        </div>
                        <div class="report-details-fact report-details-fact-wide">
                            <span>Report number</span>
                            <div class="report-details-copyable"><strong data-report-detail="reportId"></strong></div>
                        </div>
                    </div>
                </div>
            </section>
        </div>
        <div class="tooltip room-full-report-tooltip" role="tooltip" hidden>If the room is full, please keep submitting reports so staff can see when the session becomes available. Staff will try to join; please continue sending reports until they connect to the session.</div>
    `;
    shadow.querySelectorAll(".tooltip").forEach((tooltip) => {
        if (!tooltip.hasAttribute("data-preserve-markup")) {
            tooltip.textContent = tooltip.textContent.trim();
        }
    });

    const launcher = document.createElement("button");
    launcher.id = "kour-report-launcher";
    launcher.type = "button";
    launcher.setAttribute("aria-label", "Open Kour Report menu");
    launcher.title = "Open Kour Report";
    Object.assign(launcher.style, {
        position: "fixed",
        right: "0",
        top: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "72px",
        height: "72px",
        minWidth: "0",
        minHeight: "0",
        flexDirection: "column",
        gap: "5px",
        padding: "8px 6px",
        boxSizing: "border-box",
        border: "2px solid #242424",
        outline: "none",
        borderRadius: "0",
        color: UI_COLORS.white,
        background: "linear-gradient(90deg, #383838 0%, #303030 100%)",
        boxShadow: "0 2px 7px rgba(0,0,0,0.45), inset 0 1px 0 #505050, inset 0 -2px 0 #222",
        cursor: "pointer",
        transformOrigin: "100% 0%",
        transition: "transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease",
        translate: "0 -50%",
        zIndex: "2147483646",
    });
    const launcherQuickCall = document.createElement("button");
    launcherQuickCall.type = "button";
    launcherQuickCall.className = "player-action call-kbi launcher-call-kbi";
    launcherQuickCall.dataset.callPlayerKey = "__menu__";
    launcherQuickCall.dataset.playerName = "the current room";
    launcherQuickCall.setAttribute("aria-label", "Call KBI for this room");
    launcherQuickCall.title = "Call KBI for the current room.";
    const launcherQuickCallIcon = document.createElement("span");
    launcherQuickCallIcon.className = "call-kbi-icon";
    launcherQuickCallIcon.setAttribute("aria-hidden", "true");
    const launcherQuickCallLabel = document.createElement("span");
    launcherQuickCallLabel.className = "call-kbi-label";
    const launcherQuickCallSeam = document.createElement("span");
    launcherQuickCallSeam.className = "launcher-hover-seam";
    launcherQuickCallSeam.setAttribute("aria-hidden", "true");
    launcherQuickCall.append(launcherQuickCallIcon, launcherQuickCallLabel, launcherQuickCallSeam);
    shadow.appendChild(launcherQuickCall);
    const launcherQuickMessages = document.createElement("button");
    launcherQuickMessages.type = "button";
    launcherQuickMessages.className = "launcher-quick-messages";
    launcherQuickMessages.setAttribute("aria-label", "Open messages from KBI");
    launcherQuickMessages.title = "Open messages from KBI";
    launcherQuickMessages.setAttribute("aria-haspopup", "dialog");
    const launcherMessageIcon = document.createElement("span");
    launcherMessageIcon.className = "launcher-message-icon";
    launcherMessageIcon.setAttribute("aria-hidden", "true");
    launcherMessageIcon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3Z"/><path d="M8 9h8M8 13h5"/></svg>';
    const launcherMessageLabel = document.createElement("span");
    launcherMessageLabel.className = "launcher-message-label";
    launcherMessageLabel.textContent = "Messages";
    const launcherMessagesCount = document.createElement("span");
    launcherMessagesCount.className = "messages-count";
    launcherMessagesCount.setAttribute("aria-hidden", "true");
    launcherMessagesCount.hidden = true;
    launcherQuickMessages.append(
        launcherMessageIcon,
        launcherMessageLabel,
        launcherMessagesCount
    );
    shadow.appendChild(launcherQuickMessages);
    const launcherShortcutWheel = document.createElement("div");
    launcherShortcutWheel.className = "launcher-shortcut-wheel";
    launcherShortcutWheel.hidden = true;
    launcherShortcutWheel.setAttribute("aria-hidden", "true");
    const launcherShortcutOptions = document.createElement("div");
    launcherShortcutOptions.className = "launcher-shortcut-options";
    launcherShortcutOptions.setAttribute("role", "group");
    launcherShortcutOptions.setAttribute("aria-label", "Launcher shortcut options");
    const launcherShortcutHint = document.createElement("span");
    launcherShortcutHint.className = "launcher-shortcut-hint";
    launcherShortcutHint.textContent = "Choose an option, or release Alt to open the report menu";
    launcherShortcutOptions.appendChild(launcherShortcutHint);
    function createLauncherShortcutOption(action, label, iconMarkup) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = `launcher-shortcut-option ${action}`;
        option.dataset.shortcutAction = action;
        option.setAttribute("aria-label", label);
        option.setAttribute("aria-pressed", "false");
        option.innerHTML = `${iconMarkup}<span>${label}</span>`;
        launcherShortcutOptions.appendChild(option);
        return option;
    }
    const launcherShortcutMenuOption = createLauncherShortcutOption(
        "menu",
        "Open KBI Report",
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/></svg>'
    );
    const launcherShortcutCallOption = createLauncherShortcutOption(
        "call",
        "Call KBI",
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.2 3.8 10 3l2 4.8-2.1 1.6a15 15 0 0 0 4.7 4.7l1.6-2.1 4.8 2-.8 2.8a3 3 0 0 1-3.3 2.1A17.5 17.5 0 0 1 5.1 7.1a3 3 0 0 1 2.1-3.3Z"/></svg>'
    );
    launcherShortcutWheel.appendChild(launcherShortcutOptions);
    shadow.appendChild(launcherShortcutWheel);
    let launcherShortcutActive = false;
    let launcherShortcutSelection = null;
    let launcherShortcutOrigin = { x: 0, y: 0 };
    /**
     * Apply the launcher's pressed colors and shadow to its button and SVG.
     * @param {boolean} pressed Whether a pointer press is active.
     * @see BUTTON_PRESS
     */
    function setLauncherPressed(pressed) {
        launcher.style.background = pressed
            ? BUTTON_PRESS.background
            : launcher.matches(":hover")
                ? "#a5a5a5"
                : "linear-gradient(90deg, #383838 0%, #303030 100%)";
        launcher.style.boxShadow = pressed
            ? "0 1px 3px rgba(0,0,0,0.45), inset 0 2px 3px rgba(0,0,0,0.28)"
            : "0 2px 7px rgba(0,0,0,0.45), inset 0 1px 0 #505050, inset 0 -2px 0 #222";
        launcher.style.color = pressed ? BUTTON_PRESS.foreground : UI_COLORS.white;
        launcherIcon.querySelectorAll("path").forEach((path) => {
            if (path === reportIconShape) {
                path.setAttribute("fill", pressed ? BUTTON_PRESS.foreground : "#f5f5f5");
                path.setAttribute("stroke", pressed ? BUTTON_PRESS.foreground : "#171717");
            } else {
                path.setAttribute("stroke", pressed ? BUTTON_PRESS.foreground : "#252525");
            }
        });
        launcherLabel.style.color = pressed ? BUTTON_PRESS.foreground : UI_COLORS.white;
    }
    let launcherPressed = false;
    // Pointer handlers below provide press feedback, drag movement, and saved positioning.
    launcher.addEventListener("pointerdown", () => {
        launcherPressed = true;
        setLauncherPressed(true);
        launcher.style.transform = `scale(${BUTTON_PRESS.scale})`;
    });
    const releaseLauncher = () => {
        launcherPressed = false;
        setLauncherPressed(false);
        updateLauncherHoverRelationship();
    };
    launcher.addEventListener("pointerup", releaseLauncher);
    launcher.addEventListener("pointercancel", releaseLauncher);
    launcher.addEventListener("pointerenter", () => {
        if (!launcherPressed) setLauncherPressed(false);
        updateLauncherHoverRelationship();
        launcher.style.boxShadow = "0 5px 16px rgba(0, 0, 0, 0.55), inset 0 1px 0 #626262, inset 0 -2px 0 #222";
    });
    launcher.addEventListener("pointerleave", () => {
        if (!launcherPressed) setLauncherPressed(false);
        updateLauncherHoverRelationship();
        launcher.style.boxShadow = "0 2px 7px rgba(0,0,0,0.45), inset 0 1px 0 #505050, inset 0 -2px 0 #222";
    });
    launcher.addEventListener("pointerup", () => {
        updateLauncherHoverRelationship();
    });
    launcher.addEventListener("pointerdown", (event) => {
        if (!launcherSettings.moveIcon || event.button !== 0) return;
        const size = launcherSettings.size;
        const baseLeft = launcherSettings.left !== null
            ? launcherSettings.left
            : window.innerWidth - size;
        const baseTop = launcherSettings.top !== null
            ? launcherSettings.top
            : (window.innerHeight - size) / 2;
        activeLauncherDrag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            left: baseLeft,
            top: baseTop,
            moved: false,
        };
        launcher.style.cursor = "grabbing";
        launcher.setPointerCapture?.(event.pointerId);
    });
    launcher.addEventListener("pointermove", (event) => {
        if (!activeLauncherDrag || event.pointerId !== activeLauncherDrag.pointerId) return;
        const deltaX = event.clientX - activeLauncherDrag.startX;
        const deltaY = event.clientY - activeLauncherDrag.startY;
        if (!activeLauncherDrag.moved && Math.hypot(deltaX, deltaY) < 4) return;
        activeLauncherDrag.moved = true;
        event.preventDefault();
        const size = launcherSettings.size;
        const left = Math.min(
            Math.max(0, window.innerWidth - launcher.offsetWidth),
            Math.max(0, activeLauncherDrag.left + deltaX)
        );
        const minimumTop = window.innerHeight >= size * 3 ? size : 0;
        const maximumTop = window.innerHeight >= size * 3
            ? window.innerHeight - size * 2
            : window.innerHeight - size;
        const top = Math.max(
            minimumTop,
            Math.min(maximumTop, activeLauncherDrag.top + deltaY)
        );
        launcher.style.left = `${left}px`;
        launcher.style.top = `${top}px`;
        launcher.style.right = "auto";
        launcher.style.bottom = "auto";
        launcher.style.translate = "none";
        updateLauncherQuickCallPosition();
    });
    const finishLauncherDrag = (event) => {
        if (!activeLauncherDrag || event.pointerId !== activeLauncherDrag.pointerId) return;
        if (activeLauncherDrag.moved) {
            launcherSettings.left = Number.parseFloat(launcher.style.left) || 0;
            launcherSettings.top = Number.parseFloat(launcher.style.top) || 0;
            launcher.dataset.dragged = "true";
            persistLauncherSettings();
        }
        activeLauncherDrag = null;
        launcher.style.cursor = launcherSettings.moveIcon ? "grab" : "pointer";
        updateLauncherQuickCallPosition();
    };
    launcher.addEventListener("pointerup", finishLauncherDrag);
    launcher.addEventListener("pointercancel", finishLauncherDrag);
    // Build the launcher icon as SVG nodes so it can share the button's press styling.
    const launcherIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    launcherIcon.setAttribute("viewBox", "0 0 32 32");
    launcherIcon.setAttribute("width", "32");
    launcherIcon.setAttribute("height", "32");
    launcherIcon.setAttribute("aria-hidden", "true");
    Object.assign(launcherIcon.style, {
        display: "block",
        flex: "0 0 32px",
        pointerEvents: "none",
    });
    const reportIconShape = document.createElementNS("http://www.w3.org/2000/svg", "path");
    reportIconShape.setAttribute(
        "d",
        "M11 5h2V3.5A1.5 1.5 0 0 1 14.5 2h3A1.5 1.5 0 0 1 19 3.5V5h2a2 2 0 0 1 2 2v1h2a2 2 0 0 1 2 2v17a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2h2V7a2 2 0 0 1 2-2Zm3 0h4V4h-4v1Z"
    );
    reportIconShape.setAttribute("fill", "#f5f5f5");
    reportIconShape.setAttribute("stroke", "#171717");
    reportIconShape.setAttribute("stroke-width", "1.5");
    reportIconShape.setAttribute("stroke-linejoin", "round");
    launcherIcon.appendChild(reportIconShape);
    const reportMark = document.createElementNS("http://www.w3.org/2000/svg", "path");
    reportMark.setAttribute("d", "M16 13v6m0 3v.1");
    reportMark.setAttribute("fill", "none");
    reportMark.setAttribute("stroke", "#252525");
    reportMark.setAttribute("stroke-width", "2.8");
    reportMark.setAttribute("stroke-linecap", "round");
    launcherIcon.appendChild(reportMark);
    const launcherLabel = document.createElement("span");
    launcherLabel.textContent = "Report";
    Object.assign(launcherLabel.style, {
        color: UI_COLORS.white,
        font: "700 15px/1.1 'Trebuchet MS', Arial, sans-serif",
        letterSpacing: "-0.25px",
        textShadow: "0 1px 1px rgba(0,0,0,0.65)",
        pointerEvents: "none",
    });
    const launcherReportSeam = document.createElement("span");
    launcherReportSeam.setAttribute("aria-hidden", "true");
    Object.assign(launcherReportSeam.style, {
        position: "absolute",
        top: "-2px",
        left: "14%",
        width: "72%",
        height: "2px",
        background: "#242424",
        opacity: "0",
        pointerEvents: "none",
        transition: "opacity 180ms ease",
    });
    const updateBadge = document.createElement("span");
    updateBadge.textContent = "!";
    updateBadge.setAttribute("aria-hidden", "true");
    Object.assign(updateBadge.style, {
        position: "absolute",
        top: "-5px",
        left: "-5px",
        display: "none",
        width: "20px",
        height: "20px",
        placeItems: "center",
        boxSizing: "border-box",
        borderRadius: "50%",
        border: "1px solid #171717",
        color: "#fff",
        background: "#f01444",
        font: "800 13px/1 Arial, sans-serif",
        boxShadow: "0 1px 2px #0008",
        pointerEvents: "none",
    });
    launcher.appendChild(launcherIcon);
    launcher.appendChild(launcherLabel);
    launcher.appendChild(launcherReportSeam);
    launcher.appendChild(updateBadge);
    document.body.appendChild(launcher);
    document.body.appendChild(host);

    /***************************************
     * UI References and State
     ***************************************/
    const panel = shadow.querySelector(".panel");
    const closeButton = shadow.querySelector(".close");
    const discordButton = shadow.querySelector(".discord-button");
    const githubButton = shadow.querySelector(".github-button");
    const infoButton = shadow.querySelector(".info-button");
    const changelogButton = shadow.querySelector(".changelog-button");
    const apiHealthButton = shadow.querySelector("[data-api-health]");
    const apiHealthLabel = shadow.querySelector("[data-api-health-label]");
    const changelogLayer = shadow.querySelector(".changelog-layer");
    const changelogCloseButton = shadow.querySelector(".changelog-close");
    const changelogStatus = shadow.querySelector(".changelog-status");
    const changelogList = shadow.querySelector(".changelog-list");
    const settingsButton = shadow.querySelector(".settings-button");
    const updateNotice = shadow.querySelector("[data-update-notice]");
    const updateLabel = shadow.querySelector("[data-update-label]");
    const updateDetails = shadow.querySelector("[data-update-details]");
    const updateButton = shadow.querySelector(".update-button");
    const updateMethodLayer = shadow.querySelector(".update-method-layer");
    const updateMethodCloseButton = shadow.querySelector(".update-method-close");
    const updateMethodOptions = [...shadow.querySelectorAll(".update-method-option")];
    const infoDialogLayer = shadow.querySelector(".info-dialog-layer");
    const infoDialogCloseButton = shadow.querySelector(".info-dialog-close");
    const settingsLayer = shadow.querySelector(".settings-layer");
    const settingsCloseButton = shadow.querySelector(".settings-close");
    const settingsKeyButtons = {
        openKey: shadow.querySelector('[data-key-setting="openKey"]'),
        toggleIconKey: shadow.querySelector('[data-key-setting="toggleIconKey"]'),
    };
    const settingsHideIconWarning = shadow.querySelector("[data-hide-icon-warning]");
    const settingsHideIconRow = shadow.querySelector('[data-setting-row="hideIcon"]');
    const settingsTestModeRow = shadow.querySelector('[data-setting-row="testMode"]');
    const settingsTestModeTooltip = shadow.querySelector("#test-mode-tooltip");
    const settingsAnnouncementRow = shadow.querySelector('[data-setting-row="announceRoomJoin"]');
    const settingsAnnouncementTooltip = shadow.querySelector("#room-announcement-tooltip");
    const settingsClientTokenRow = shadow.querySelector("[data-client-token-row]");
    const settingsClientTokenTooltip = shadow.querySelector("#client-token-tooltip");
    const settingsClientTokenValue = shadow.querySelector("[data-client-token-value]");
    const settingsClientTokenToggleButton = shadow.querySelector("[data-client-token-toggle]");
    const settingsClientTokenCopyButton = shadow.querySelector("[data-client-token-copy]");
    const settingsClientTokenCopyLabel = shadow.querySelector("[data-client-token-copy-label]");
    const settingsClientTokenStatus = shadow.querySelector("[data-client-token-status]");
    const roomAnnouncementSendButton = shadow.querySelector("[data-room-announcement-send]");
    const roomAnnouncementSendStatus = shadow.querySelector("[data-room-announcement-status]");
    const settingsKeyHint = shadow.querySelector(".settings-key-hint");
    const settingsResetButton = shadow.querySelector(".settings-reset");
    const settingsInputs = {
        moveIcon: shadow.querySelector('[data-setting="moveIcon"]'),
        hideIcon: shadow.querySelector('[data-setting="hideIcon"]'),
        hideCallIcon: shadow.querySelector('[data-setting="hideCallIcon"]'),
        hideBothButtons: shadow.querySelector('[data-setting="hideBothButtons"]'),
        hideMessageIcon: shadow.querySelector('[data-setting="hideMessageIcon"]'),
        testMode: shadow.querySelector('[data-setting="testMode"]'),
        showUpdateNotifications: shadow.querySelector('[data-setting="showUpdateNotifications"]'),
        showMessageNotifications: shadow.querySelector('[data-setting="showMessageNotifications"]'),
        announceRoomJoin: shadow.querySelector('[data-setting="announceRoomJoin"]'),
        opacity: shadow.querySelector('[data-setting="opacity"]'),
        size: shadow.querySelector('[data-setting="size"]'),
    };
    shadow.querySelectorAll(".contributor-avatar").forEach((avatar) => {
        avatar.src = PLAYER_AVATAR_URL;
    });
    const playerList = shadow.querySelector(".player-list");
    const playersHeading = shadow.querySelector(".players-heading");
    const playerCount = shadow.querySelector("[data-player-count]");
    const emptyState = shadow.querySelector(".empty-state");
    const emptyStateMessage = shadow.querySelector(".empty-state-message");
    const menuReportActions = shadow.querySelector(".menu-report-actions");
    const manualReportButton = shadow.querySelector(".manual-report-button");
    const menuCallKbiButton = shadow.querySelector(".menu-call-kbi");
    const menuCallLinkLayer = shadow.querySelector(".menu-call-link-layer");
    const menuCallLinkForm = shadow.querySelector(".menu-call-link-form");
    const menuCallRoomLinkInput = shadow.querySelector("#menu-call-room-link");
    const menuCallLinkStatus = shadow.querySelector(".menu-call-link-status");
    const menuCallLinkCancelButton = shadow.querySelector(".menu-call-link-cancel");
    const menuCallLinkSubmitButton = menuCallLinkForm.querySelector('button[type="submit"]');
    const menuCallWarningLayer = shadow.querySelector(".menu-call-warning-layer");
    const menuCallWarningChooseButton = shadow.querySelector(".menu-call-warning-choose");
    const menuCallWarningContinueButton = shadow.querySelector(".menu-call-warning-continue");
    const reportDialogLayer = shadow.querySelector(".report-dialog-layer");
    const reportForm = shadow.querySelector(".report-form");
    const reportTarget = shadow.querySelector("#report-target");
    const reportTargetHelp = shadow.querySelector(".report-target-help");
    const manualReportHelpTooltip = shadow.querySelector("#manual-report-help-tooltip");
    const reportSessionLink = shadow.querySelector("#report-session-link");
    const reportDialogTitle = shadow.querySelector("#report-dialog-title");
    const reportReason = shadow.querySelector("#report-reason");
    const reportReasonSelect = reportReason.parentElement;
    const reportReasonLabel = reportReason.querySelector(".reason-trigger-label");
    const reportReasonOptions = reportReasonSelect.querySelector(".reason-options");
    const reportReasonButtons = [...reportReasonOptions.querySelectorAll(".reason-option")];
    const reportDetails = shadow.querySelector("#report-details");
    const reportDetailsCount = shadow.querySelector("#report-details-count");
    const reportCombinedReason = shadow.querySelector("#report-combined-reason");
    const reportFormStatus = reportForm.querySelector(".report-form-status");
    const reportSubmitButton = reportForm.querySelector('button[type="submit"]');
    const reportCancelButton = shadow.querySelector(".cancel-report");
    const reportDialogAvatar = shadow.querySelector(".report-dialog-avatar");
    const reportReminderToast = shadow.querySelector(".report-reminder-toast");
    const reportReminderCloseButton = shadow.querySelector(".report-reminder-close");
    const reportReminderProgress = shadow.querySelector(".report-reminder-progress-fill");
    const messagesButton = shadow.querySelector(".messages-button");
    const messagesCount = shadow.querySelector(".messages-count");
    const messagesLayer = shadow.querySelector(".messages-layer");
    const messagesCloseButton = shadow.querySelector(".messages-close");
    const messagesIdentityToggle = shadow.querySelector(".messages-identity-toggle");
    const messagesSettingsLayer = shadow.querySelector(".messages-settings-layer");
    const messagesSettingsCloseButton = shadow.querySelector(".messages-settings-close");
    const messagesSettingsDoneButton = shadow.querySelector(".messages-settings-done");
    const messagesSettingsStatus = shadow.querySelector(".messages-settings-status");
    const messagesIdentityValue = shadow.querySelector(".messages-identity-value");
    const messagesIdentityEditButton = shadow.querySelector(".messages-identity-edit");
    const messagesIdentity = shadow.querySelector(".messages-identity");
    const messagesSenderInput = shadow.querySelector(".messages-sender-input");
    const messagesIdentityCancelButton = shadow.querySelector(".messages-identity-cancel");
    const messagesIdentitySaveButton = shadow.querySelector(".messages-identity-save");
    const messagesClearButton = shadow.querySelector(".messages-clear");
    const messagesClearConfirmation = shadow.querySelector(".messages-clear-confirmation");
    const messagesClearCancel = shadow.querySelector(".messages-clear-cancel");
    const messagesClearConfirm = shadow.querySelector(".messages-clear-confirm");
    const messagesList = shadow.querySelector(".messages-list");
    const messagesEmpty = shadow.querySelector(".messages-empty");
    const messagesCompose = shadow.querySelector(".messages-compose");
    const messagesInput = shadow.querySelector(".messages-input");
    const messagesSendButton = shadow.querySelector(".messages-send");
    const messagesStatus = shadow.querySelector(".messages-status");
    const messageNotificationStack = shadow.querySelector(".message-notification-stack");
    const messageNotificationTemplate = shadow.querySelector(".message-notification-template");
    const reportHistoryButton = shadow.querySelector(".report-history-button");
    const reportHistoryCount = shadow.querySelector(".report-history-count");
    const reportHistoryLayer = shadow.querySelector(".report-history-layer");
    const reportHistoryCloseButton = shadow.querySelector(".report-history-close");
    const reportHistoryList = shadow.querySelector(".report-history-list");
    const reportHistoryTabs = [...shadow.querySelectorAll(".report-history-tab")];
    const reportHistoryEmpty = shadow.querySelector(".report-history-empty");
    const reportHistoryStatus = shadow.querySelector(".report-history-status");
    const reportHistoryClearButton = shadow.querySelector(".report-history-clear-open");
    const reportHistoryClearPanel = shadow.querySelector(".report-history-clear-panel");
    const reportHistoryClearOptions = shadow.querySelector(".report-history-clear-options");
    const reportHistoryClearChoices = [...shadow.querySelectorAll(".report-history-clear-choice")];
    const reportHistoryClearConfirmation = shadow.querySelector(".report-history-clear-confirmation");
    const reportHistoryClearConfirmationText = reportHistoryClearConfirmation.querySelector("p");
    const reportHistoryClearConfirmButton = shadow.querySelector(".report-history-clear-confirm");
    const reportHistoryClearStatus = shadow.querySelector(".report-history-clear-status");
    const reportDetailsLayer = shadow.querySelector(".report-details-layer");
    const reportDetailsCloseButton = shadow.querySelector(".report-details-close");
    const reportDetailsAvatar = shadow.querySelector(".report-details-avatar");
    const reportDetailsState = shadow.querySelector(".report-details-state");
    const reportDetailsPlayerCountFact = shadow.querySelector('[data-report-detail-fact="playerCount"]');
    const reportDetailsFields = {
        target: shadow.querySelector('[data-report-detail="target"]'),
        reason: shadow.querySelector('[data-report-detail="reason"]'),
        reporter: shadow.querySelector('[data-report-detail="reporter"]'),
        submitted: shadow.querySelector('[data-report-detail="submitted"]'),
        roomId: shadow.querySelector('[data-report-detail="roomId"]'),
        sessionLink: shadow.querySelector('[data-report-detail="sessionLink"]'),
        playerCount: shadow.querySelector('[data-report-detail="playerCount"]'),
        reportId: shadow.querySelector('[data-report-detail="reportId"]'),
    };
    const roomFullReportTooltip = shadow.querySelector(".room-full-report-tooltip");
    const verificationLayer = shadow.querySelector(".verification-layer");
    const verificationWidget = shadow.querySelector(".verification-widget");
    reportTextFields = new Set([
        reportTarget,
        reportSessionLink,
        reportDetails,
        menuCallRoomLinkInput,
        messagesInput,
        messagesSenderInput,
    ]);
    const verificationStatus = shadow.querySelector(".verification-status");
    const verificationTitle = shadow.querySelector("#verification-title");
    const verificationDescription = shadow.querySelector("#verification-description");
    const verificationCancelButton = shadow.querySelector(".cancel-verification");
    let selectedReportReason = "";
    let captchaWidgetId = null;
    let captchaScriptPromise = null;
    let captchaInProgress = false;
    let captchaAttemptId = 0;
    let pendingReportPayload = null;
    let pendingCallPlayerKey = null;
    let pendingMessageCaptcha = null;
    let messageSendingInProgress = false;
    let pendingMenuCallPlayer = null;
    let reportedPlayerKey = null;
    let manualReport = false;
    let reportSessionLinkEdited = false;
    let reportSubmitting = false;
    let renderedPlayersSignature = null;
    const MENU_CALL_PLAYER_KEY = "__menu__";
    // Per-target UI state lets each player button and the room button show independent results.
    const callKbiButtonStates = new Map();
    const callKbiButtonTimers = new Map();
    const shownReportReminderKeys = new Set();
    let reportReminderTimer = 0;
    let reportHistory = loadReportHistory();
    let reportHistoryFilter = "all";
    customMessages = loadCustomMessages();
    updateMessagesUI();
    const exitTimers = new WeakMap();
    const copyFeedbackTimers = new WeakMap();
    let heldPressButton = null;
    let heldPressControl = null;
    let changelogRequestId = 0;

    /***************************************
     * Launcher Settings and Dialog Helpers
     ***************************************/
    /**
     * Launcher preferences are validated when loaded, then applied to the launcher.
     * Keep the defaults, saved-value checks, and settings controls aligned.
     * @see persistLauncherSettings
     * @see applyLauncherSettings
     * @see updateSettingsKeyLabels
     */
    const LAUNCHER_SETTINGS_STORAGE_KEY = "kourReportLauncherSettings";
    const LEGACY_LAUNCHER_SETTINGS_STORAGE_KEY = "kourReportsLauncherSettings";
    const DEFAULT_LAUNCHER_SETTINGS = {
        moveIcon: false,
        hideIcon: false,
        hideCallIcon: false,
        hideBothButtons: false,
        hideMessageIcon: false,
        testMode: false,
        showUpdateNotifications: true,
        showMessageNotifications: true,
        announceRoomJoin: true,
        opacity: 100,
        size: 72,
        openKey: "AltLeft",
        toggleIconKey: "AltRight",
        left: null,
        top: null,
    };
    let launcherSettings = { ...DEFAULT_LAUNCHER_SETTINGS };
    scheduleReportRoomAnnouncement = () => {
        if (!launcherSettings.announceRoomJoin ||
            reportRoomAnnouncementAttempted ||
            reportRoomAnnouncementTimer !== null ||
            !isReportMatchChatReady()) {
            return;
        }

        const roomSequence = reportRoomAnnouncementSequence;
        const trySend = (attempt, delayMs) => {
            reportRoomAnnouncementTimer = window.setTimeout(() => {
                reportRoomAnnouncementTimer = null;
                if (roomSequence !== reportRoomAnnouncementSequence ||
                    !launcherSettings.announceRoomJoin ||
                    !isReportMatchChatReady()) {
                    return;
                }

                if (sendReportChatAnnouncement(REPORT_ROOM_ANNOUNCEMENT)) {
                    reportRoomAnnouncementAttempted = true;
                    return;
                }
                if (attempt < 3) {
                    trySend(attempt + 1, 2000);
                    return;
                }
                reportRoomAnnouncementAttempted = true;
                console.warn("[Kour Report] Could not send the room announcement after three attempts.");
            }, delayMs);
        };
        trySend(1, 3500);
    };
    let capturingKeySetting = null;
    let activeLauncherDrag = null;
    let settingsTooltipCursorX = 0;
    let settingsTooltipCursorY = 0;
    let testModeTooltipCursorX = 0;
    let testModeTooltipCursorY = 0;
    let announcementTooltipCursorX = 0;
    let announcementTooltipCursorY = 0;
    let settingsClientTokenTooltipCursorX = 0;
    let settingsClientTokenTooltipCursorY = 0;
    let availableUpdateVersion = null;
    let activeReportDetailsButton = null;
    let pendingReportHistoryDeleteScope = null;
    let reportHistoryClearPanelTimer = 0;

    function showPopup(element) {
        clearTimeout(exitTimers.get(element));
        exitTimers.delete(element);
        element.classList.remove("is-closing");
        element.hidden = false;
    }

    function hidePopup(element) {
        if (element.hidden || exitTimers.has(element)) return;
        element.classList.add("is-closing");
        const timer = setTimeout(() => {
            if (exitTimers.get(element) !== timer) return;
            element.hidden = true;
            element.classList.remove("is-closing");
            exitTimers.delete(element);
        }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : POPUP_EXIT_DURATION_MS);
        exitTimers.set(element, timer);
    }

    function loadCustomMessages() {
        try {
            const serialized = window.localStorage.getItem(MESSAGE_STORAGE_KEY);
            if (!serialized) return [];
            const parsed = JSON.parse(serialized);
            if (!Array.isArray(parsed)) throw new TypeError("Stored messages must be an array.");
            const validMessages = parsed.filter((item) => {
                if (!item || typeof item.message !== "string" ||
                    typeof item.messageId !== "string" ||
                    !Number.isFinite(item.receivedAt) ||
                    !Number.isFinite(new Date(item.receivedAt).getTime()) ||
                    typeof item.read !== "boolean") return false;
                const direction = item.direction === "outgoing" || item.direction === "activity"
                    ? item.direction
                    : "incoming";
                if (direction === "activity") {
                    return typeof item.activityKind === "string" &&
                        ["manual-report", "player-report", "kbi-call"].includes(item.activityKind) &&
                        typeof item.target === "string" && item.target.length <= 1000 &&
                        (item.targetRawName === undefined ||
                            (typeof item.targetRawName === "string" && item.targetRawName.length <= 2000)) &&
                        (item.roomId === undefined || (typeof item.roomId === "string" && item.roomId.length <= 1000)) &&
                        (item.reason === undefined || (typeof item.reason === "string" && item.reason.length <= 5000)) &&
                        (item.reporter === undefined || (typeof item.reporter === "string" && item.reporter.length <= 1000)) &&
                        (item.reporterRawName === undefined ||
                            (typeof item.reporterRawName === "string" && item.reporterRawName.length <= 2000)) &&
                        (item.sessionLink === undefined || (typeof item.sessionLink === "string" && item.sessionLink.length <= 1000)) &&
                        (item.reportId === null || typeof item.reportId === "string") &&
                        (item.clientToken === undefined ||
                            (typeof item.clientToken === "string" && item.clientToken.length <= 100)) &&
                        typeof item.testMode === "boolean";
                }
                if (direction === "incoming") {
                    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.messageId);
                }
                return typeof item.status === "string" &&
                    (item.errorLog === undefined ||
                        (item.errorLog && typeof item.errorLog === "object" &&
                            (item.errorLog.code === null ||
                                (typeof item.errorLog.code === "string" && item.errorLog.code.length <= 128)) &&
                            (item.errorLog.httpStatus === null ||
                                (Number.isInteger(item.errorLog.httpStatus) &&
                                    item.errorLog.httpStatus >= 100 && item.errorLog.httpStatus <= 599)) &&
                            typeof item.errorLog.message === "string" &&
                            item.errorLog.message.length <= 1000 &&
                            (item.errorLog.details === undefined ||
                                (typeof item.errorLog.details === "string" && item.errorLog.details.length <= 5000)))) &&
                    (item.clientToken === undefined ||
                        (typeof item.clientToken === "string" && item.clientToken.length <= 100));
            }).map((item) => ({
                ...item,
                direction: item.direction === "outgoing" || item.direction === "activity"
                    ? item.direction
                    : "incoming",
                status: item.status === "error"
                    ? "error"
                    : item.status === "sending"
                        ? "sending"
                        : "sent",
                senderName: typeof item.senderName === "string" && item.senderName.trim()
                    ? item.senderName.trim().slice(0, 100)
                    : item.direction === "incoming" ? "Admin" : "You",
            }));
            return limitStoredMessages(validMessages);
        } catch (error) {
            console.warn("[Kour Report] Could not load saved messages:", error);
            return [];
        }
    }

    function limitStoredMessages(messages) {
        const limited = [...messages];
        while (limited.length > MAX_STORED_MESSAGES) {
            let oldestReadIndex = -1;
            for (let index = limited.length - 1; index >= 0; index -= 1) {
                if (limited[index].read) {
                    oldestReadIndex = index;
                    break;
                }
            }
            if (oldestReadIndex === -1) break;
            limited.splice(oldestReadIndex, 1);
        }
        return limited;
    }

    function persistCustomMessages() {
        try {
            window.localStorage.setItem(MESSAGE_STORAGE_KEY, JSON.stringify(customMessages));
            return true;
        } catch (error) {
            console.error("[Kour Report] Could not save messages locally:", error);
            return false;
        }
    }

    function renderOutgoingMessageStatus(element, item) {
        const status = item.status === "error"
            ? "error"
            : item.status === "sending"
                ? "sending"
                : "sent";
        const statusLabel = status === "error"
            ? `Message not sent: ${item.error || "Could not send"}`
            : status === "sending" ? "Sending message" : "Message sent";
        const statusText = status === "error"
            ? "Not sent"
            : status === "sending" ? "Sending…" : "Sent";
        element.className = `messages-entry-status is-${status}`;
        element.setAttribute("role", "status");
        element.setAttribute("aria-live", "polite");
        element.setAttribute("aria-label", statusLabel);
        element.title = status === "error" ? statusLabel : status === "sending" ? "Sending" : "Sent";
        element.textContent = statusText;
    }

    function renderOutgoingMessageTokenButton(button, item) {
        const hasSavedToken = typeof item.clientToken === "string" && item.clientToken.length > 0;
        const isActivity = item.direction === "activity";
        const entryType = isActivity ? "report" : "message";
        button.disabled = !hasSavedToken;
        button.textContent = hasSavedToken ? "View token details" : "Token unavailable";
        button.title = hasSavedToken
            ? `View the client token used for this ${entryType}.`
            : `The token used for this older ${entryType} was not saved.`;
        button.setAttribute(
            "aria-label",
            hasSavedToken
                ? `View token details for this ${entryType}`
                : `Token unavailable for this ${entryType}`
        );
        button.setAttribute("aria-expanded", "false");
    }

    function createMessageTokenDisclosure(entry, item, index) {
        const toggleButton = document.createElement("button");
        toggleButton.className = "messages-entry-action messages-entry-token-toggle";
        toggleButton.type = "button";
        renderOutgoingMessageTokenButton(toggleButton, item);

        const panel = document.createElement("div");
        panel.className = "messages-entry-token-value";
        panel.id = `messages-entry-token-${index}`;
        panel.hidden = true;
        const label = document.createElement("span");
        label.className = "messages-entry-token-label";
        label.textContent = "CLIENT TOKEN USED";
        const tokenCode = document.createElement("code");
        tokenCode.className = "messages-entry-token-code";
        const maskedToken = "••••••••••••••••";
        tokenCode.textContent = maskedToken;
        const warning = document.createElement("p");
        warning.className = "messages-entry-token-warning";
        warning.textContent = "Never share this token with anyone. Store it securely.";
        const controls = document.createElement("div");
        controls.className = "messages-entry-token-actions";
        const revealButton = document.createElement("button");
        revealButton.className = "messages-entry-action";
        revealButton.type = "button";
        revealButton.textContent = "Reveal";
        revealButton.setAttribute("aria-pressed", "false");
        const copyButton = document.createElement("button");
        copyButton.className = "messages-entry-action";
        copyButton.type = "button";
        copyButton.textContent = "Copy token";
        copyButton.disabled = true;
        controls.append(revealButton, copyButton);
        panel.append(label, tokenCode, warning, controls);
        toggleButton.setAttribute("aria-controls", panel.id);

        let tokenRevealed = false;
        const findCurrentItem = () =>
            customMessages.find((messageItem) => messageItem.messageId === entry.dataset.messageId);
        const resetToken = () => {
            tokenRevealed = false;
            tokenCode.textContent = maskedToken;
            revealButton.textContent = "Reveal";
            revealButton.setAttribute("aria-pressed", "false");
            copyButton.textContent = "Copy token";
            copyButton.title = "";
            copyButton.disabled = true;
        };
        const collapse = () => {
            panel.hidden = true;
            resetToken();
            const currentItem = findCurrentItem();
            if (currentItem) renderOutgoingMessageTokenButton(toggleButton, currentItem);
            toggleButton.setAttribute("aria-expanded", "false");
        };
        toggleButton.addEventListener("click", () => {
            if (panel.hidden) {
                panel.hidden = false;
                toggleButton.textContent = "Hide token details";
                toggleButton.setAttribute(
                    "aria-label",
                    `Hide token details for this ${item.direction === "activity" ? "report" : "message"}`
                );
                toggleButton.setAttribute("aria-expanded", "true");
            } else {
                collapse();
            }
        });
        revealButton.addEventListener("click", () => {
            const currentItem = findCurrentItem();
            if (!currentItem || typeof currentItem.clientToken !== "string" ||
                currentItem.clientToken.length === 0) return;
            tokenRevealed = !tokenRevealed;
            tokenCode.textContent = tokenRevealed ? currentItem.clientToken : maskedToken;
            revealButton.textContent = tokenRevealed ? "Hide" : "Reveal";
            revealButton.setAttribute("aria-pressed", String(tokenRevealed));
            copyButton.textContent = "Copy token";
            copyButton.title = "";
            copyButton.disabled = !tokenRevealed;
        });
        copyButton.addEventListener("click", async () => {
            if (!tokenRevealed) return;
            const currentItem = findCurrentItem();
            if (!currentItem || typeof currentItem.clientToken !== "string" ||
                currentItem.clientToken.length === 0) return;
            copyButton.disabled = true;
            try {
                await writeTextToClipboard(currentItem.clientToken);
                copyButton.textContent = "Copied";
                copyButton.title = "Token copied. Never share it; store it securely.";
            } catch (error) {
                console.warn("[Kour Report] Could not copy a message client token:", error);
                copyButton.textContent = "Copy failed";
                copyButton.title = "Could not copy the client token.";
            } finally {
                copyButton.disabled = !tokenRevealed;
            }
        });
        addButtonPressAnimation(revealButton);
        addButtonPressAnimation(copyButton);
        return { toggleButton, panel, collapse };
    }

    function closeOtherMessageActionMenus(actions) {
        messagesList.querySelectorAll(".messages-entry-actions").forEach((otherActions) => {
            if (otherActions === actions) return;
            const otherTokenButton = otherActions.querySelector(".messages-entry-token-toggle");
            if (otherTokenButton && otherTokenButton.getAttribute("aria-expanded") === "true") {
                otherTokenButton.click();
            }
            const otherMenu = otherActions.querySelector(".messages-entry-menu");
            if (otherMenu) otherMenu.hidden = true;
            const otherDeleteConfirmation = otherActions.querySelector(".messages-entry-delete-confirm");
            if (otherDeleteConfirmation) otherDeleteConfirmation.hidden = true;
            const otherMoreButton = otherActions.querySelector(".messages-entry-more");
            if (otherMoreButton) otherMoreButton.setAttribute("aria-expanded", "false");
            const otherRow = otherActions.closest(".messages-row");
            if (otherRow) otherRow.style.zIndex = "";
        });
    }

    function createKbiCallActivityIcon() {
        const visual = document.createElement("span");
        visual.className = "messages-activity-icon is-call";
        visual.setAttribute("aria-hidden", "true");
        const callIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        callIcon.setAttribute("viewBox", "0 0 24 24");
        const callPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        callPath.setAttribute("d", "M7.2 3.8 10 3l2 4.8-2.1 1.6a15 15 0 0 0 4.7 4.7l1.6-2.1 4.8 2-.8 2.8a3 3 0 0 1-3.3 2.1A17.5 17.5 0 0 1 5.1 7.1a3 3 0 0 1 2.1-3.3Z");
        const callSignal = document.createElementNS("http://www.w3.org/2000/svg", "path");
        callSignal.setAttribute("d", "M15.5 6.5a4.5 4.5 0 0 1 4 4M16.5 3a8 8 0 0 1 7 7");
        callIcon.append(callPath, callSignal);
        visual.appendChild(callIcon);
        const callTag = document.createElement("span");
        callTag.className = "messages-activity-call-tag";
        callTag.textContent = "KBI";
        visual.appendChild(callTag);
        return visual;
    }

    function renderMessages() {
        const existingMessageIds = new Set(
            [...messagesList.querySelectorAll("[data-message-id]")].map((element) => element.dataset.messageId)
        );
        const hasNewMessages = customMessages.some((item) => !existingMessageIds.has(item.messageId));
        messagesList.replaceChildren();
        messagesEmpty.hidden = customMessages.length > 0;
        messagesList.hidden = customMessages.length === 0;
        [...customMessages].reverse().forEach((item, index) => {
            const activity = item.direction === "activity";
            const outgoing = item.direction === "outgoing";
            const row = document.createElement("div");
            row.className = `messages-row${activity ? " is-activity" : outgoing ? " is-outgoing" : ""}`;
            const isNewMessage = !existingMessageIds.has(item.messageId);
            if (isNewMessage) {
                row.classList.add("is-new");
                const animationName = outgoing ? "messages-send-from-bottom" : "messages-bubble-in";
                const handleAnimationEnd = (event) => {
                    if (event.target !== row || event.animationName !== animationName) return;
                    row.removeEventListener("animationend", handleAnimationEnd);
                    row.classList.remove("is-new");
                };
                row.addEventListener("animationend", handleAnimationEnd);
            }
            if (activity) {
                const entry = document.createElement("article");
                entry.className = "messages-activity";
                entry.setAttribute("role", "listitem");
                entry.dataset.messageId = item.messageId;
                const isCall = item.activityKind === "kbi-call";
                let visual;
                if (isCall) {
                    visual = createKbiCallActivityIcon();
                } else {
                    visual = document.createElement("img");
                    visual.className = "messages-activity-avatar";
                    visual.src = PLAYER_AVATAR_URL;
                    visual.alt = `${item.target || "Player"} avatar`;
                }
                const content = document.createElement("span");
                content.className = "messages-activity-content";
                const heading = document.createElement("span");
                heading.className = "messages-activity-heading";
                const title = document.createElement("strong");
                title.className = "messages-activity-title";
                title.textContent = item.activityKind === "kbi-call"
                    ? "Call KBI sent"
                    : item.activityKind === "manual-report"
                        ? "Manual report sent"
                        : "Player report sent";
                heading.appendChild(title);
                const target = document.createElement("span");
                target.className = "messages-activity-target";
                appendPlayerName(
                    target,
                    typeof item.targetRawName === "string" ? item.targetRawName : "",
                    item.target || "Unknown player"
                );
                const meta = document.createElement("span");
                meta.className = "messages-activity-meta";
                const date = document.createElement("time");
                date.dateTime = new Date(item.receivedAt).toISOString();
                date.textContent = `Sent ${new Date(item.receivedAt).toLocaleString()}`;
                meta.appendChild(date);
                if (item.reportId) {
                    const reportId = document.createElement("code");
                    reportId.className = "messages-activity-id";
                    reportId.textContent = `ID ${item.reportId}`;
                    meta.appendChild(reportId);
                }
                if (item.roomId) {
                    const room = document.createElement("span");
                    room.className = "messages-activity-room";
                    room.textContent = `Room ${item.roomId}`;
                    meta.appendChild(room);
                }
                const viewReportButton = document.createElement("button");
                viewReportButton.className = "report-history-action messages-activity-view";
                viewReportButton.type = "button";
                viewReportButton.textContent = "View report";
                viewReportButton.setAttribute("aria-haspopup", "dialog");
                viewReportButton.setAttribute("aria-label", `View report for ${item.target || "player"}`);
                addButtonPressAnimation(viewReportButton);
                viewReportButton.addEventListener("click", () => {
                    openReportDetails({
                        target: item.target,
                        targetRawName: item.targetRawName,
                        reason: item.reason,
                        reporter: item.reporter,
                        reporterRawName: item.reporterRawName,
                        submittedAt: item.receivedAt,
                        roomId: item.roomId,
                        sessionLink: item.sessionLink,
                        reportId: item.reportId,
                        testMode: item.testMode,
                    }, viewReportButton);
                });
                content.append(heading, target, meta, viewReportButton);
                const actions = document.createElement("div");
                actions.className = "messages-entry-actions";
                const moreButton = document.createElement("button");
                moreButton.className = "messages-entry-more";
                moreButton.type = "button";
                moreButton.textContent = "⋯";
                moreButton.setAttribute("aria-label", "Report activity options");
                moreButton.setAttribute("aria-expanded", "false");
                moreButton.title = "Report activity options";
                const menu = document.createElement("div");
                menu.className = "messages-entry-menu";
                menu.hidden = true;
                const reportIdLabel = document.createElement("span");
                reportIdLabel.className = "messages-entry-id-label";
                reportIdLabel.textContent = "Report ID";
                const reportIdValue = document.createElement("code");
                reportIdValue.className = "messages-entry-id";
                reportIdValue.textContent = item.reportId || "Not available";
                const copyReportIdButton = document.createElement("button");
                copyReportIdButton.className = "messages-entry-action";
                copyReportIdButton.type = "button";
                copyReportIdButton.textContent = "Copy report ID";
                copyReportIdButton.disabled = typeof item.reportId !== "string" || !item.reportId;
                const tokenDisclosure = createMessageTokenDisclosure(entry, item, index);
                menu.append(
                    reportIdLabel,
                    reportIdValue,
                    copyReportIdButton,
                    tokenDisclosure.toggleButton,
                    tokenDisclosure.panel
                );
                actions.append(moreButton, menu);
                addButtonPressAnimation(moreButton);
                addButtonPressAnimation(copyReportIdButton);
                moreButton.addEventListener("click", () => {
                    const opening = menu.hidden;
                    if (!opening) tokenDisclosure.collapse();
                    closeOtherMessageActionMenus(actions);
                    menu.hidden = !opening;
                    moreButton.setAttribute("aria-expanded", String(opening));
                    row.style.zIndex = opening ? "10" : "";
                });
                copyReportIdButton.addEventListener("click", async () => {
                    if (!item.reportId) return;
                    try {
                        await writeTextToClipboard(item.reportId);
                        copyReportIdButton.textContent = "Copied";
                        messagesStatus.textContent = "Report ID copied to clipboard.";
                    } catch (error) {
                        console.warn("[Kour Report] Could not copy the report ID from message history:", error);
                        copyReportIdButton.textContent = "Copy failed";
                        messagesStatus.textContent = "Could not copy the report ID.";
                    }
                });
                entry.append(visual, content, actions);
                row.appendChild(entry);
                messagesList.appendChild(row);
                return;
            }
            const entry = document.createElement("article");
            entry.className = `messages-entry${outgoing ? " is-outgoing" : ""}${item.read ? "" : " is-unread"}`;
            entry.setAttribute("role", "listitem");
            entry.dataset.messageId = item.messageId;
            entry.title = `Message ID: ${item.messageId}`;
            entry.tabIndex = -1;
            const avatar = document.createElement("img");
            avatar.className = "messages-entry-avatar";
            avatar.src = outgoing ? PLAYER_AVATAR_URL : KBI_AVATAR_URL;
            avatar.alt = "";
            avatar.setAttribute("aria-hidden", "true");
            const sender = document.createElement("span");
            sender.className = "messages-entry-sender";
            let verifiedBadge = null;
            if (!outgoing) {
                verifiedBadge = document.createElement("span");
                verifiedBadge.className = "messages-verified-badge";
                verifiedBadge.setAttribute("role", "img");
                verifiedBadge.setAttribute("aria-label", "Verified KourKBI sender");
                verifiedBadge.title = "Verified KourKBI sender";
                const gradientId = `messages-verified-gradient-${index}`;
                verifiedBadge.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M13.1655 2.3045L14.4105 3.003L15.838 3.0205C16.668 3.031 17.433 3.4725 17.857 4.186L18.586 5.4135L19.8135 6.1425C20.5275 6.5665 20.969 7.3315 20.979 8.1615L20.9965 9.589L21.695 10.834C22.101 11.558 22.101 12.4415 21.695 13.1655L20.9965 14.4105L20.979 15.838C20.9685 16.668 20.527 17.433 19.8135 17.857L18.586 18.586L17.857 19.8135C17.433 20.5275 16.668 20.969 15.838 20.979L14.4105 20.9965L13.1655 21.695C12.4415 22.101 11.558 22.101 10.834 21.695L9.589 20.9965L8.1615 20.979C7.3315 20.9685 6.5665 20.527 6.1425 19.8135L5.4135 18.586L4.186 17.857C3.472 17.433 3.0305 16.668 3.0205 15.838L3.003 14.4105L2.3045 13.1655C1.8985 12.4415 1.8985 11.558 2.3045 10.834L3.003 9.589L3.0205 8.1615C3.031 7.3315 3.4725 6.5665 4.186 6.1425L5.4135 5.4135L6.1425 4.186C6.5665 3.472 7.3315 3.0305 8.1615 3.0205L9.589 3.003L10.834 2.3045C11.5585 1.8985 12.4415 1.8985 13.1655 2.3045Z" fill="url(#${gradientId})"/>
                    <path opacity=".05" d="M16.0861 8.08584L11.0001 13.1718L8.41412 10.5858C8.02362 10.1953 7.39062 10.1953 7.00012 10.5858L6.29312 11.2928C5.90262 11.6833 5.90262 12.3163 6.29312 12.7068L10.2931 16.7068C10.6836 17.0973 11.3166 17.0973 11.7071 16.7068L18.2071 10.2068C18.5976 9.81634 18.5976 9.18334 18.2071 8.79284L17.5001 8.08584C17.1096 7.69534 16.4766 7.69534 16.0861 8.08584Z" fill="black"/>
                    <path opacity=".07" d="M10.4695 16.5302L6.46951 12.5302C6.17651 12.2372 6.17651 11.7622 6.46951 11.4697L7.17651 10.7627C7.46951 10.4697 7.94451 10.4697 8.23701 10.7627L11 13.5252L16.2625 8.26272C16.555 7.96972 17.0305 7.96972 17.323 8.26272L18.03 8.96972C18.323 9.26272 18.323 9.73772 18.03 10.0302L11.53 16.5302C11.2375 16.8227 10.7625 16.8227 10.4695 16.5302Z" fill="black"/>
                    <path d="M10.6465 16.3536L6.6465 12.3536C6.451 12.1581 6.451 11.8416 6.6465 11.6466L7.3535 10.9396C7.549 10.7441 7.8655 10.7441 8.0605 10.9396L11 13.8791L16.4395 8.43959C16.635 8.24409 16.951 8.24409 17.1465 8.43959L17.8535 9.14659C18.049 9.34209 18.049 9.65859 17.8535 9.85359L11.3535 16.3536C11.1585 16.5491 10.8415 16.5491 10.6465 16.3536Z" fill="white"/>
                    <defs><linearGradient id="${gradientId}" x1="5.1975" y1="5.1975" x2="18.973" y2="18.973" gradientUnits="userSpaceOnUse"><stop stop-color="#75daff"/><stop offset="1" stop-color="#1ea2e4"/></linearGradient></defs>
                </svg>`;
            }
            const senderName = document.createElement("span");
            senderName.className = "messages-entry-sender-name";
            senderName.textContent = outgoing ? (item.senderName || "You") : (item.senderName || "Admin");
            if (outgoing) sender.append(senderName);
            else sender.append(verifiedBadge, senderName);
            const body = document.createElement("p");
            body.className = "messages-entry-body";
            body.textContent = item.message;
            const meta = document.createElement("div");
            meta.className = "messages-entry-meta";
            const date = document.createElement("time");
            date.dateTime = new Date(item.receivedAt).toISOString();
            date.textContent = new Date(item.receivedAt).toLocaleString();
            if (outgoing) {
                const status = document.createElement("span");
                renderOutgoingMessageStatus(status, item);
                meta.append(status, date);
            } else {
                meta.append(date);
            }
            const actions = document.createElement("div");
            actions.className = "messages-entry-actions";
            const moreButton = document.createElement("button");
            moreButton.className = "messages-entry-more";
            moreButton.type = "button";
            moreButton.textContent = "⋯";
            moreButton.setAttribute("aria-label", "Message options");
            moreButton.setAttribute("aria-expanded", "false");
            moreButton.title = "Message options";
            const menu = document.createElement("div");
            menu.className = "messages-entry-menu";
            menu.hidden = true;
            const idLabel = document.createElement("span");
            idLabel.className = "messages-entry-id-label";
            idLabel.textContent = "Message ID";
            const idValue = document.createElement("code");
            idValue.className = "messages-entry-id";
            idValue.textContent = item.messageId;
            const tokenDisclosure = outgoing
                ? createMessageTokenDisclosure(entry, item, index)
                : null;
            let errorLogToggle = null;
            let errorLogPanel = null;
            if (outgoing && item.status === "error") {
                errorLogToggle = document.createElement("button");
                errorLogToggle.className = "messages-entry-action";
                errorLogToggle.type = "button";
                errorLogToggle.textContent = "View error log";
                errorLogToggle.setAttribute("aria-expanded", "false");
                const errorLog = item.errorLog && typeof item.errorLog === "object"
                    ? item.errorLog
                    : { code: null, httpStatus: null, message: item.error || "Could not send the message." };
                errorLogPanel = document.createElement("div");
                errorLogPanel.className = "messages-error-log";
                errorLogPanel.id = `messages-error-log-${index}`;
                errorLogPanel.hidden = true;
                errorLogToggle.setAttribute("aria-controls", errorLogPanel.id);
                const errorPanelTitle = document.createElement("span");
                errorPanelTitle.className = "messages-error-log-title";
                errorPanelTitle.textContent = "Message send error";
                errorLogPanel.appendChild(errorPanelTitle);
                const appendErrorValue = (labelText, value) => {
                    if (value === null || value === undefined || value === "") return;
                    const label = document.createElement("span");
                    label.className = "messages-entry-id-label";
                    label.textContent = labelText;
                    const content = document.createElement("code");
                    content.className = "messages-error-log-value";
                    content.textContent = String(value);
                    errorLogPanel.append(label, content);
                };
                appendErrorValue("Error code", errorLog.code);
                appendErrorValue("HTTP status", errorLog.httpStatus);
                appendErrorValue("Reason", errorLog.message);
                appendErrorValue("Response details", errorLog.details);
                errorLogToggle.addEventListener("click", () => {
                    errorLogPanel.hidden = !errorLogPanel.hidden;
                    errorLogToggle.setAttribute("aria-expanded", String(!errorLogPanel.hidden));
                    errorLogToggle.textContent = errorLogPanel.hidden ? "View error log" : "Hide error log";
                });
                addButtonPressAnimation(errorLogToggle);
            }
            const copyMessageButton = document.createElement("button");
            copyMessageButton.className = "messages-entry-action";
            copyMessageButton.type = "button";
            copyMessageButton.textContent = "Copy message";
            const copyIdButton = document.createElement("button");
            copyIdButton.className = "messages-entry-action";
            copyIdButton.type = "button";
            copyIdButton.textContent = "Copy ID";
            const deleteButton = document.createElement("button");
            deleteButton.className = "messages-entry-action is-danger";
            deleteButton.type = "button";
            deleteButton.textContent = "Delete from this device";
            menu.append(idLabel, idValue);
            if (tokenDisclosure) {
                menu.append(tokenDisclosure.toggleButton, tokenDisclosure.panel);
            }
            if (errorLogToggle && errorLogPanel) menu.append(errorLogToggle, errorLogPanel);
            menu.append(copyMessageButton, copyIdButton, deleteButton);
            const deleteConfirmation = document.createElement("div");
            deleteConfirmation.className = "messages-entry-delete-confirm";
            deleteConfirmation.hidden = true;
            const deleteWarning = document.createElement("p");
            deleteWarning.textContent =
                "This removes the message only from this device. It does not delete the server copy.";
            const deleteActions = document.createElement("div");
            deleteActions.className = "messages-entry-delete-actions";
            const cancelDeleteButton = document.createElement("button");
            cancelDeleteButton.className = "messages-entry-action";
            cancelDeleteButton.type = "button";
            cancelDeleteButton.textContent = "Cancel";
            const confirmDeleteButton = document.createElement("button");
            confirmDeleteButton.className = "messages-entry-action is-danger";
            confirmDeleteButton.type = "button";
            confirmDeleteButton.textContent = "Delete here";
            deleteActions.append(cancelDeleteButton, confirmDeleteButton);
            deleteConfirmation.append(deleteWarning, deleteActions);
            actions.append(moreButton, menu, deleteConfirmation);
            const entryActionButtons = [
                moreButton,
                copyMessageButton,
                copyIdButton,
                deleteButton,
                cancelDeleteButton,
                confirmDeleteButton,
            ];
            if (tokenDisclosure) entryActionButtons.push(tokenDisclosure.toggleButton);
            entryActionButtons.forEach((button) => addButtonPressAnimation(button));
            moreButton.addEventListener("click", () => {
                const opening = menu.hidden;
                if (!opening && tokenDisclosure) tokenDisclosure.collapse();
                closeOtherMessageActionMenus(actions);
                menu.hidden = !opening;
                deleteConfirmation.hidden = true;
                moreButton.setAttribute("aria-expanded", String(opening));
                row.style.zIndex = opening ? "10" : "";
            });
            copyMessageButton.addEventListener("click", async () => {
                try {
                    await writeTextToClipboard(item.message);
                    messagesStatus.textContent = "Message copied to clipboard.";
                    menu.hidden = true;
                    moreButton.setAttribute("aria-expanded", "false");
                    if (tokenDisclosure) tokenDisclosure.collapse();
                    row.style.zIndex = "";
                } catch (error) {
                    console.warn("[Kour Report] Could not copy message:", error);
                    messagesStatus.textContent = "Could not copy the message.";
                }
            });
            copyIdButton.addEventListener("click", async () => {
                try {
                    await writeTextToClipboard(item.messageId);
                    messagesStatus.textContent = "Message ID copied to clipboard.";
                    menu.hidden = true;
                    moreButton.setAttribute("aria-expanded", "false");
                    if (tokenDisclosure) tokenDisclosure.collapse();
                    row.style.zIndex = "";
                } catch (error) {
                    console.warn("[Kour Report] Could not copy message ID:", error);
                    messagesStatus.textContent = "Could not copy the message ID.";
                }
            });
            deleteButton.addEventListener("click", () => {
                menu.hidden = true;
                deleteConfirmation.hidden = false;
                moreButton.setAttribute("aria-expanded", "true");
                if (tokenDisclosure) tokenDisclosure.collapse();
                confirmDeleteButton.focus();
            });
            cancelDeleteButton.addEventListener("click", () => {
                deleteConfirmation.hidden = true;
                menu.hidden = false;
                moreButton.setAttribute("aria-expanded", "true");
                deleteButton.focus();
            });
            confirmDeleteButton.addEventListener("click", () => removeCustomMessage(item.messageId));
            entry.append(sender, body, meta, actions);
            if (outgoing) {
                row.append(entry, avatar);
            } else {
                row.append(avatar, entry);
            }
            messagesList.appendChild(row);
        });
        if (hasNewMessages) {
            window.requestAnimationFrame(() => {
                messagesList.scrollTop = messagesList.scrollHeight;
            });
        }
    }

    function updateMessagesUI() {
        const unreadCount = customMessages.reduce(
            (count, item) => count + (item.direction === "incoming" && !item.read ? 1 : 0),
            0
        );
        const unreadLabel = unreadCount > 99 ? "99+" : String(unreadCount);
        messagesCount.textContent = unreadLabel;
        messagesCount.hidden = unreadCount === 0;
        launcherMessagesCount.textContent = unreadLabel;
        launcherMessagesCount.hidden = unreadCount === 0;
        messagesButton.setAttribute(
            "aria-label",
            `Messages, ${unreadCount} unread${unreadCount === 1 ? " message" : " messages"}`
        );
        launcherQuickMessages.setAttribute(
            "aria-label",
            unreadCount
                ? `Open messages from KBI, ${unreadCount} unread${unreadCount === 1 ? " message" : " messages"}`
                : "Open messages from KBI"
        );
        renderMessages();
    }

    function removeCustomMessage(messageId) {
        const remainingMessages = customMessages.filter((item) => item.messageId !== messageId);
        if (remainingMessages.length === customMessages.length) return;
        customMessages = remainingMessages;
        persistCustomMessages();
        updateMessagesUI();
        messagesStatus.textContent = "Message removed from this device only. The server copy remains.";
        messagesInput.focus();
    }

    function removeMessageNotification(toast, advanceQueue = false) {
        const timers = messageNotificationTimers.get(toast);
        if (timers) {
            window.clearTimeout(timers.dismiss);
            window.clearTimeout(timers.exit);
            messageNotificationTimers.delete(toast);
        }
        toast.remove();
        if (!messageNotificationStack.querySelector(".message-notification-toast")) {
            messageNotificationStack.hidden = true;
        }
        if (advanceQueue) showNextMessageNotification();
    }

    function dismissMessageNotification(immediate = false, notification = null) {
        if (immediate && !notification) messageNotificationQueue = [];
        const notifications = notification
            ? [notification]
            : [...messageNotificationStack.querySelectorAll(".message-notification-toast")];
        notifications.forEach((toast) => {
            const timers = messageNotificationTimers.get(toast);
            if (timers) {
                window.clearTimeout(timers.dismiss);
                timers.dismiss = 0;
            }
            if (immediate) {
                removeMessageNotification(toast);
                return;
            }
            if (toast.classList.contains("is-closing")) return;
            toast.classList.remove("is-entering");
            toast.classList.add("is-closing");
            if (timers) {
                timers.exit = window.setTimeout(
                    () => removeMessageNotification(toast, true),
                    MESSAGE_NOTIFICATION_ANIMATION_MS
                );
            } else {
                window.setTimeout(
                    () => removeMessageNotification(toast, true),
                    MESSAGE_NOTIFICATION_ANIMATION_MS
                );
            }
        });
    }

    function muteMessageNotifications(toast) {
        launcherSettings.showMessageNotifications = false;
        settingsInputs.showMessageNotifications.checked = false;
        messageNotificationQueue = [];
        applyLauncherSettings();
        persistLauncherSettings();

        const openButton = toast.querySelector(".message-notification-open");
        const progress = toast.querySelector(".message-notification-progress-fill");
        const timers = messageNotificationTimers.get(toast);
        const heading = toast.querySelector(".message-notification-header strong");
        const eyebrow = toast.querySelector(".message-notification-eyebrow");
        const copy = toast.querySelector(".message-notification-copy");
        const viewIcon = toast.querySelector(".message-notification-view-icon");
        const muteButton = toast.querySelector(".message-notification-mute");
        openButton.disabled = true;
        openButton.setAttribute("aria-label", "Message notifications muted");
        heading.textContent = "Notifications muted";
        eyebrow.textContent = "Settings";
        copy.textContent = "You can turn them back on in Settings.";
        viewIcon.remove();
        muteButton.hidden = true;
        toast.dataset.kind = "muted";

        if (timers) {
            window.clearTimeout(timers.dismiss);
            window.clearTimeout(timers.exit);
            timers.exit = 0;
            toast.classList.remove("is-entering", "is-closing");
            progress.classList.remove("is-running");
            void toast.offsetWidth;
            progress.classList.add("is-running");
            timers.dismiss = window.setTimeout(
                () => dismissMessageNotification(false, toast),
                MESSAGE_NOTIFICATION_DURATION_MS
            );
        }
    }

    function createMessageNotification(item) {
        const toast = messageNotificationTemplate.content.firstElementChild.cloneNode(true);
        toast.dataset.messageId = item.messageId;
        const copy = toast.querySelector(".message-notification-copy");
        const openButton = toast.querySelector(".message-notification-open");
        const muteButton = toast.querySelector(".message-notification-mute");
        const closeButton = toast.querySelector(".message-notification-close");
        const progress = toast.querySelector(".message-notification-progress-fill");
        copy.textContent = item.message;
        openButton.dataset.messageId = item.messageId;
        openButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            openMessages(openButton.dataset.messageId, messagesButton);
        });
        closeButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            dismissMessageNotification(false, toast);
        });
        muteButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            muteMessageNotifications(toast);
        });
        addButtonPressAnimation(closeButton);

        const timers = { dismiss: 0, exit: 0 };
        messageNotificationTimers.set(toast, timers);
        messageNotificationStack.hidden = false;
        messageNotificationStack.insertBefore(toast, messageNotificationStack.firstChild);
        void toast.offsetWidth;
        toast.classList.add("is-entering");
        void progress.offsetWidth;
        progress.classList.add("is-running");
        timers.dismiss = window.setTimeout(
            () => dismissMessageNotification(false, toast),
            MESSAGE_NOTIFICATION_DURATION_MS
        );
    }

    function showNextMessageNotification() {
        if (!launcherSettings.showMessageNotifications ||
            messageNotificationStack.querySelector(".message-notification-toast")) return;
        const nextMessage = messageNotificationQueue.shift();
        if (nextMessage) createMessageNotification(nextMessage);
    }

    function showMessageNotification(item) {
        if (!launcherSettings.showMessageNotifications) return;
        const activeToast = messageNotificationStack.querySelector(".message-notification-toast");
        if (activeToast && activeToast.dataset.messageId === item.messageId) return;
        if (messageNotificationQueue.some((queuedItem) => queuedItem.messageId === item.messageId)) return;
        if (activeToast) {
            const queueCapacity = MAX_QUEUED_MESSAGE_NOTIFICATIONS - 1;
            while (messageNotificationQueue.length >= queueCapacity) messageNotificationQueue.shift();
            messageNotificationQueue.push(item);
            return;
        }
        createMessageNotification(item);
    }

    function storeCustomMessage(message, messageId, senderName = "Admin") {
        if (typeof message !== "string" || !message.trim() ||
            typeof messageId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId)) {
            console.warn("[Kour Report] The API returned a personalized message without a valid message ID.");
            return null;
        }
        if (customMessages.some((item) => item.messageId === messageId)) return null;
        const item = {
            message: message.trim(),
            messageId,
            senderName: typeof senderName === "string" && senderName.trim()
                ? senderName.trim().slice(0, 100)
                : "Admin",
            direction: "incoming",
            status: "sent",
            receivedAt: Date.now(),
            read: !messagesLayer.hidden && !messagesLayer.classList.contains("is-closing"),
        };
        customMessages = limitStoredMessages([item, ...customMessages]);
        return item;
    }

    function renderMessageIdentity() {
        messagesIdentityValue.textContent = getMessageSenderName();
    }

    function openMessageSettings() {
        renderMessageIdentity();
        messagesSettingsStatus.textContent = "";
        messagesIdentity.hidden = true;
        messagesClearConfirmation.hidden = true;
        messagesSettingsLayer.hidden = false;
        messagesIdentityToggle.classList.add("is-active");
        messagesIdentityToggle.setAttribute("aria-label", "Close chat settings");
        messagesIdentityToggle.title = "Close chat settings";
        messagesIdentityToggle.setAttribute("aria-expanded", "true");
        messagesIdentityEditButton.focus();
    }

    function closeMessageSettings(restoreFocus = true) {
        if (messagesSettingsLayer.hidden) return;
        messagesSettingsLayer.hidden = true;
        messagesIdentity.hidden = true;
        messagesClearConfirmation.hidden = true;
        messagesIdentityToggle.classList.remove("is-active");
        messagesIdentityToggle.setAttribute("aria-label", "Open chat settings");
        messagesIdentityToggle.title = "Chat settings";
        messagesIdentityToggle.setAttribute("aria-expanded", "false");
        if (restoreFocus && !messagesLayer.hidden) messagesIdentityToggle.focus();
    }

    function openMessageIdentityEditor() {
        messagesSenderInput.value = getMessageSenderName();
        messagesIdentity.hidden = false;
        messagesSettingsStatus.textContent = "";
        messagesSenderInput.focus();
        messagesSenderInput.select();
    }

    function cancelMessageIdentityEdit() {
        messagesIdentity.hidden = true;
        messagesSenderInput.value = getMessageSenderName();
        messagesSettingsStatus.textContent = "";
        messagesIdentityEditButton.focus();
    }

    function openMessages(messageId = "", opener = messagesButton) {
        messagesCloseFocusTarget = opener || messagesButton;
        dismissMessageNotification(true);
        showPopup(messagesLayer);
        closeMessageSettings(false);
        renderMessageIdentity();
        messagesSenderInput.value = getMessageSenderName();
        let changed = false;
        const updatedMessages = customMessages.map((item) => {
            if (item.read) return item;
            changed = true;
            return { ...item, read: true };
        });
        const limitedMessages = limitStoredMessages(updatedMessages);
        if (limitedMessages.length !== customMessages.length) changed = true;
        customMessages = limitedMessages;
        const saved = !changed || persistCustomMessages();
        messagesStatus.textContent = saved ? "" : "Messages could not be saved locally.";
        updateMessagesUI();
        void markCustomMessagesRead(customMessages
            .filter((item) => item.direction === "incoming" && item.read)
            .map((item) => item.messageId));
        if (messageId) {
            const targetMessage = [...messagesList.querySelectorAll(".messages-entry")].find(
                (entry) => entry.dataset.messageId === messageId
            );
            if (targetMessage) {
                targetMessage.scrollIntoView({ block: "nearest" });
            }
        }
        messagesInput.focus();
    }

    function closeMessages() {
        closeMessageSettings(false);
        messagesClearConfirmation.hidden = true;
        hidePopup(messagesLayer);
        const focusTarget = messagesCloseFocusTarget && !messagesCloseFocusTarget.hidden
            ? messagesCloseFocusTarget
            : messagesButton;
        if (typeof focusTarget.focus === "function") focusTarget.focus();
    }

    async function pollCustomMessages() {
        if (messagePollInProgress || document.visibilityState === "hidden") return;
        messagePollInProgress = true;
        try {
            const token = await getClientToken();
            const now = Date.now();
            const nextAllowedAt = Number(window.localStorage.getItem(MESSAGE_POLL_COORDINATION_KEY));
            if (Number.isFinite(nextAllowedAt) && now < nextAllowedAt) return;
            window.localStorage.setItem(
                MESSAGE_POLL_COORDINATION_KEY,
                String(now + MESSAGE_POLL_MIN_INTERVAL_MS)
            );
            const response = await fetch(REPORT_MESSAGES_API_URL, {
                method: "GET",
                cache: "no-store",
                credentials: "include",
                headers: { "X-Client-Token": token },
            });
            const responseText = await response.text();
            let responseData = null;
            if (responseText) {
                try {
                    responseData = JSON.parse(responseText);
                } catch {
                    throw new Error(`The message API returned invalid JSON (HTTP ${response.status}).`);
                }
            }
            if (response.status === 429) {
                const retryAfterSeconds = getRetryAfterSeconds(response);
                const retryDelay = retryAfterSeconds === null
                    ? MESSAGE_POLL_MIN_INTERVAL_MS
                    : Math.max(MESSAGE_POLL_MIN_INTERVAL_MS, retryAfterSeconds * 1000);
                window.localStorage.setItem(
                    MESSAGE_POLL_COORDINATION_KEY,
                    String(Date.now() + retryDelay)
                );
            }
            if (!response.ok || responseData?.success !== true || !Array.isArray(responseData.messages)) {
                const message = typeof responseData?.message === "string"
                    ? responseData.message
                    : `HTTP ${response.status}`;
                throw new Error(`Could not retrieve personalized messages: ${message}`);
            }
            const newMessages = [];
            responseData.messages.forEach((item) => {
                if (!item || typeof item.message !== "string" || typeof item.messageId !== "string") {
                    console.warn("[Kour Report] The message API returned an invalid message item.");
                    return;
                }
                const received = storeCustomMessage(item.message, item.messageId, item.senderName);
                if (received) newMessages.push(received);
            });
            if (newMessages.length > 0) {
                const saved = persistCustomMessages();
                updateMessagesUI();
                if (messagesLayer.hidden || messagesLayer.classList.contains("is-closing")) {
                    newMessages.forEach(showMessageNotification);
                } else {
                    void markCustomMessagesRead(newMessages.map((item) => item.messageId));
                    messagesStatus.textContent = saved ? "" : "New messages could not be saved locally.";
                }
            }
            if (!responseData.messages.length) messagesStatus.textContent = "";
        } catch (error) {
            console.warn("[Kour Report] Personalized message polling failed:", error);
            if (!messagesLayer.hidden) {
                messagesStatus.textContent = error instanceof Error ? error.message : String(error);
            }
        } finally {
            messagePollInProgress = false;
        }
    }

    async function markCustomMessagesRead(messageIds) {
        if (!Array.isArray(messageIds) || messageIds.length === 0) return;
        const incomingIds = messageIds.filter((messageId) =>
            typeof messageId === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId)
        );
        if (!incomingIds.length) return;
        try {
            const token = await getClientToken();
            const response = await fetch(`${REPORT_MESSAGES_API_URL}/read`, {
                method: "POST",
                credentials: "include",
                headers: {
                    "Content-Type": "application/json",
                    "X-Client-Token": token,
                },
                body: JSON.stringify({ messageIds: incomingIds.slice(0, 100) }),
            });
            const responseText = await response.text();
            let responseData = null;
            if (responseText) {
                try {
                    responseData = JSON.parse(responseText);
                } catch {
                    throw new Error(`The read-receipt API returned invalid JSON (HTTP ${response.status}).`);
                }
            }
            if (!response.ok || responseData?.success !== true) {
                throw new Error(
                    typeof responseData?.message === "string"
                        ? responseData.message
                        : `HTTP ${response.status}`
                );
            }
        } catch (error) {
            console.warn("[Kour Report] Could not save message read receipts:", error);
        }
    }

    function storeOutgoingMessage(message, senderName, status = "sending", messageId = "", error = "") {
        const item = {
            message: message.trim(),
            messageId: messageId || `LOCAL-${Date.now()}-${Math.random().toString(16).slice(2, 10).toUpperCase()}`,
            senderName: senderName.trim().slice(0, 100) || "No detected",
            direction: "outgoing",
            status,
            error,
            receivedAt: Date.now(),
            read: true,
        };
        customMessages = limitStoredMessages([item, ...customMessages]);
        persistCustomMessages();
        updateMessagesUI();
        return item;
    }

    function updateOutgoingMessage(messageId, patch) {
        customMessages = customMessages.map((item) =>
            item.messageId === messageId ? { ...item, ...patch } : item
        );
        persistCustomMessages();
        const updatedMessage = customMessages.find((item) => item.messageId === (patch.messageId || messageId));
        if (!updatedMessage) return;
        const entry = [...messagesList.querySelectorAll(".messages-entry.is-outgoing")].find(
            (element) => element.dataset.messageId === messageId
        );
        if (!entry) return;
        entry.dataset.messageId = updatedMessage.messageId;
        entry.title = `Message ID: ${updatedMessage.messageId}`;
        if (Object.prototype.hasOwnProperty.call(patch, "clientToken")) {
            const tokenButton = entry.querySelector(".messages-entry-token-toggle");
            if (tokenButton) renderOutgoingMessageTokenButton(tokenButton, updatedMessage);
        }
        const idValue = entry.querySelector(".messages-entry-id");
        if (idValue) idValue.textContent = updatedMessage.messageId;
        const status = entry.querySelector(".messages-entry-status");
        if (status) renderOutgoingMessageStatus(status, updatedMessage);
        if (Object.prototype.hasOwnProperty.call(patch, "status")) renderMessages();
    }

    async function sendCustomMessage(message, senderName, token, turnstileToken = null) {
        const response = await fetch(REPORT_MESSAGES_API_URL, {
            method: "POST",
            credentials: "include",
            headers: {
                "Content-Type": "application/json",
                "X-Client-Token": token,
            },
            body: JSON.stringify({
                message,
                senderName,
                ...(turnstileToken ? { turnstileToken } : {}),
            }),
        });
        const responseText = await response.text();
        let responseData = null;
        let parseError = "";
        if (responseText) {
            try {
                responseData = JSON.parse(responseText);
            } catch (error) {
                parseError = error instanceof Error ? error.message : "Invalid JSON response.";
            }
        }
        return { status: response.status, ok: response.ok, data: responseData, rawText: responseText, parseError };
    }

    function createOutgoingMessageErrorLog(status, data, rawText, fallbackMessage, fallbackCode) {
        const code = typeof data?.code === "string"
            ? data.code.slice(0, 128)
            : fallbackCode || `HTTP_${status || "UNKNOWN"}`;
        const message = typeof data?.message === "string"
            ? data.message.slice(0, 1000)
            : typeof data?.error === "string"
                ? data.error.slice(0, 1000)
                : String(fallbackMessage || `HTTP ${status || "unknown"}`).slice(0, 1000);
        let details = "";
        if (data && typeof data === "object") {
            const extra = {};
            ["details", "errors", "captcha"].forEach((key) => {
                if (data[key] !== undefined) extra[key] = data[key];
            });
            if (Object.keys(extra).length) {
                try {
                    details = JSON.stringify(extra, null, 2).slice(0, 5000);
                } catch (error) {
                    console.warn("[Kour Report] Could not format message API error details:", error);
                }
            }
        } else if (rawText) {
            details = rawText.slice(0, 5000);
        }
        return {
            code,
            httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
            message,
            ...(details ? { details } : {}),
        };
    }

    function finishOutgoingMessageSend(messageId, errorLog = null) {
        if (errorLog) {
            updateOutgoingMessage(messageId, {
                status: "error",
                error: errorLog.message,
                errorLog,
            });
            messagesStatus.textContent = errorLog.message;
        }
        messageSendingInProgress = false;
        messagesSendButton.disabled = !messagesInput.value.trim();
        if (!messagesLayer.hidden && !messagesLayer.classList.contains("is-closing")) {
            messagesInput.focus();
        }
    }

    async function submitOutgoingMessage(messageId, message, senderName, token, turnstileToken = null) {
        let result;
        try {
            result = await sendCustomMessage(message, senderName, token, turnstileToken);
        } catch (error) {
            console.error("[Kour Report] Failed to send a message:", error);
            const errorLog = createOutgoingMessageErrorLog(
                null,
                null,
                "",
                error instanceof Error ? error.message : String(error),
                "NETWORK_ERROR"
            );
            finishOutgoingMessageSend(messageId, errorLog);
            return;
        }

        const data = result.data;
        const captchaRequired = result.status === 428 &&
            data?.code === "KOUR_REPORT_MESSAGES_API_CAPTCHA_REQUIRED";
        const rejectedCaptcha = Boolean(turnstileToken) &&
            (data?.code === "KOUR_REPORT_MESSAGES_API_INVALID_TURNSTILE_TOKEN" ||
                (result.status === 403 &&
                    data?.code !== "KOUR_REPORT_MESSAGES_API_CLIENT_BLOCKED"));
        if (captchaRequired || rejectedCaptcha) {
            if (captchaRequired) {
                messagesStatus.textContent = "Complete the security check to send this message.";
            } else {
                messagesStatus.textContent = "The security check was rejected. Please complete a fresh check.";
            }
            void openVerificationDialog(null, {
                messageId,
                message,
                senderName,
                clientToken: token,
            });
            return;
        }

        const validMessageId = typeof data?.messageId === "string" &&
            /^KMSG-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.messageId);
        if (result.status === 201 && result.ok && data?.success === true &&
            data?.code === "KOUR_REPORT_API_MESSAGE_SENT" && validMessageId) {
            updateOutgoingMessage(messageId, {
                messageId: data.messageId,
                status: "sent",
                error: "",
                errorLog: undefined,
            });
            if (messagesInput.value.trim() === message) messagesInput.value = "";
            messagesStatus.textContent = "";
            finishOutgoingMessageSend(messageId);
            return;
        }

        const fallbackMessage = result.parseError
            ? `The message API returned invalid JSON (HTTP ${result.status}).`
            : result.status === 403 && data?.code === "KOUR_REPORT_MESSAGES_API_CLIENT_BLOCKED"
                ? "This client is blocked and cannot send messages."
                : result.status === 503 &&
                    data?.code === "KOUR_REPORT_MESSAGES_API_CAPTCHA_VERIFICATION_UNAVAILABLE"
                    ? "Captcha verification is temporarily unavailable."
                    : `The message API did not accept the message (HTTP ${result.status}).`;
        const errorLog = createOutgoingMessageErrorLog(
            result.status,
            data,
            result.rawText,
            fallbackMessage,
            result.parseError ? "INVALID_API_RESPONSE" : ""
        );
        finishOutgoingMessageSend(messageId, errorLog);
    }

    function normalizeReportId(value) {
        const candidate = typeof value === "string"
            ? value.trim()
            : Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
        return candidate.length > 0 && candidate.length <= 128 ? candidate : null;
    }

    function loadReportHistory() {
        try {
            const serialized = window.localStorage.getItem(REPORT_HISTORY_STORAGE_KEY);
            if (!serialized) return [];
            const parsed = JSON.parse(serialized);
            if (!Array.isArray(parsed)) throw new TypeError("Stored report history must be an array.");
            return parsed.filter((entry) =>
                entry && typeof entry === "object" &&
                (entry.reportId === null ||
                    (typeof entry.reportId === "string" && normalizeReportId(entry.reportId) === entry.reportId)) &&
                typeof entry.target === "string" && entry.target.length <= 1000 &&
                (entry.targetRawName === undefined || (typeof entry.targetRawName === "string" && entry.targetRawName.length <= 2000)) &&
                (entry.reporterRawName === undefined || (typeof entry.reporterRawName === "string" && entry.reporterRawName.length <= 2000)) &&
                (entry.reason === undefined || typeof entry.reason === "string") &&
                (entry.reporter === undefined || (typeof entry.reporter === "string" && entry.reporter.length <= 1000)) &&
                (entry.roomId === undefined || (typeof entry.roomId === "string" && entry.roomId.length <= 1000)) &&
                (entry.sessionLink === undefined || (typeof entry.sessionLink === "string" && entry.sessionLink.length <= 1000)) &&
                (entry.endpoint === undefined ||
                    (typeof entry.endpoint === "string" && entry.endpoint.length <= 1000)) &&
                (entry.clientToken === undefined ||
                    (typeof entry.clientToken === "string" && entry.clientToken.length <= 100)) &&
                (entry.testMode === undefined || typeof entry.testMode === "boolean") &&
                (entry.kind === "KBI call" || entry.kind === "Player report") &&
                Number.isFinite(entry.submittedAt)
            ).slice(0, MAX_REPORT_HISTORY_ITEMS);
        } catch (error) {
            console.warn("[Kour Report] Could not load local report history:", error);
            return [];
        }
    }

    function openReportDetails(entry, triggerButton) {
        const target = entry.target || "Unknown player";
        const reason = typeof entry.reason === "string" ? entry.reason : "";
        const playerCountMatch = /\s*\[Players in match: ([^\]]+)\]\s*$/i.exec(reason);

        reportDetailsAvatar.src = PLAYER_AVATAR_URL;
        reportDetailsAvatar.alt = `${target} avatar`;
        reportDetailsFields.target.replaceChildren();
        appendPlayerName(reportDetailsFields.target, entry.targetRawName || "", target);
        reportDetailsState.textContent = entry.testMode
            ? "Sent to the test channel"
            : "Submitted successfully";
        reportDetailsFields.reason.textContent = playerCountMatch
            ? reason.slice(0, playerCountMatch.index).trim() || "No reason recorded"
            : reason.trim() || "No reason recorded";
        const reporter = entry.reporter || "Not recorded";
        const reporterRawName = entry.reporterRawName ||
            (normalizePlayerName(reportMatchState.localRawName) === reporter
                ? reportMatchState.localRawName
                : "");
        reportDetailsFields.reporter.replaceChildren();
        appendPlayerName(
            reportDetailsFields.reporter,
            reporterRawName,
            reporter
        );
        reportDetailsFields.submitted.textContent = new Date(entry.submittedAt).toLocaleString();
        reportDetailsFields.roomId.textContent = entry.roomId || "Not recorded";
        reportDetailsFields.sessionLink.textContent = entry.sessionLink || "Not recorded";
        reportDetailsFields.playerCount.textContent = playerCountMatch ? playerCountMatch[1] : "";
        reportDetailsFields.reportId.textContent = entry.reportId || "Not available";
        reportDetailsPlayerCountFact.hidden = !playerCountMatch;
        activeReportDetailsButton = triggerButton;
        showPopup(reportDetailsLayer);
        reportDetailsCloseButton.focus();
    }

    function closeReportDetails() {
        hidePopup(reportDetailsLayer);
        if (activeReportDetailsButton && activeReportDetailsButton.isConnected) {
            activeReportDetailsButton.focus();
        } else if (!messagesLayer.hidden && !messagesLayer.classList.contains("is-closing")) {
            messagesInput.focus();
        } else {
            reportHistoryCloseButton.focus();
        }
        activeReportDetailsButton = null;
    }

    function matchesReportHistoryDeleteScope(entry, scope) {
        return scope === "all" ||
            (scope === "test" && entry.testMode === true) ||
            (scope === "real" && entry.testMode !== true);
    }

    function getReportHistoryDeleteCount(scope) {
        return reportHistory.filter((entry) => matchesReportHistoryDeleteScope(entry, scope)).length;
    }

    function closeReportHistoryClearPanel() {
        pendingReportHistoryDeleteScope = null;
        reportHistoryClearButton.setAttribute("aria-expanded", "false");
        reportHistoryClearPanel.classList.remove("is-open");
        window.clearTimeout(reportHistoryClearPanelTimer);
        if (reportHistoryClearPanel.hidden) {
            reportHistoryClearOptions.hidden = false;
            reportHistoryClearConfirmation.hidden = true;
            return;
        }
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        reportHistoryClearPanelTimer = window.setTimeout(() => {
            if (reportHistoryClearPanel.classList.contains("is-open")) {
                reportHistoryClearPanelTimer = 0;
                return;
            }
            reportHistoryClearPanel.hidden = true;
            reportHistoryClearOptions.hidden = false;
            reportHistoryClearConfirmation.hidden = true;
            reportHistoryClearPanelTimer = 0;
        }, reducedMotion ? 0 : REPORT_HISTORY_CLEAR_PANEL_DURATION_MS);
    }

    function openReportHistoryClearPanel() {
        window.clearTimeout(reportHistoryClearPanelTimer);
        reportHistoryClearPanelTimer = 0;
        reportHistoryClearOptions.hidden = false;
        reportHistoryClearConfirmation.hidden = true;
        if (reportHistoryClearPanel.hidden) {
            reportHistoryClearPanel.hidden = false;
            void reportHistoryClearPanel.offsetHeight;
        }
        reportHistoryClearPanel.classList.add("is-open");
        reportHistoryClearButton.setAttribute("aria-expanded", "true");
    }

    function openReportHistoryClearConfirmation(scope) {
        const count = getReportHistoryDeleteCount(scope);
        if (!count) return;
        pendingReportHistoryDeleteScope = scope;
        const scopeLabel = scope === "all" ? "report" : `${scope} report`;
        reportHistoryClearConfirmationText.textContent =
            `Delete ${count} ${scopeLabel}${count === 1 ? "" : "s"}? This only removes saved entries from this browser.`;
        reportHistoryClearConfirmButton.textContent = `Delete ${count}`;
        reportHistoryClearOptions.hidden = true;
        reportHistoryClearConfirmation.hidden = false;
        reportHistoryClearConfirmButton.focus();
    }

    function deleteReportHistoryEntries() {
        const scope = pendingReportHistoryDeleteScope;
        if (!scope) return;
        const nextHistory = reportHistory.filter((entry) =>
            !matchesReportHistoryDeleteScope(entry, scope)
        );
        const deletedCount = reportHistory.length - nextHistory.length;
        if (!deletedCount) {
            closeReportHistoryClearPanel();
            return;
        }
        try {
            window.localStorage.setItem(REPORT_HISTORY_STORAGE_KEY, JSON.stringify(nextHistory));
        } catch (error) {
            console.warn("[Kour Report] Could not delete saved report history:", error);
            reportHistoryClearStatus.textContent = "Unable to update the saved report history.";
            reportHistoryClearStatus.hidden = false;
            return;
        }

        reportHistory = nextHistory;
        renderReportHistory();
        closeReportHistoryClearPanel();
        const scopeLabel = scope === "all" ? "report" : `${scope} report`;
        reportHistoryClearStatus.textContent =
            `Removed ${deletedCount} ${scopeLabel}${deletedCount === 1 ? "" : "s"} from this browser's history.`;
        reportHistoryClearStatus.hidden = false;
        (reportHistory.length ? reportHistoryClearButton : reportHistoryCloseButton).focus();
    }

    function renderReportHistory() {
        reportHistoryList.replaceChildren();
        reportHistoryCount.textContent = String(reportHistory.length);
        reportHistoryButton.setAttribute("aria-label", `Report history, ${reportHistory.length} reports`);
        const historyCounts = {
            all: reportHistory.length,
            real: reportHistory.filter((entry) => entry.testMode !== true).length,
            test: reportHistory.filter((entry) => entry.testMode === true).length,
        };
        reportHistoryTabs.forEach((button) => {
            const filter = button.dataset.reportHistoryFilter;
            button.setAttribute("aria-pressed", String(filter === reportHistoryFilter));
            button.querySelector(".report-history-tab-count").textContent = String(historyCounts[filter]);
        });
        const visibleHistory = reportHistory.filter((entry) =>
            reportHistoryFilter === "all" ||
            (reportHistoryFilter === "test" && entry.testMode === true) ||
            (reportHistoryFilter === "real" && entry.testMode !== true)
        );
        reportHistoryEmpty.hidden = visibleHistory.length > 0;
        reportHistoryList.hidden = visibleHistory.length === 0;
        reportHistoryEmpty.textContent = reportHistoryFilter === "all"
            ? "Reports confirmed by the API on this browser will appear here."
            : reportHistoryFilter === "test"
                ? "No test reports yet."
                : "No real reports yet.";
        reportHistoryStatus.textContent = "";
        reportHistoryClearButton.disabled = reportHistory.length === 0;
        const scopeLabels = { all: "All reports", test: "Test reports", real: "Real reports" };
        reportHistoryClearChoices.forEach((button) => {
            const scope = button.dataset.deleteScope;
            const count = getReportHistoryDeleteCount(scope);
            button.textContent = `${scopeLabels[scope]} (${count})`;
            button.disabled = count === 0;
        });

        visibleHistory.forEach((entry, index) => {
            const row = document.createElement("article");
            row.className = "report-history-entry";
            row.setAttribute("role", "listitem");
            let visual;
            if (entry.kind === "KBI call") {
                visual = createKbiCallActivityIcon();
            } else {
                visual = document.createElement("img");
                visual.className = "report-history-avatar";
                visual.src = PLAYER_AVATAR_URL;
                visual.alt = "";
            }
            const content = document.createElement("div");
            content.className = "report-history-entry-content";
            const target = document.createElement("strong");
            target.className = "report-history-target";
            appendPlayerName(target, entry.targetRawName || "", entry.target);
            const meta = document.createElement("span");
            meta.className = "report-history-meta";
            meta.textContent = `${entry.testMode ? "TEST CHANNEL · " : ""}${entry.kind} · ${new Date(entry.submittedAt).toLocaleString()}`;
            const heading = document.createElement("div");
            heading.className = "report-history-entry-heading";
            const headingCopy = document.createElement("div");
            headingCopy.className = "report-history-entry-heading-copy";
            headingCopy.append(target, meta);
            heading.appendChild(headingCopy);

            const idRow = document.createElement("div");
            idRow.className = "report-history-id-row";
            const idLabel = document.createElement("span");
            idLabel.className = "report-history-id-label";
            const idValue = document.createElement("code");
            if (entry.reportId) {
                idLabel.textContent = "REPORT ID";
                idValue.textContent = entry.reportId;
                const idValueGroup = document.createElement("span");
                idValueGroup.className = "report-history-id-value";
                idValueGroup.append(idLabel, idValue);
                const copyButton = document.createElement("button");
                copyButton.className = "report-id-copy report-history-action report-details-copy";
                copyButton.type = "button";
                copyButton.appendChild(createReportCopyIcon());
                copyButton.dataset.copyAriaLabel = `Copy report ID ${entry.reportId}`;
                copyButton.dataset.copyTitle = "Copy report ID";
                copyButton.setAttribute("aria-label", copyButton.dataset.copyAriaLabel);
                copyButton.title = copyButton.dataset.copyTitle;
                addButtonPressAnimation(copyButton);
                copyButton.addEventListener("click", () => {
                    void copyReportId(entry.reportId, copyButton, reportHistoryStatus);
                });
                idRow.append(idValueGroup, copyButton);
            } else {
                idLabel.textContent = "Report ID unavailable";
                idRow.appendChild(idLabel);
            }

            const tokenActions = document.createElement("div");
            tokenActions.className = "report-history-token-actions";
            const tokenButton = document.createElement("button");
            tokenButton.className = "report-history-token-toggle report-history-action";
            tokenButton.type = "button";
            const tokenDetails = document.createElement("div");
            tokenDetails.className = "report-history-token-value";
            tokenDetails.id = `report-history-token-${index}`;
            tokenDetails.hidden = true;
            tokenDetails.setAttribute("aria-hidden", "true");
            const tokenLabel = document.createElement("span");
            tokenLabel.className = "report-history-token-label";
            tokenLabel.textContent = "CLIENT TOKEN USED";
            const tokenValue = document.createElement("code");
            tokenButton.setAttribute("aria-controls", tokenDetails.id);
            if (typeof entry.clientToken === "string" && entry.clientToken.length > 0) {
                const maskedToken = "••••••••••••••••";
                let tokenRevealed = false;
                let tokenDetailsCloseTimer = null;
                tokenValue.textContent = maskedToken;
                const tokenWarning = document.createElement("p");
                tokenWarning.className = "report-history-token-warning";
                tokenWarning.textContent = "Never share this token with anyone. Store it securely.";
                const tokenControls = document.createElement("div");
                tokenControls.className = "report-history-token-controls";
                const revealButton = document.createElement("button");
                revealButton.className = "report-history-action";
                revealButton.type = "button";
                revealButton.textContent = "Reveal";
                revealButton.setAttribute("aria-pressed", "false");
                const copyTokenButton = document.createElement("button");
                copyTokenButton.className = "report-history-action";
                copyTokenButton.type = "button";
                copyTokenButton.textContent = "Copy token";
                copyTokenButton.disabled = true;
                tokenControls.append(revealButton, copyTokenButton);
                tokenDetails.append(tokenLabel, tokenValue, tokenWarning, tokenControls);
                tokenButton.textContent = "View token details";
                tokenButton.setAttribute("aria-label", `View token details for ${entry.target}`);
                tokenButton.setAttribute("aria-expanded", "false");
                tokenButton.addEventListener("click", () => {
                    const showingDetails = tokenDetails.hidden ||
                        tokenDetails.classList.contains("is-closing");
                    if (showingDetails) {
                        if (tokenDetailsCloseTimer !== null) {
                            window.clearTimeout(tokenDetailsCloseTimer);
                            tokenDetailsCloseTimer = null;
                        }
                        tokenDetails.classList.remove("is-closing");
                        tokenDetails.hidden = false;
                        tokenDetails.setAttribute("aria-hidden", "false");
                        tokenButton.textContent = "Hide token details";
                        tokenButton.setAttribute("aria-label", `Hide token details for ${entry.target}`);
                    } else {
                        tokenDetails.classList.add("is-closing");
                        tokenDetails.setAttribute("aria-hidden", "true");
                        tokenRevealed = false;
                        tokenValue.textContent = maskedToken;
                        revealButton.textContent = "Reveal";
                        revealButton.setAttribute("aria-pressed", "false");
                        copyTokenButton.textContent = "Copy token";
                        copyTokenButton.title = "";
                        copyTokenButton.disabled = true;
                        tokenButton.textContent = "View token details";
                        tokenButton.setAttribute("aria-label", `View token details for ${entry.target}`);
                        const animationDuration = window.matchMedia(
                            "(prefers-reduced-motion: reduce)"
                        ).matches ? 0 : REPORT_HISTORY_TOKEN_DETAILS_DURATION_MS;
                        tokenDetailsCloseTimer = window.setTimeout(() => {
                            tokenDetails.hidden = true;
                            tokenDetails.classList.remove("is-closing");
                            tokenDetailsCloseTimer = null;
                        }, animationDuration);
                    }
                    tokenButton.setAttribute("aria-expanded", String(showingDetails));
                });
                revealButton.addEventListener("click", () => {
                    tokenRevealed = !tokenRevealed;
                    tokenValue.textContent = tokenRevealed ? entry.clientToken : maskedToken;
                    revealButton.textContent = tokenRevealed ? "Hide" : "Reveal";
                    revealButton.setAttribute("aria-pressed", String(tokenRevealed));
                    copyTokenButton.textContent = "Copy token";
                    copyTokenButton.title = "";
                    copyTokenButton.disabled = !tokenRevealed;
                });
                copyTokenButton.addEventListener("click", async () => {
                    if (!tokenRevealed) return;
                    copyTokenButton.disabled = true;
                    try {
                        await writeTextToClipboard(entry.clientToken);
                        copyTokenButton.textContent = "Copied";
                        copyTokenButton.title = "Token copied. Never share it; store it securely.";
                        reportHistoryStatus.textContent =
                            "Client token copied. Never share it with anyone; store it securely.";
                    } catch (error) {
                        console.warn("[Kour Report] Could not copy the report client token:", error);
                        copyTokenButton.textContent = "Copy failed";
                        copyTokenButton.title = "Could not copy the client token.";
                        reportHistoryStatus.textContent =
                            "Could not copy the client token. You can select and copy it manually.";
                    } finally {
                        copyTokenButton.disabled = !tokenRevealed;
                    }
                });
                addButtonPressAnimation(revealButton);
                addButtonPressAnimation(copyTokenButton);
            } else {
                tokenButton.textContent = "Token unavailable";
                tokenButton.setAttribute("aria-label", `Token was not saved for ${entry.target}`);
                tokenButton.title = "The token used for this older report was not saved.";
                tokenButton.disabled = true;
                tokenButton.setAttribute("aria-expanded", "false");
            }
            addButtonPressAnimation(tokenButton);
            tokenActions.appendChild(tokenButton);

            const detailsButton = document.createElement("button");
            detailsButton.className = "report-history-details-toggle report-history-action";
            detailsButton.type = "button";
            detailsButton.textContent = "View details";
            detailsButton.setAttribute("aria-haspopup", "dialog");
            detailsButton.setAttribute("aria-label", `View report details for ${entry.target}`);
            detailsButton.addEventListener("click", () => {
                openReportDetails(entry, detailsButton);
            });
            addButtonPressAnimation(detailsButton);
            content.append(heading, idRow, tokenActions, tokenDetails);
            row.append(visual, content, detailsButton);
            reportHistoryList.appendChild(row);
        });
    }

    function recordReportHistory(entry) {
        reportHistory = [entry, ...reportHistory].slice(0, MAX_REPORT_HISTORY_ITEMS);
        renderReportHistory();
        try {
            window.localStorage.setItem(REPORT_HISTORY_STORAGE_KEY, JSON.stringify(reportHistory));
        } catch (error) {
            console.warn("[Kour Report] Could not save local report history:", error);
        }
    }

    function recordReportActivity(entry, activityKind) {
        const activity = {
            message: entry.kind,
            messageId: `LOCAL-REPORT-${entry.submittedAt}-${Math.random().toString(16).slice(2, 8)}`,
            direction: "activity",
            activityKind,
            target: activityKind === "kbi-call" && entry.target === "No player selected"
                ? "Current match"
                : entry.target,
            targetRawName: entry.targetRawName,
            roomId: entry.roomId,
            reason: String(entry.reason || "").slice(0, 5000),
            reporter: String(entry.reporter || "").slice(0, 1000),
            reporterRawName: typeof entry.reporterRawName === "string"
                ? entry.reporterRawName.slice(0, 2000)
                : "",
            sessionLink: String(entry.sessionLink || "").slice(0, 1000),
            reportId: entry.reportId,
            clientToken: typeof entry.clientToken === "string" ? entry.clientToken.slice(0, 100) : undefined,
            testMode: entry.testMode,
            status: "sent",
            receivedAt: entry.submittedAt,
            read: true,
        };
        customMessages = limitStoredMessages([activity, ...customMessages]);
        persistCustomMessages();
        updateMessagesUI();
    }

    async function writeTextToClipboard(text) {
        let copied = false;
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            try {
                await navigator.clipboard.writeText(text);
                copied = true;
            } catch (error) {
                console.warn("[Kour Report] Clipboard API failed; trying the compatibility copy method:", error);
            }
        }

        if (!copied) {
            if (typeof document.execCommand !== "function") throw new Error("Clipboard access is unavailable.");
            const previousFocus = shadow.activeElement;
            const temporaryInput = document.createElement("textarea");
            temporaryInput.value = text;
            temporaryInput.setAttribute("readonly", "");
            temporaryInput.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
            try {
                (document.body || document.documentElement).appendChild(temporaryInput);
                temporaryInput.select();
                copied = document.execCommand("copy");
            } finally {
                temporaryInput.remove();
                if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
            }
        }
        if (!copied) throw new Error("The browser did not copy the text.");
    }

    async function copyReportId(reportId, button, status) {
        button.disabled = true;
        button.classList.remove("is-copied", "is-copy-failed");
        try {
            await writeTextToClipboard(reportId);
            button.classList.add("is-copied");
            button.setAttribute("aria-label", "Report ID copied to clipboard");
            button.title = "Report ID copied to clipboard";
            button.dataset.copyFeedback = "success";
            status.textContent = "Report ID copied to clipboard.";
        } catch (error) {
            console.warn("[Kour Report] Could not copy report ID:", error);
            button.classList.add("is-copy-failed");
            button.setAttribute("aria-label", "Could not copy the report ID");
            button.title = "Could not copy the report ID";
            button.dataset.copyFeedback = "failure";
            status.textContent = "Could not copy the report ID. You can select and copy it manually.";
        } finally {
            button.disabled = false;
            const previousTimer = copyFeedbackTimers.get(button);
            if (previousTimer !== undefined) window.clearTimeout(previousTimer);
            const feedbackTimer = window.setTimeout(() => {
                if (copyFeedbackTimers.get(button) !== feedbackTimer) return;
                copyFeedbackTimers.delete(button);
                if (!button.isConnected || !button.dataset.copyFeedback) return;
                button.classList.remove("is-copied", "is-copy-failed");
                button.setAttribute("aria-label", button.dataset.copyAriaLabel || "Copy report ID");
                button.title = button.dataset.copyTitle || "";
                delete button.dataset.copyFeedback;
            }, 1800);
            copyFeedbackTimers.set(button, feedbackTimer);
        }
    }

    async function copyReportDetailsField(button) {
        const fieldKey = button.dataset.reportDetailCopy;
        const field = reportDetailsFields[fieldKey];
        const label = button.dataset.copyLabel || "Report detail";
        const previousTimer = copyFeedbackTimers.get(button);
        if (previousTimer !== undefined) window.clearTimeout(previousTimer);
        button.classList.remove("is-copied", "is-copy-failed");
        button.disabled = true;
        try {
            await writeTextToClipboard(field.textContent);
            button.classList.add("is-copied");
            button.dataset.copyFeedback = "success";
            button.setAttribute("aria-label", `${label} copied to clipboard`);
            button.title = `${label} copied to clipboard`;
            reportHistoryStatus.textContent = `${label} copied to clipboard.`;
        } catch (error) {
            console.warn(`[Kour Report] Could not copy ${label}:`, error);
            button.classList.add("is-copy-failed");
            button.dataset.copyFeedback = "failure";
            button.setAttribute("aria-label", `Could not copy ${label}`);
            button.title = `Could not copy ${label}`;
            reportHistoryStatus.textContent = `Could not copy ${label}. You can select and copy it manually.`;
        } finally {
            button.disabled = false;
            const feedbackTimer = window.setTimeout(() => {
                if (copyFeedbackTimers.get(button) !== feedbackTimer) return;
                copyFeedbackTimers.delete(button);
                if (!button.isConnected || !button.dataset.copyFeedback) return;
                button.classList.remove("is-copied", "is-copy-failed");
                button.setAttribute("aria-label", button.dataset.copyAriaLabel);
                button.title = button.dataset.copyTitle;
                delete button.dataset.copyFeedback;
            }, 1800);
            copyFeedbackTimers.set(button, feedbackTimer);
        }
    }

    try {
        // Restore saved values only after validating their types and supported ranges.
        const savedSettingsValue = window.localStorage.getItem(LAUNCHER_SETTINGS_STORAGE_KEY);
        const shouldMigrateSettings = savedSettingsValue === null;
        const savedSettings = JSON.parse(
            savedSettingsValue || window.localStorage.getItem(LEGACY_LAUNCHER_SETTINGS_STORAGE_KEY) || "null"
        );
        if (savedSettings && typeof savedSettings === "object") {
            launcherSettings = {
                ...DEFAULT_LAUNCHER_SETTINGS,
                moveIcon: savedSettings.moveIcon === true,
                hideIcon: savedSettings.hideIcon === true,
                hideCallIcon: savedSettings.hideCallIcon === true,
                hideBothButtons: savedSettings.hideBothButtons === true,
                hideMessageIcon: savedSettings.hideMessageIcon === true,
                testMode: savedSettings.testMode === true,
                showUpdateNotifications: typeof savedSettings.showUpdateNotifications === "boolean"
                    ? savedSettings.showUpdateNotifications
                    : DEFAULT_LAUNCHER_SETTINGS.showUpdateNotifications,
                showMessageNotifications: typeof savedSettings.showMessageNotifications === "boolean"
                    ? savedSettings.showMessageNotifications
                    : DEFAULT_LAUNCHER_SETTINGS.showMessageNotifications,
                announceRoomJoin: typeof savedSettings.announceRoomJoin === "boolean"
                    ? savedSettings.announceRoomJoin
                    : DEFAULT_LAUNCHER_SETTINGS.announceRoomJoin,
                opacity: Number.isFinite(savedSettings.opacity)
                    ? Math.min(100, Math.max(10, savedSettings.opacity))
                    : DEFAULT_LAUNCHER_SETTINGS.opacity,
                size: Number.isFinite(savedSettings.size)
                    ? Math.min(
                        140,
                        Math.max(44, [88, 79, 66, 64, 52, 44].includes(savedSettings.size)
                            ? DEFAULT_LAUNCHER_SETTINGS.size
                            : savedSettings.size)
                    )
                    : DEFAULT_LAUNCHER_SETTINGS.size,
                openKey: typeof savedSettings.openKey === "string" &&
                    savedSettings.openKey.length > 0 && savedSettings.openKey.length <= 30
                    ? savedSettings.openKey === "Alt" ? "AltLeft" : savedSettings.openKey
                    : DEFAULT_LAUNCHER_SETTINGS.openKey,
                toggleIconKey: typeof savedSettings.toggleIconKey === "string" &&
                    savedSettings.toggleIconKey.length > 0 && savedSettings.toggleIconKey.length <= 30
                    ? savedSettings.toggleIconKey
                    : DEFAULT_LAUNCHER_SETTINGS.toggleIconKey,
                left: Number.isFinite(savedSettings.left) ? savedSettings.left : null,
                top: Number.isFinite(savedSettings.top) ? savedSettings.top : null,
            };
            if (shouldMigrateSettings) {
                window.localStorage.setItem(LAUNCHER_SETTINGS_STORAGE_KEY, JSON.stringify(launcherSettings));
                window.localStorage.removeItem(LEGACY_LAUNCHER_SETTINGS_STORAGE_KEY);
            }
        }
    } catch (error) {
        console.warn("[Kour Report] Could not load launcher settings:", error);
    }

    /**
     * Save validated launcher preferences for the next page load.
     * @see LAUNCHER_SETTINGS_STORAGE_KEY
     * @see applyLauncherSettings
     */
    function persistLauncherSettings() {
        try {
            window.localStorage.setItem(
                LAUNCHER_SETTINGS_STORAGE_KEY,
                JSON.stringify(launcherSettings)
            );
        } catch (error) {
            console.warn("[Kour Report] Could not save launcher settings:", error);
        }
    }

    /**
     * Convert a KeyboardEvent.code value into a short label for the settings UI.
     * @see updateSettingsKeyLabels
     * @see matchesKey
     */
    function formatOpenKey(key) {
        if (key === "AltLeft") return "Left Alt";
        if (key === "AltRight") return "Right Alt";
        if (/^Key[A-Z]$/.test(key)) return key.slice(3);
        if (/^Digit[0-9]$/.test(key)) return key.slice(5);
        if (key === " ") return "Space";
        if (key.length === 1) return key.toUpperCase();
        return key;
    }

    /**
     * Check whether a key event matches the configured menu shortcut.
     * @see matchesKey
     * @see setOpen
     */
    function matchesOpenKey(event) {
        const openKey = launcherSettings.openKey;
        return matchesKey(event, openKey);
    }

    /**
     * Match a configured key by physical code, with key-text fallback.
     * @see matchesOpenKey
     * @see document keydown handler
     */
    function matchesKey(event, key) {
        if (key === "Alt" || key === "AltLeft" || key === "AltRight") {
            const isAltCode = event.code === "AltLeft" || event.code === "AltRight";
            return isAltCode ? key === "Alt" || event.code === key : event.key === "Alt";
        }
        return event.code === key ||
            (typeof event.key === "string" && event.key.toLowerCase() === key.toLowerCase());
    }

    /**
     * Refresh shortcut labels and the warning shown when the launcher is hidden.
     * @see formatOpenKey
     * @see positionSettingsTooltip
     */
    function updateSettingsKeyLabels() {
        const openKeyLabel = formatOpenKey(launcherSettings.openKey);
        const toggleIconKeyLabel = formatOpenKey(launcherSettings.toggleIconKey);
        settingsKeyButtons.openKey.textContent = openKeyLabel;
        settingsKeyButtons.toggleIconKey.textContent = toggleIconKeyLabel;
        setTooltipText(settingsHideIconWarning,
            `Warning: With the buttons hidden, press ${toggleIconKeyLabel} to show them again.\nPress ${openKeyLabel} to open or close the menu directly.`
        );
        if (!settingsHideIconWarning.hidden) positionSettingsTooltip();
    }

    function setTooltipText(tooltip, text) {
        tooltip.textContent = String(text).trim();
    }

    /**
     * Position a tooltip by its trigger point and keep it inside the viewport.
     * @see positionSettingsTooltip
     * @see positionTestModeTooltip
     */
    function positionTooltipAtPoint(tooltip, x, y) {
        const margin = 12;
        const offset = 14;
        const bounds = tooltip.getBoundingClientRect();
        let left = x + offset;
        let top = y + offset;
        if (left + bounds.width > window.innerWidth - margin) {
            left = x - bounds.width - offset;
        }
        if (top + bounds.height > window.innerHeight - margin) {
            top = y - bounds.height - offset;
        }
        const maxLeft = Math.max(margin, window.innerWidth - bounds.width - margin);
        const maxTop = Math.max(margin, window.innerHeight - bounds.height - margin);
        tooltip.style.left = `${Math.min(maxLeft, Math.max(margin, left))}px`;
        tooltip.style.top = `${Math.min(maxTop, Math.max(margin, top))}px`;
    }

    function positionSettingsTooltip() {
        positionTooltipAtPoint(settingsHideIconWarning, settingsTooltipCursorX, settingsTooltipCursorY);
    }

    function positionTestModeTooltip() {
        positionTooltipAtPoint(settingsTestModeTooltip, testModeTooltipCursorX, testModeTooltipCursorY);
    }

    function positionAnnouncementTooltip() {
        positionTooltipAtPoint(
            settingsAnnouncementTooltip,
            announcementTooltipCursorX,
            announcementTooltipCursorY
        );
    }

    function positionClientTokenTooltip() {
        positionTooltipAtPoint(
            settingsClientTokenTooltip,
            settingsClientTokenTooltipCursorX,
            settingsClientTokenTooltipCursorY
        );
    }

    function showTestModeTooltipAt(x, y) {
        testModeTooltipCursorX = x;
        testModeTooltipCursorY = y;
        settingsTestModeTooltip.hidden = false;
        positionTestModeTooltip();
    }

    function showAnnouncementTooltipAt(x, y) {
        announcementTooltipCursorX = x;
        announcementTooltipCursorY = y;
        settingsAnnouncementTooltip.hidden = false;
        positionAnnouncementTooltip();
    }

    function clearClientTokenFeedback() {
        window.clearTimeout(clientTokenFeedbackTimer);
        clientTokenFeedbackTimer = 0;
        settingsClientTokenCopyButton.classList.remove("is-copied");
        settingsClientTokenCopyLabel.textContent = "Copy";
        settingsClientTokenCopyButton.setAttribute("aria-label", "Copy client token");
        settingsClientTokenStatus.classList.remove("is-error");
        settingsClientTokenStatus.textContent = "";
    }

    async function renderClientToken() {
        clearClientTokenFeedback();
        const renderAttempt = ++clientTokenRenderAttempt;
        settingsClientTokenValue.textContent = "Loading…";
        settingsClientTokenToggleButton.disabled = true;
        settingsClientTokenCopyButton.disabled = true;
        try {
            const token = await getClientToken();
            if (renderAttempt !== clientTokenRenderAttempt) return;
            settingsClientTokenValue.textContent = clientTokenVisible
                ? token
                : "••••••••••••••••••••••••••••••••";
            settingsClientTokenToggleButton.disabled = false;
            settingsClientTokenCopyButton.disabled = false;
            settingsClientTokenToggleButton.textContent = clientTokenVisible ? "Hide" : "Show";
            settingsClientTokenToggleButton.setAttribute(
                "aria-label",
                `${clientTokenVisible ? "Hide" : "Show"} client token`
            );
            settingsClientTokenToggleButton.setAttribute("aria-pressed", String(clientTokenVisible));
        } catch (error) {
            if (renderAttempt !== clientTokenRenderAttempt) return;
            settingsClientTokenValue.textContent = "Unavailable";
            settingsClientTokenToggleButton.disabled = true;
            settingsClientTokenCopyButton.disabled = true;
            settingsClientTokenStatus.textContent = error instanceof Error ? error.message : String(error);
            settingsClientTokenStatus.classList.add("is-error");
            console.error("[Kour Report] Could not display the saved client token:", error);
        }
    }

    function showClientTokenTooltipAt(x, y) {
        settingsClientTokenTooltipCursorX = x;
        settingsClientTokenTooltipCursorY = y;
        settingsClientTokenTooltip.hidden = false;
        positionClientTokenTooltip();
    }

    function positionManualReportHelpTooltip() {
        const margin = 12;
        const offset = 0;
        const anchor = reportTargetHelp.getBoundingClientRect();
        const bounds = manualReportHelpTooltip.getBoundingClientRect();
        const left = Math.min(
            window.innerWidth - bounds.width - margin,
            Math.max(margin, anchor.left + anchor.width / 2 - bounds.width / 2)
        );
        const top = anchor.bottom + bounds.height + offset <= window.innerHeight - margin
            ? anchor.bottom + offset
            : Math.max(margin, anchor.top - bounds.height - offset);
        manualReportHelpTooltip.style.left = `${left}px`;
        manualReportHelpTooltip.style.top = `${top}px`;
    }

    function showManualReportHelpTooltip() {
        manualReportHelpTooltip.hidden = false;
        positionManualReportHelpTooltip();
    }

    /**
     * Show the settings warning near the pointer or focused settings row.
     * @see positionSettingsTooltip
     */
    function showSettingsTooltipAt(x, y) {
        settingsTooltipCursorX = x;
        settingsTooltipCursorY = y;
        settingsHideIconWarning.hidden = false;
        positionSettingsTooltip();
    }

    /**
     * Keep the hover quick-call directly above and right-aligned with the launcher.
     * @see applyLauncherSettings
     * @see setOpen
     */
    function updateLauncherQuickCallPosition() {
        const buttonWidth = launcherSettings.size;
        const buttonHeight = launcherSettings.size;
        let launcherLeft;
        let launcherTop;
        if (launcherSettings.left !== null && launcherSettings.top !== null) {
            launcherLeft = launcherSettings.left;
            launcherTop = launcherSettings.top;
        } else {
            launcherLeft = window.innerWidth - buttonWidth;
            launcherTop = (window.innerHeight - buttonHeight) / 2;
        }
        const callIconSize = Math.min(34, Math.round(buttonWidth * 0.38));
        const messageIconSize = Math.round(callIconSize * 0.9);
        launcherQuickCall.style.boxSizing = "border-box";
        launcherQuickCall.style.width = `${buttonWidth}px`;
        launcherQuickCall.style.minWidth = `${buttonWidth}px`;
        launcherQuickCall.style.height = `${buttonHeight}px`;
        launcherQuickCall.style.minHeight = `${buttonHeight}px`;
        launcherQuickCall.style.transformOrigin = "100% 100%";
        launcherQuickCall.style.padding = `${Math.max(3, Math.round(buttonHeight * 0.1))}px`;
        launcherQuickCall.style.gap = `${Math.max(2, Math.round(buttonHeight * 0.055))}px`;
        launcherQuickCall.style.setProperty("--launcher-call-icon-size", `${callIconSize}px`);
        launcherQuickCall.querySelector(".call-kbi-label").style.fontSize =
            `${Math.max(9, Math.round(buttonWidth * 0.17))}px`;
        launcherQuickCall.style.left = `${launcherLeft}px`;
        launcherQuickCall.style.top = `${Math.max(0, launcherTop - buttonHeight)}px`;
        launcherQuickCall.style.right = "auto";
        launcherQuickCall.style.bottom = "auto";

        launcherQuickMessages.style.boxSizing = "border-box";
        launcherQuickMessages.style.width = `${buttonWidth}px`;
        launcherQuickMessages.style.minWidth = `${buttonWidth}px`;
        launcherQuickMessages.style.height = `${buttonHeight}px`;
        launcherQuickMessages.style.minHeight = `${buttonHeight}px`;
        launcherQuickMessages.style.padding = `${Math.max(3, Math.round(buttonHeight * 0.1))}px`;
        launcherQuickMessages.style.gap = `${Math.max(2, Math.round(buttonHeight * 0.055))}px`;
        launcherQuickMessages.style.setProperty("--launcher-message-icon-size", `${messageIconSize}px`);
        launcherQuickMessages.querySelector(".launcher-message-label").style.fontSize =
            `${Math.max(9, Math.round(buttonWidth * 0.17))}px`;
        launcherQuickMessages.style.left = `${launcherLeft}px`;
        launcherQuickMessages.style.top = `${launcherTop + buttonHeight}px`;
        launcherQuickMessages.style.right = "auto";
        launcherQuickMessages.style.bottom = "auto";

        const quickActionsAvailable = !launcherShortcutActive &&
            !activeLauncherDrag &&
            !panel.classList.contains("open");
        const shouldShow = !launcherSettings.hideCallIcon &&
            !launcherSettings.hideBothButtons &&
            quickActionsAvailable;
        if (shouldShow) {
            launcherQuickCall.classList.add("is-visible");
            launcherQuickCall.setAttribute("aria-hidden", "false");
            launcherQuickCall.tabIndex = 0;
        } else {
            launcherQuickCall.classList.remove("is-visible");
            launcherQuickCall.setAttribute("aria-hidden", "true");
            launcherQuickCall.tabIndex = -1;
        }
        const shouldShowMessages = !launcherSettings.hideMessageIcon &&
            !launcherSettings.hideBothButtons &&
            quickActionsAvailable;
        if (shouldShowMessages) {
            launcherQuickMessages.classList.add("is-visible");
            launcherQuickMessages.setAttribute("aria-hidden", "false");
            launcherQuickMessages.tabIndex = 0;
        } else {
            launcherQuickMessages.classList.remove("is-visible");
            launcherQuickMessages.setAttribute("aria-hidden", "true");
            launcherQuickMessages.tabIndex = -1;
        }
        updateLauncherHoverRelationship();
    }

    function revealLauncherQuickCall() {
        updateLauncherHoverRelationship();
        updateLauncherQuickCallPosition();
    }

    function positionLauncherShortcutWheel() {
        launcherShortcutOptions.style.left = "50%";
        launcherShortcutOptions.style.top = "50%";
    }

    function updateLauncherShortcutSelection(clientX, clientY) {
        const optionElements = [
            launcherShortcutMenuOption,
            launcherShortcutCallOption,
        ];
        launcherShortcutSelection = optionElements.find((option) => {
            const bounds = option.getBoundingClientRect();
            return clientX >= bounds.left && clientX <= bounds.right &&
                clientY >= bounds.top && clientY <= bounds.bottom;
        }) || null;
        optionElements.forEach((option) => {
            const selected = option === launcherShortcutSelection;
            option.classList.toggle("is-selected", selected);
            option.setAttribute("aria-pressed", String(selected));
        });
    }

    function beginLauncherShortcutWheel() {
        if (launcherShortcutActive || !settingsLayer.hidden || capturingKeySetting) return;
        if (document.pointerLockElement) document.exitPointerLock();
        launcherShortcutActive = true;
        launcherShortcutSelection = null;
        launcher.style.visibility = "hidden";
        launcherQuickCall.classList.add("launcher-shortcut-hidden");
        launcherQuickMessages.classList.add("launcher-shortcut-hidden");
        launcherShortcutWheel.hidden = false;
        launcherShortcutWheel.setAttribute("aria-hidden", "false");
        positionLauncherShortcutWheel();
        updateLauncherQuickCallPosition();
    }

    function finishLauncherShortcutWheel(commit) {
        if (!launcherShortcutActive) return;
        const selectedAction = launcherShortcutSelection
            ? launcherShortcutSelection.dataset.shortcutAction
            : null;
        launcherShortcutActive = false;
        launcherShortcutSelection = null;
        launcherShortcutWheel.hidden = true;
        launcherShortcutWheel.setAttribute("aria-hidden", "true");
        launcher.style.visibility = "";
        launcherQuickCall.classList.remove("launcher-shortcut-hidden");
        launcherQuickMessages.classList.remove("launcher-shortcut-hidden");
        launcherShortcutMenuOption.classList.remove("is-selected");
        launcherShortcutCallOption.classList.remove("is-selected");
        launcherShortcutMenuOption.setAttribute("aria-pressed", "false");
        launcherShortcutCallOption.setAttribute("aria-pressed", "false");
        updateLauncherQuickCallPosition();
        if (!commit) return;
        if (selectedAction === "call") {
            startKbiCall(null, getCurrentReportSessionLink(), { requireDetectedRoom: true });
        } else if (selectedAction === "menu" || !selectedAction) {
            setOpen(!panel.classList.contains("open"));
        }
    }

    function updateLauncherHoverRelationship() {
        const launcherHovered = launcher.matches(":hover") || shadow.activeElement === launcher;
        const callVisible = launcherQuickCall.classList.contains("is-visible");
        const callHovered = callVisible &&
            (launcherQuickCall.matches(":hover") || shadow.activeElement === launcherQuickCall);
        const messagesVisible = launcherQuickMessages.classList.contains("is-visible");
        const messagesHovered = messagesVisible &&
            (launcherQuickMessages.matches(":hover") || shadow.activeElement === launcherQuickMessages);
        const launcherVisible = !launcherSettings.hideIcon &&
            !launcherSettings.hideBothButtons;
        const launcherExpanded = launcherVisible && launcherHovered;
        const launcherTop = launcherSettings.left !== null && launcherSettings.top !== null
            ? launcherSettings.top
            : (window.innerHeight - launcherSettings.size) / 2;
        launcherQuickMessages.style.top =
            `${launcherTop + launcherSettings.size * (launcherExpanded ? 1.12 : 1)}px`;
        launcher.style.transformOrigin = "100% 0%";
        launcherQuickCall.style.transformOrigin = "100% 100%";
        launcherQuickMessages.style.transformOrigin = "100% 0%";
        launcherQuickCall.classList.toggle("is-hovered", callHovered);
        launcherQuickCall.classList.toggle("neighbor-hover", launcherHovered && !callHovered && callVisible);
        launcherQuickMessages.classList.toggle("is-hovered", messagesHovered);
        launcher.style.borderTopColor = callHovered ? "transparent" : "#242424";
        launcher.style.borderBottomColor = messagesHovered ? "transparent" : "#242424";
        launcherReportSeam.style.opacity = callHovered ? "1" : "0";
        launcher.style.transform = callHovered
            ? "scale(1)"
            : launcherExpanded && messagesVisible ? "scale(1.12)" : "scale(1)";
    }

    function applyUpdateNotificationVisibility() {
        const shouldShowUpdate = Boolean(availableUpdateVersion) &&
            launcherSettings.showUpdateNotifications;
        updateNotice.hidden = !shouldShowUpdate;
        updateBadge.style.display = shouldShowUpdate ? "grid" : "none";
        launcher.setAttribute(
            "aria-label",
            shouldShowUpdate
                ? `Open Kour Report menu; update v${availableUpdateVersion} available`
                : "Open Kour Report menu"
        );
        launcher.title = shouldShowUpdate
            ? `Open Kour Report - update v${availableUpdateVersion} available`
            : "Open Kour Report";
    }

    /**
     * Apply saved launcher preferences to its appearance, position, and controls.
     * @see persistLauncherSettings
     * @see DEFAULT_LAUNCHER_SETTINGS
     */
    function applyLauncherSettings() {
        const size = launcherSettings.size;
        const iconSize = Math.min(34, Math.round(size * 0.38));
        launcher.style.width = `${size}px`;
        launcher.style.height = `${size}px`;
        launcher.style.gap = `${Math.max(2, Math.round(size * 0.055))}px`;
        launcher.style.padding = `${Math.max(3, Math.round(size * 0.1))}px`;
        launcher.style.opacity = String(launcherSettings.opacity / 100);
        launcher.style.display = launcherSettings.hideIcon ||
            launcherSettings.hideBothButtons
            ? "none"
            : "flex";
        launcher.style.cursor = launcherSettings.moveIcon ? "grab" : "pointer";
        launcherIcon.setAttribute("width", String(iconSize));
        launcherIcon.setAttribute("height", String(iconSize));
        launcherIcon.style.flex = `0 0 ${iconSize}px`;
        launcherLabel.style.fontSize = `${Math.max(9, Math.round(size * 0.17))}px`;
        if (launcherSettings.left !== null && launcherSettings.top !== null) {
            const maxLeft = Math.max(0, window.innerWidth - size);
            const minTop = window.innerHeight >= size * 3 ? size : 0;
            const maxTop = window.innerHeight >= size * 3
                ? window.innerHeight - size * 2
                : window.innerHeight - size;
            launcherSettings.left = Math.min(maxLeft, Math.max(0, launcherSettings.left));
            launcherSettings.top = Math.max(minTop, Math.min(maxTop, launcherSettings.top));
            launcher.style.left = `${launcherSettings.left}px`;
            launcher.style.top = `${launcherSettings.top}px`;
            launcher.style.right = "auto";
            launcher.style.bottom = "auto";
            launcher.style.translate = "none";
        } else {
            launcher.style.left = "auto";
            launcher.style.right = "0";
            launcher.style.top = "50%";
            launcher.style.bottom = "auto";
            launcher.style.translate = "0 -50%";
        }
        settingsInputs.moveIcon.checked = launcherSettings.moveIcon;
        settingsInputs.hideIcon.checked = launcherSettings.hideIcon;
        settingsInputs.hideCallIcon.checked = launcherSettings.hideCallIcon;
        settingsInputs.hideBothButtons.checked = launcherSettings.hideBothButtons;
        settingsInputs.hideMessageIcon.checked = launcherSettings.hideMessageIcon;
        settingsInputs.testMode.checked = launcherSettings.testMode;
        settingsInputs.showUpdateNotifications.checked = launcherSettings.showUpdateNotifications;
        settingsInputs.showMessageNotifications.checked = launcherSettings.showMessageNotifications;
        settingsInputs.announceRoomJoin.checked = launcherSettings.announceRoomJoin;
        settingsInputs.opacity.value = String(launcherSettings.opacity);
        settingsInputs.size.value = String(launcherSettings.size);
        shadow.querySelector('[data-value="opacity"]').textContent = `${launcherSettings.opacity}%`;
        shadow.querySelector('[data-value="size"]').textContent = `${launcherSettings.size} px`;
        updateSettingsKeyLabels();
        updateLauncherQuickCallPosition();
        applyUpdateNotificationVisibility();
    }
    applyLauncherSettings();
    if (launcherSettings.announceRoomJoin) scheduleReportRoomAnnouncement();

    /***************************************
     * Launcher Controls and Interactions
     ***************************************/
    const releaseHeldPress = () => {
        heldPressButton?.classList.remove("button-press-held");
        heldPressControl?.classList.remove("is-pressed");
        heldPressButton = null;
        heldPressControl = null;
    };
    document.addEventListener("pointerup", releaseHeldPress);
    document.addEventListener("pointercancel", releaseHeldPress);
    shadow.querySelectorAll(".close, .dialog-close").forEach((button) => {
        addButtonPressAnimation(button);
    });
    shadow.querySelectorAll(
        ".report-history-clear-open, .report-history-clear-choice, .report-history-clear-cancel, .report-history-clear-confirm"
    ).forEach((button) => {
        addButtonPressAnimation(button);
    });
    [
        discordButton,
        githubButton,
        infoButton,
        reportHistoryButton,
        messagesButton,
        settingsButton,
        updateButton,
        ...updateMethodOptions,
    ].forEach((button) => {
        addButtonPressAnimation(button);
    });
    discordButton.title = "Official Discord for KBI (Kour Bureau of Investigations)";
    discordButton.addEventListener("click", () => {
        window.open(DISCORD_URL, "_blank", "noopener,noreferrer");
    });
    githubButton.title = "Kour Report repository on GitHub";
    githubButton.addEventListener("click", () => {
        window.open(GITHUB_REPOSITORY_URL, "_blank", "noopener,noreferrer");
    });
    updateButton.addEventListener("click", () => {
        showPopup(updateMethodLayer);
        updateMethodOptions[0].focus();
    });
    updateMethodCloseButton.addEventListener("click", () => {
        hidePopup(updateMethodLayer);
        updateButton.focus();
    });
    updateMethodLayer.addEventListener("click", (event) => {
        if (event.target !== updateMethodLayer) return;
        hidePopup(updateMethodLayer);
        updateButton.focus();
    });
    updateMethodOptions.forEach((option) => {
        option.addEventListener("click", () => {
            hidePopup(updateMethodLayer);
            updateButton.focus();
        });
    });
    infoButton.addEventListener("click", () => {
        showPopup(infoDialogLayer);
        infoDialogCloseButton.focus();
    });
    addButtonPressAnimation(shadow.querySelector(".info-dialog-discord"));
    addButtonPressAnimation(shadow.querySelector(".info-dialog-github"));
    infoDialogCloseButton.addEventListener("click", () => {
        hidePopup(infoDialogLayer);
        infoButton.focus();
    });
    infoDialogLayer.addEventListener("click", (event) => {
        if (event.target === infoDialogLayer) {
            hidePopup(infoDialogLayer);
            infoButton.focus();
        }
    });

    /**
     * Apply the shared pressed state to mouse and keyboard interactions.
     * @param {HTMLElement} button Interactive control receiving the events.
     * @param {HTMLElement} [pressTarget=button] Element receiving the visual scale effect.
     * @see releaseHeldPress
     */
    function addButtonPressAnimation(button, pressTarget = button) {
        button.classList.add("button-pressable");
        const press = () => {
            releaseHeldPress();
            heldPressButton = pressTarget;
            heldPressControl = button;
            button.classList.add("is-pressed");
            pressTarget.classList.add("button-press-held");
        };
        const release = () => {
            if (heldPressButton === pressTarget) releaseHeldPress();
        };
        button.addEventListener("pointerdown", press);
        button.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") press();
        });
        button.addEventListener("keyup", (event) => {
            if (event.key === "Enter" || event.key === " ") release();
        });
        button.addEventListener("pointerleave", release);
        button.addEventListener("blur", release);
    }

    function createReportCopyIcon() {
        const svgNamespace = "http://www.w3.org/2000/svg";
        const iconStack = document.createElement("span");
        iconStack.className = "report-copy-icon-stack";
        iconStack.setAttribute("aria-hidden", "true");
        const createIcon = (className, draw) => {
            const svg = document.createElementNS(svgNamespace, "svg");
            svg.setAttribute("viewBox", "0 0 24 24");
            svg.setAttribute("focusable", "false");
            svg.classList.add(className);
            draw(svg);
            iconStack.appendChild(svg);
        };
        createIcon("report-copy-icon-copy", (svg) => {
            const backPage = document.createElementNS(svgNamespace, "rect");
            backPage.setAttribute("x", "8");
            backPage.setAttribute("y", "3.5");
            backPage.setAttribute("width", "12");
            backPage.setAttribute("height", "15");
            backPage.setAttribute("rx", "2.5");
            backPage.classList.add("report-copy-back");
            svg.appendChild(backPage);
            const frontPage = document.createElementNS(svgNamespace, "path");
            frontPage.setAttribute("d", "M6.5 6.5h7l3 3v10a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 5.5 19.5V8a1.5 1.5 0 0 1 1-1.5Z");
            svg.appendChild(frontPage);
            const fold = document.createElementNS(svgNamespace, "path");
            fold.setAttribute("d", "M13.5 6.5v3h3");
            fold.classList.add("report-copy-line");
            svg.appendChild(fold);
        });
        createIcon("report-copy-icon-success", (svg) => {
            const check = document.createElementNS(svgNamespace, "path");
            check.setAttribute("d", "m5.5 12.5 4.1 4.1 9-9");
            svg.appendChild(check);
        });
        createIcon("report-copy-icon-failure", (svg) => {
            const cross = document.createElementNS(svgNamespace, "path");
            cross.setAttribute("d", "m7 7 10 10M17 7 7 17");
            svg.appendChild(cross);
        });
        return iconStack;
    }

    const reportDetailsCopyLabels = {
        target: "Reported player",
        reason: "Report reason",
        reporter: "Reporter",
        submitted: "Submission time",
        roomId: "Room ID",
        sessionLink: "Room link",
        playerCount: "Players in room",
        reportId: "Report number",
    };
    Object.entries(reportDetailsFields).forEach(([fieldKey, field]) => {
        const label = reportDetailsCopyLabels[fieldKey];
        const button = document.createElement("button");
        button.className = "report-details-copy report-history-action";
        button.type = "button";
        button.dataset.reportDetailCopy = fieldKey;
        button.dataset.copyLabel = label;
        button.dataset.copyAriaLabel = `Copy ${label}`;
        button.dataset.copyTitle = `Copy ${label}`;
        button.setAttribute("aria-label", button.dataset.copyAriaLabel);
        button.title = button.dataset.copyTitle;
        button.appendChild(createReportCopyIcon());
        field.parentElement.appendChild(button);
        addButtonPressAnimation(button);
        button.addEventListener("click", () => {
            void copyReportDetailsField(button);
        });
    });

    // Keep the paired launcher buttons synchronized for hover and keyboard focus.
    launcher.addEventListener("pointerenter", revealLauncherQuickCall);
    launcher.addEventListener("focus", revealLauncherQuickCall);
    launcher.addEventListener("blur", revealLauncherQuickCall);
    launcherQuickCall.addEventListener("pointerenter", revealLauncherQuickCall);
    launcherQuickCall.addEventListener("pointerleave", revealLauncherQuickCall);
    launcherQuickCall.addEventListener("focus", revealLauncherQuickCall);
    launcherQuickCall.addEventListener("blur", revealLauncherQuickCall);
    launcherQuickCall.addEventListener("click", () =>
        startKbiCall(null, getCurrentReportSessionLink(), { requireDetectedRoom: true })
    );
    addButtonPressAnimation(launcherQuickCall);
    launcherQuickMessages.addEventListener("pointerenter", updateLauncherHoverRelationship);
    launcherQuickMessages.addEventListener("pointerleave", updateLauncherHoverRelationship);
    launcherQuickMessages.addEventListener("focus", updateLauncherHoverRelationship);
    launcherQuickMessages.addEventListener("blur", updateLauncherHoverRelationship);
    launcherQuickMessages.addEventListener("click", () => openMessages("", launcherQuickMessages));
    addButtonPressAnimation(launcherQuickMessages);

    /**
     * Stop key capture, hide the settings dialog, and return focus to its opener.
     * @see settingsButton
     * @see document keydown handler
     */
    function closeSettingsDialog() {
        capturingKeySetting = null;
        settingsKeyHint.hidden = true;
        updateSettingsKeyLabels();
        settingsHideIconWarning.hidden = true;
        settingsTestModeTooltip.hidden = true;
        settingsAnnouncementTooltip.hidden = true;
        settingsClientTokenTooltip.hidden = true;
        clientTokenVisible = false;
        renderClientToken();
        hidePopup(settingsLayer);
        settingsButton.focus();
    }

    // Settings handlers manage the dialog, hide-icon warning, and shortcut capture.
    settingsButton.addEventListener("click", () => {
        clientTokenVisible = false;
        renderClientToken();
        showPopup(settingsLayer);
        settingsCloseButton.focus();
    });
    settingsHideIconRow.addEventListener("pointerenter", (event) => {
        showSettingsTooltipAt(event.clientX, event.clientY);
    });
    settingsHideIconRow.addEventListener("pointermove", (event) => {
        if (!settingsHideIconWarning.hidden) {
            showSettingsTooltipAt(event.clientX, event.clientY);
        }
    });
    settingsHideIconRow.addEventListener("pointerleave", () => {
        settingsHideIconWarning.hidden = true;
    });
    settingsHideIconRow.addEventListener("focusin", () => {
        const bounds = settingsHideIconRow.getBoundingClientRect();
        showSettingsTooltipAt(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    });
    settingsHideIconRow.addEventListener("focusout", (event) => {
        if (!settingsHideIconRow.contains(event.relatedTarget)) {
            settingsHideIconWarning.hidden = true;
        }
    });
    settingsTestModeRow.addEventListener("pointerenter", (event) => {
        showTestModeTooltipAt(event.clientX, event.clientY);
    });
    settingsTestModeRow.addEventListener("pointermove", (event) => {
        if (!settingsTestModeTooltip.hidden) {
            showTestModeTooltipAt(event.clientX, event.clientY);
        }
    });
    settingsTestModeRow.addEventListener("pointerleave", () => {
        settingsTestModeTooltip.hidden = true;
    });
    settingsTestModeRow.addEventListener("focusin", () => {
        const bounds = settingsTestModeRow.getBoundingClientRect();
        showTestModeTooltipAt(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    });
    settingsTestModeRow.addEventListener("focusout", (event) => {
        if (!settingsTestModeRow.contains(event.relatedTarget)) {
            settingsTestModeTooltip.hidden = true;
        }
    });
    settingsAnnouncementRow.addEventListener("pointerenter", (event) => {
        showAnnouncementTooltipAt(event.clientX, event.clientY);
    });
    settingsAnnouncementRow.addEventListener("pointermove", (event) => {
        if (!settingsAnnouncementTooltip.hidden) {
            showAnnouncementTooltipAt(event.clientX, event.clientY);
        }
    });
    settingsAnnouncementRow.addEventListener("pointerleave", () => {
        settingsAnnouncementTooltip.hidden = true;
    });
    settingsAnnouncementRow.addEventListener("focusin", () => {
        const bounds = settingsAnnouncementRow.getBoundingClientRect();
        showAnnouncementTooltipAt(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    });
    settingsAnnouncementRow.addEventListener("focusout", (event) => {
        if (!settingsAnnouncementRow.contains(event.relatedTarget)) {
            settingsAnnouncementTooltip.hidden = true;
        }
    });
    settingsClientTokenRow.addEventListener("pointerenter", (event) => {
        showClientTokenTooltipAt(event.clientX, event.clientY);
    });
    settingsClientTokenRow.addEventListener("pointermove", (event) => {
        if (!settingsClientTokenTooltip.hidden) {
            showClientTokenTooltipAt(event.clientX, event.clientY);
        }
    });
    settingsClientTokenRow.addEventListener("pointerleave", () => {
        settingsClientTokenTooltip.hidden = true;
    });
    settingsClientTokenRow.addEventListener("focusin", () => {
        const bounds = settingsClientTokenRow.getBoundingClientRect();
        showClientTokenTooltipAt(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    });
    settingsClientTokenRow.addEventListener("focusout", (event) => {
        if (!settingsClientTokenRow.contains(event.relatedTarget)) {
            settingsClientTokenTooltip.hidden = true;
        }
    });
    settingsClientTokenToggleButton.addEventListener("click", () => {
        clientTokenVisible = !clientTokenVisible;
        renderClientToken();
    });
    settingsClientTokenCopyButton.addEventListener("click", async () => {
        clearClientTokenFeedback();
        settingsClientTokenCopyButton.disabled = true;
        try {
            await writeTextToClipboard(await getClientToken());
            settingsClientTokenCopyButton.classList.add("is-copied");
            settingsClientTokenCopyLabel.textContent = "Copied";
            settingsClientTokenCopyButton.setAttribute("aria-label", "Client token copied to clipboard");
            clientTokenFeedbackTimer = window.setTimeout(clearClientTokenFeedback, 2200);
        } catch (error) {
            console.error("[Kour Report] Could not copy the client token:", error);
            settingsClientTokenStatus.textContent = "Could not copy the client token. Check browser clipboard permissions.";
            settingsClientTokenStatus.classList.add("is-error");
            clientTokenFeedbackTimer = window.setTimeout(clearClientTokenFeedback, 4000);
        } finally {
            settingsClientTokenCopyButton.disabled = false;
        }
    });
    settingsCloseButton.addEventListener("click", closeSettingsDialog);
    settingsLayer.addEventListener("click", (event) => {
        if (event.target === settingsLayer) closeSettingsDialog();
    });
    [
        ...Object.values(settingsKeyButtons),
        settingsResetButton,
        roomAnnouncementSendButton,
        settingsClientTokenToggleButton,
        settingsClientTokenCopyButton,
    ].forEach((button) => {
        addButtonPressAnimation(button);
    });
    [
        settingsInputs.moveIcon,
        settingsInputs.hideIcon,
        settingsInputs.hideCallIcon,
        settingsInputs.hideBothButtons,
        settingsInputs.hideMessageIcon,
        settingsInputs.testMode,
        settingsInputs.showUpdateNotifications,
        settingsInputs.showMessageNotifications,
        settingsInputs.announceRoomJoin,
    ].forEach((checkbox) => {
        addButtonPressAnimation(checkbox);
    });
    const settingsRanges = [settingsInputs.opacity, settingsInputs.size];
    const releaseRangePress = () => {
        settingsRanges.forEach((range) => range.classList.remove("is-pressed"));
    };
    settingsRanges.forEach((range) => {
        range.addEventListener("pointerdown", () => range.classList.add("is-pressed"));
        range.addEventListener("keydown", (event) => {
            if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
                range.classList.add("is-pressed");
            }
        });
        range.addEventListener("keyup", releaseRangePress);
        range.addEventListener("blur", releaseRangePress);
    });
    document.addEventListener("pointerup", releaseRangePress);
    document.addEventListener("pointercancel", releaseRangePress);
    // Apply each setting immediately, then save it for the next page load.
    settingsInputs.moveIcon.addEventListener("change", () => {
        launcherSettings.moveIcon = settingsInputs.moveIcon.checked;
        applyLauncherSettings();
        persistLauncherSettings();
    });
    settingsInputs.hideIcon.addEventListener("change", () => {
        launcherSettings.hideIcon = settingsInputs.hideIcon.checked;
        applyLauncherSettings();
        persistLauncherSettings();
    });
    settingsInputs.hideCallIcon.addEventListener("change", () => {
        launcherSettings.hideCallIcon = settingsInputs.hideCallIcon.checked;
        applyLauncherSettings();
        persistLauncherSettings();
    });
    settingsInputs.hideBothButtons.addEventListener("change", () => {
        launcherSettings.hideBothButtons = settingsInputs.hideBothButtons.checked;
        applyLauncherSettings();
        persistLauncherSettings();
    });
    settingsInputs.hideMessageIcon.addEventListener("change", () => {
        launcherSettings.hideMessageIcon = settingsInputs.hideMessageIcon.checked;
        applyLauncherSettings();
        persistLauncherSettings();
    });
    settingsInputs.testMode.addEventListener("change", () => {
        launcherSettings.testMode = settingsInputs.testMode.checked;
        applyLauncherSettings();
        persistLauncherSettings();
    });
    settingsInputs.showUpdateNotifications.addEventListener("change", () => {
        launcherSettings.showUpdateNotifications = settingsInputs.showUpdateNotifications.checked;
        applyLauncherSettings();
        persistLauncherSettings();
    });
    settingsInputs.showMessageNotifications.addEventListener("change", () => {
        launcherSettings.showMessageNotifications = settingsInputs.showMessageNotifications.checked;
        if (!launcherSettings.showMessageNotifications) dismissMessageNotification(true);
        applyLauncherSettings();
        persistLauncherSettings();
    });
    settingsInputs.announceRoomJoin.addEventListener("change", () => {
        launcherSettings.announceRoomJoin = settingsInputs.announceRoomJoin.checked;
        if (launcherSettings.announceRoomJoin) {
            scheduleReportRoomAnnouncement();
        } else {
            cancelScheduledReportRoomAnnouncement();
        }
        persistLauncherSettings();
    });
    roomAnnouncementSendButton.addEventListener("click", () => {
        const sent = sendReportChatAnnouncement(REPORT_ROOM_ANNOUNCEMENT);
        if (sent) {
            cancelScheduledReportRoomAnnouncement();
            reportRoomAnnouncementAttempted = true;
        }
        roomAnnouncementSendStatus.textContent = sent
            ? "Announcement sent to the current room chat."
            : "Could not send. Join an active room first.";
        roomAnnouncementSendStatus.classList.toggle("is-error", !sent);
        roomAnnouncementSendStatus.hidden = false;
    });
    settingsInputs.opacity.addEventListener("input", () => {
        launcherSettings.opacity = Number(settingsInputs.opacity.value);
        applyLauncherSettings();
        persistLauncherSettings();
    });
    settingsInputs.size.addEventListener("input", () => {
        launcherSettings.size = Number(settingsInputs.size.value);
        applyLauncherSettings();
        persistLauncherSettings();
    });
    // Capture one shortcut at a time; Escape cancels without changing the saved key.
    Object.entries(settingsKeyButtons).forEach(([setting, button]) => {
        button.addEventListener("click", () => {
            capturingKeySetting = setting;
            settingsKeyHint.textContent = `Press the key you want to use for ${setting === "openKey" ? "opening the menu" : "showing/hiding the icon"}. Press Escape to cancel.`;
            settingsKeyHint.hidden = false;
            button.textContent = "Press a key…";
        });
    });
    // Reset through the same apply-and-save path used by individual controls.
    settingsResetButton.addEventListener("click", () => {
        launcherSettings = { ...DEFAULT_LAUNCHER_SETTINGS };
        cancelScheduledReportRoomAnnouncement();
        applyLauncherSettings();
        persistLauncherSettings();
        settingsKeyHint.hidden = true;
        capturingKeySetting = null;
    });

    /***************************************
     * Report Form and Verification
     ***************************************/
     // Report and verification controls share the same pointer/keyboard press effect.
     const cancelReportButton = shadow.querySelector(".cancel-report");
     addButtonPressAnimation(cancelReportButton);
     addButtonPressAnimation(reportSubmitButton);
    addButtonPressAnimation(manualReportButton);
    addButtonPressAnimation(menuCallKbiButton);
    addButtonPressAnimation(menuCallLinkCancelButton);
    addButtonPressAnimation(menuCallLinkSubmitButton);
    addButtonPressAnimation(menuCallWarningChooseButton);
    addButtonPressAnimation(menuCallWarningContinueButton);
    addButtonPressAnimation(verificationCancelButton);
    addButtonPressAnimation(messagesSendButton);
    addButtonPressAnimation(messagesIdentityToggle);
    addButtonPressAnimation(messagesSettingsCloseButton);
    addButtonPressAnimation(messagesSettingsDoneButton);
    addButtonPressAnimation(messagesIdentityEditButton);
    addButtonPressAnimation(messagesIdentityCancelButton);
    addButtonPressAnimation(messagesIdentitySaveButton);
    addButtonPressAnimation(messagesClearButton);
    addButtonPressAnimation(messagesCloseButton);
    addButtonPressAnimation(messagesClearCancel);
    addButtonPressAnimation(messagesClearConfirm);
    addButtonPressAnimation(reportReason, shadow.querySelector(".reason-control"));
    reportReasonButtons.forEach((option) => addButtonPressAnimation(option));

    /**
     * Keep the reason dropdown below its trigger and above the form actions.
     * @param {boolean} open Whether the reason choices should be visible.
     * @see reportReason
     * @see closeReportDialog
     */
    function setReasonMenuOpen(open) {
        reportReasonOptions.hidden = !open;
        reportReason.setAttribute("aria-expanded", String(open));
        if (open) {
            const triggerBounds = reportReason.getBoundingClientRect();
            const actionsTop = reportForm.querySelector(".report-dialog-actions").getBoundingClientRect().top;
            const availableHeight = Math.max(0, Math.min(220, actionsTop - triggerBounds.bottom - 8));
            reportReasonOptions.style.maxHeight = `${availableHeight}px`;
        } else {
            reportReasonOptions.style.maxHeight = "";
        }
    }

    /**
     * Close and reset the report form unless a report request is still being sent.
     * @see openReportDialog
     * @see resetReportCaptcha
     */
    function closeReportDialog() {
        if (reportSubmitting) return;
        resetReportCaptcha();
        reportTextFieldFocused = false;
        manualReportHelpTooltip.hidden = true;
        hidePopup(reportDialogLayer);
        setReasonMenuOpen(false);
        reportForm.reset();
        reportFormStatus.hidden = true;
        reportFormStatus.removeAttribute("data-kind");
        selectedReportReason = "";
        reportedPlayerKey = null;
        manualReport = false;
    }

    /**
     * Display a status message in the report form.
     * @see renderStatusMessage
     * @see sendReport
     */
    function setReportFormStatus(message, kind = "error", prefixText) {
        renderStatusMessage(reportFormStatus, message, kind, prefixText);
        reportFormStatus.dataset.kind = kind;
        reportFormStatus.hidden = false;
    }

    function setReportSuccessStatus(reportLabel, reportId) {
        renderStatusMessage(reportFormStatus, `${reportLabel} sent successfully.`, "success");
        reportFormStatus.dataset.kind = "success";
        const lineBreak = document.createElement("br");
        const reportIdLine = document.createElement("span");
        reportIdLine.className = "report-success-report-id";
        const reportIdLabel = document.createElement("span");
        reportIdLabel.textContent = "Report ID:";
        const reportIdValue = document.createElement("code");
        reportIdValue.textContent = reportId;
        const copyButton = document.createElement("button");
        copyButton.className = "report-success-copy report-details-copy report-history-action";
        copyButton.type = "button";
        copyButton.dataset.copyAriaLabel = `Copy report ID ${reportId}`;
        copyButton.dataset.copyTitle = "Copy report ID";
        copyButton.setAttribute("aria-label", copyButton.dataset.copyAriaLabel);
        copyButton.title = copyButton.dataset.copyTitle;
        copyButton.appendChild(createReportCopyIcon());
        const copyStatus = document.createElement("span");
        copyStatus.className = "report-history-status";
        copyStatus.setAttribute("role", "status");
        copyStatus.setAttribute("aria-live", "polite");
        reportIdLine.append(reportIdLabel, reportIdValue, copyButton, copyStatus);
        reportFormStatus.append(lineBreak, reportIdLine);
        reportFormStatus.hidden = false;
        addButtonPressAnimation(copyButton);
        copyButton.addEventListener("click", () => {
            void copyReportId(reportId, copyButton, copyStatus);
        });
    }

    function getDetectedRoomPlayerCount() {
        return reportMatchState.active && reportMatchState.localId !== null
            ? reportMatchState.players.size + 1
            : null;
    }

    function positionRoomFullReportTooltip(button) {
        const margin = 12;
        const offset = 8;
        const buttonBounds = button.getBoundingClientRect();
        const bounds = roomFullReportTooltip.getBoundingClientRect();
        const left = buttonBounds.left + (buttonBounds.width - bounds.width) / 2;
        const top = buttonBounds.top - bounds.height - offset;
        roomFullReportTooltip.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - bounds.width - margin))}px`;
        roomFullReportTooltip.style.top = `${Math.max(margin, top)}px`;
    }

    function getReportActionButton(target) {
        if (!(target instanceof Element)) return null;
        if (target.closest(".manual-report-button, .menu-call-kbi")) return null;
        const button = target.closest(
            ".player-action.call-kbi, .player-action.report, .report-form button[type='submit']"
        );
        return button === reportSubmitButton && manualReport ? null : button;
    }

    function showRoomFullReportTooltip(button) {
        if (!button || button.disabled || (getDetectedRoomPlayerCount() || 0) < 6) {
            roomFullReportTooltip.hidden = true;
            return;
        }
        roomFullReportTooltip.hidden = false;
        positionRoomFullReportTooltip(button);
    }

    shadow.addEventListener("pointerover", (event) => {
        const button = getReportActionButton(event.target);
        if (!button) return;
        showRoomFullReportTooltip(button);
    });
    shadow.addEventListener("pointerout", (event) => {
        const button = getReportActionButton(event.target);
        if (!button || (event.relatedTarget instanceof Node && button.contains(event.relatedTarget))) return;
        roomFullReportTooltip.hidden = true;
    });
    shadow.addEventListener("focusin", (event) => {
        const button = getReportActionButton(event.target);
        if (!button) return;
        showRoomFullReportTooltip(button);
    });
    shadow.addEventListener("focusout", (event) => {
        const button = getReportActionButton(event.target);
        if (!button || (event.relatedTarget instanceof Node && button.contains(event.relatedTarget))) return;
        roomFullReportTooltip.hidden = true;
    });

    function showReportReminderOnce(payload, callPlayerKey, reminderType) {
        const isRoomCall = callPlayerKey === MENU_CALL_PLAYER_KEY;
        if (isRoomCall || reminderType === "manual-report") return;
        const reminderKey = String(payload.roomId || "").trim();
        if (shownReportReminderKeys.has(reminderKey)) return;
        shownReportReminderKeys.add(reminderKey);

        reportReminderToast.hidden = false;
        window.clearTimeout(reportReminderTimer);
        reportReminderProgress.classList.remove("is-running");
        void reportReminderProgress.offsetWidth;
        reportReminderProgress.classList.add("is-running");
        reportReminderTimer = window.setTimeout(() => {
            hideReportReminder();
        }, REPORT_REMINDER_DURATION_MS);
    }

    function hideReportReminder() {
        window.clearTimeout(reportReminderTimer);
        reportReminderToast.hidden = true;
        reportReminderProgress.classList.remove("is-running");
        reportReminderTimer = 0;
    }

    reportReminderCloseButton.addEventListener("click", hideReportReminder);

    /**
     * Animate label changes without replacing the button's accessible name container.
     * @see applyCallKbiButtonState
     */
    function updateCallKbiLabel(label, text) {
        if (label.textContent === text) return;
        label.textContent = text;
        label.classList.remove("is-changing");
        void label.offsetWidth;
        label.classList.add("is-changing");
    }

    /**
     * Render one KBI button from its idle, loading, success, error, or cooldown state.
     * @param {HTMLButtonElement} button Player-row or room-level KBI button.
     * @param {object|null} state Current state from callKbiButtonStates.
     * @see setCallKbiButtonState
     */
    function applyCallKbiButtonState(button, state) {
        const status = state ? state.status : "idle";
        const icon = button.querySelector(".call-kbi-icon");
        const label = button.querySelector(".call-kbi-label");
        const setClass = (className, enabled) => {
            if (enabled) button.classList.add(className);
            else button.classList.remove(className);
        };
        setClass("is-loading", status === "loading");
        setClass("is-success", status === "success");
        setClass("is-error", status === "error");
        setClass("is-cooldown", status === "cooldown");
        button.disabled = status === "loading" || status === "cooldown";
        if (status === "loading") {
            icon.textContent = "";
            updateCallKbiLabel(label, "Calling…");
            button.title = "Complete the security check to send the call.";
            button.setAttribute("aria-label", `Calling KBI about ${button.dataset.playerName}`);
        } else if (status === "cooldown") {
            const secondsRemaining = Math.max(0, Math.ceil((state.cooldownUntil - Date.now()) / 1000));
            const countdown = formatCallKbiCooldown(secondsRemaining);
            icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 9v4l3 2M9 2h6M12 2v3M19 6l1.5-1.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            updateCallKbiLabel(label, countdown);
            button.title = `KBI call cooldown: ${countdown} remaining.`;
            button.setAttribute("aria-label", `KBI call cooldown: ${countdown} remaining for ${button.dataset.playerName}`);
        } else if (status === "success") {
            icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="m8 12 2.5 2.5L16.5 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            updateCallKbiLabel(label, "Sent");
            button.title = state.message;
            button.setAttribute("aria-label", `KBI call sent for ${button.dataset.playerName}`);
        } else if (status === "error") {
            icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="m9 9 6 6m0-6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
            updateCallKbiLabel(label, "Error");
            button.title = state.message;
            button.setAttribute("aria-label", `KBI call failed for ${button.dataset.playerName}: ${state.message}`);
        } else {
            const isMenuButton = button.dataset.callPlayerKey === MENU_CALL_PLAYER_KEY &&
                !button.classList.contains("launcher-call-kbi");
            icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.2 3.8 10 3l2 4.8-2.1 1.6a15 15 0 0 0 4.7 4.7l1.6-2.1 4.8 2-.8 2.8a3 3 0 0 1-3.3 2.1A17.5 17.5 0 0 1 5.1 7.1a3 3 0 0 1 2.1-3.3Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            updateCallKbiLabel(label, isMenuButton ? "Call Room" : "Call KBI");
            button.title = isMenuButton
                ? "Send a call to KBI for this room."
                : `Send a call to KBI about ${button.dataset.playerName}`;
            button.setAttribute("aria-label", isMenuButton
                ? "Call KBI for this room"
                : `Call KBI about ${button.dataset.playerName}`);
        }
    }

    /**
     * Format the server-provided retry delay for the button label.
     * @param {number} totalSeconds Remaining cooldown in seconds.
     * @returns {string} Compact countdown, such as "42s" or "1:05".
     * @see setCallKbiButtonState
     */
    function formatCallKbiCooldown(totalSeconds) {
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return minutes > 0
            ? `${minutes}:${seconds < 10 ? `0${seconds}` : seconds}`
            : `${seconds}s`;
    }

    /**
     * Store and fan out a KBI result to matching buttons, including newly rendered rows.
     * Success/error states expire automatically; cooldown ticks until the button returns idle.
     * @param {string} playerKey Player key or MENU_CALL_PLAYER_KEY.
     * @param {"idle"|"loading"|"success"|"error"|"cooldown"} status UI state to render.
     * @param {string} [message] Accessible detail shown for success or error.
     * @param {number} [cooldownSeconds=0] Server-provided retry delay.
     * @see applyCallKbiButtonState
     * @see sendReport
     */
    function setCallKbiButtonState(
        playerKey,
        status,
        message = "",
        cooldownSeconds = 0,
        errorDurationMs = 5000
    ) {
        const key = String(playerKey);
        const existingTimer = callKbiButtonTimers.get(key);
        if (existingTimer) {
            clearTimeout(existingTimer);
            callKbiButtonTimers.delete(key);
        }
        const state = status === "idle" ? null : {
            status,
            message,
            ...(status === "cooldown"
                ? { cooldownUntil: Date.now() + cooldownSeconds * 1000 }
                : {}),
        };
        if (state) callKbiButtonStates.set(key, state);
        else callKbiButtonStates.delete(key);
        shadow.querySelectorAll(".call-kbi").forEach((button) => {
            if (button.dataset.callPlayerKey === key) applyCallKbiButtonState(button, state);
        });
        if (status === "cooldown") {
            const updateCooldown = () => {
                if (callKbiButtonStates.get(key) !== state) return;
                const secondsRemaining = Math.ceil((state.cooldownUntil - Date.now()) / 1000);
                if (secondsRemaining <= 0) {
                    setCallKbiButtonState(key, "idle");
                    return;
                }
                shadow.querySelectorAll(".call-kbi").forEach((button) => {
                    if (button.dataset.callPlayerKey === key) applyCallKbiButtonState(button, state);
                });
                callKbiButtonTimers.set(key, window.setTimeout(updateCooldown, Math.min(1000, state.cooldownUntil - Date.now())));
            };
            callKbiButtonTimers.set(key, window.setTimeout(updateCooldown, Math.min(1000, cooldownSeconds * 1000)));
        } else if (status === "success" || status === "error") {
            const timer = window.setTimeout(() => {
                if (callKbiButtonStates.get(key) !== state) return;
                callKbiButtonStates.delete(key);
                callKbiButtonTimers.delete(key);
                shadow.querySelectorAll(".call-kbi").forEach((button) => {
                    if (button.dataset.callPlayerKey === key) applyCallKbiButtonState(button, null);
                });
            }, status === "success" ? 2600 : errorDurationMs);
            callKbiButtonTimers.set(key, timer);
        }
    }

    /**
     * Prepare the shared report API payload for a player call or a room-level call.
     * If no valid current room URL exists, preserve the player selection and request one.
     * @param {object|null} player Selected roster player, or null for a room-level call.
     * @param {string} [roomLink] Current match URL or a manually supplied room URL.
     * @param {{requireDetectedRoom?: boolean}} [options] Whether a missing room should notify in-game instead of opening the link dialog.
     * @see openMenuCallLinkDialog
     * @see openVerificationDialog
     * @see sendReport
     */
    function startKbiCall(player, roomLink = getCurrentReportSessionLink(), options = {}) {
        const key = player ? String(player.key) : MENU_CALL_PLAYER_KEY;
        if (captchaInProgress || reportSubmitting || messageSendingInProgress ||
            ["loading", "cooldown"].indexOf(
                callKbiButtonStates.get(key) && callKbiButtonStates.get(key).status
            ) !== -1) return;
        if (player && (!reportMatchState.active ||
            ![...reportMatchState.players.values()].some((entry) => String(entry.key) === key))) {
            const message = "This player is no longer in the current match.";
            setCallKbiButtonState(key, "error", message);
            showUnityReportNotification(`<color=#ed3434>${message}</color>`);
            return;
        }
        const parsedSessionLink = parseReportSessionLink(roomLink);
        if (!parsedSessionLink) {
            if (options.requireDetectedRoom) {
                const message = "Join a Kour match before calling KBI.";
                setCallKbiButtonState(key, "error", message, 0, 1800);
                showUnityReportNotification(`<color=#ed3434>${message}</color>`);
                return;
            }
            openMenuCallLinkDialog(player);
            return;
        }
        pendingReportPayload = {
            reporter: getReportIdentity().reporter || "No detected",
            target: player ? (player.name || "Unknown player") : "No player selected",
            reason: "This user is calling KBI",
            roomId: parsedSessionLink.roomId,
            sessionLink: parsedSessionLink.url.href,
        };
        setCallKbiButtonState(key, "loading");
        void sendReport(pendingReportPayload, null, key);
    }

    /**
     * Safely render a status prefix and message as text nodes.
     * @see setReportFormStatus
     * @see setVerificationStatus
     */
    function renderStatusMessage(element, message, kind, prefixText) {
        const prefix = document.createElement("span");
        prefix.className = "status-prefix";
        prefix.dataset.kind = kind;
        prefix.textContent = prefixText || (kind === "success"
            ? "Success!"
            : kind === "error" ? "Error:" : "Info:");
        const text = document.createElement("span");
        text.className = "status-message";
        text.textContent = message;
        while (element.firstChild) element.removeChild(element.firstChild);
        element.appendChild(prefix);
        element.appendChild(document.createTextNode(" "));
        element.appendChild(text);
    }

    /**
     * Remove the active Turnstile widget and clear its container.
     * @see resetReportCaptcha
     * @see openVerificationDialog
     */
    function removeCaptchaWidget() {
        const gameWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
        if (captchaWidgetId !== null && gameWindow.turnstile) {
            try {
                gameWindow.turnstile.remove(captchaWidgetId);
            } catch (error) {
                console.error("[Kour Report] Failed to remove the security check widget:", error);
            }
        }
        captchaWidgetId = null;
        while (verificationWidget.firstChild) {
            verificationWidget.removeChild(verificationWidget.firstChild);
        }
    }

    /**
     * Cancel any pending verification and return the CAPTCHA dialog to its initial state.
     * @see removeCaptchaWidget
     * @see closeReportDialog
     * @see openVerificationDialog
     */
    function resetReportCaptcha() {
        captchaInProgress = false;
        captchaAttemptId += 1;
        pendingReportPayload = null;
        pendingCallPlayerKey = null;
        pendingMessageCaptcha = null;
        hidePopup(verificationLayer);
        removeCaptchaWidget();
        verificationStatus.textContent = "";
        verificationStatus.removeAttribute("data-kind");
        verificationTitle.textContent = "Security check";
        verificationDescription.textContent = "Complete this check to send your report.";
    }

    /**
     * Display an informational or error message in the verification dialog.
     * @see renderStatusMessage
     * @see openVerificationDialog
     */
    function setVerificationStatus(message, kind = "") {
        renderStatusMessage(verificationStatus, message, kind || "info");
    }

    /**
     * Load Cloudflare Turnstile once and reuse its API for later report attempts.
     * @returns {Promise<object>} The page's initialized Turnstile API.
     * @see openVerificationDialog
     * @see resetReportCaptcha
     */
    function loadCaptchaApi() {
        const gameWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
        if (gameWindow.turnstile?.render) return Promise.resolve(gameWindow.turnstile);
        if (captchaScriptPromise) return captchaScriptPromise;

        captchaScriptPromise = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = TURNSTILE_SCRIPT_URL;
            script.async = true;
            script.dataset.kourReportCaptcha = "true";
            script.onload = () => {
                if (gameWindow.turnstile?.render) resolve(gameWindow.turnstile);
                else reject(new Error("The verification service did not initialize."));
            };
            script.onerror = () => reject(new Error("The verification service could not be loaded."));
            (document.head || document.documentElement).appendChild(script);
        }).catch((error) => {
            captchaScriptPromise = null;
            throw error;
        });
        return captchaScriptPromise;
    }

    /**
     * Request Turnstile only when the V2 report or message API requires it.
     * The attempt ID invalidates callbacks from a canceled or superseded widget.
     * @param {string|null} [callPlayerKey] KBI button key, or null for a manual report.
     * @param {object|null} [messagePayload] Pending outgoing message to resume after verification.
     * @see loadCaptchaApi
     * @see sendReport
     * @see resetReportCaptcha
     */
    async function openVerificationDialog(callPlayerKey = null, messagePayload = null) {
        if (captchaInProgress) return;
        const attemptId = captchaAttemptId + 1;
        captchaAttemptId = attemptId;
        captchaInProgress = true;
        pendingCallPlayerKey = callPlayerKey;
        pendingMessageCaptcha = messagePayload;
        if (messagePayload) {
            pendingReportPayload = null;
            verificationTitle.textContent = "Verify to send message";
            verificationDescription.textContent = "Complete this check to send your message to KBI.";
        } else {
            verificationTitle.textContent = "Security check";
            verificationDescription.textContent = "Complete this check to send your report.";
        }
        showPopup(verificationLayer);
        setVerificationStatus("Loading security check…");
        verificationCancelButton.focus();

        try {
            const turnstile = await loadCaptchaApi();
            if (!captchaInProgress || captchaAttemptId !== attemptId) return;
            const renderedWidgetId = turnstile.render(verificationWidget, {
                sitekey: TURNSTILE_SITE_KEY,
                theme: "dark",
                callback: (token) => {
                    if (!captchaInProgress || captchaAttemptId !== attemptId ||
                        !token || (!pendingReportPayload && !pendingMessageCaptcha)) return;
                    if (pendingMessageCaptcha) {
                        const messagePayload = pendingMessageCaptcha;
                        hidePopup(verificationLayer);
                        removeCaptchaWidget();
                        captchaInProgress = false;
                        pendingMessageCaptcha = null;
                        pendingCallPlayerKey = null;
                        verificationTitle.textContent = "Security check";
                        verificationDescription.textContent = "Complete this check to send your report.";
                        void submitOutgoingMessage(
                            messagePayload.messageId,
                            messagePayload.message,
                            messagePayload.senderName,
                            messagePayload.clientToken,
                            token
                        );
                        return;
                    }
                    const payload = pendingReportPayload;
                    const callKey = pendingCallPlayerKey;
                    hidePopup(verificationLayer);
                    removeCaptchaWidget();
                    captchaInProgress = false;
                    pendingReportPayload = null;
                    pendingCallPlayerKey = null;
                    void sendReport(payload, token, callKey);
                },
                "expired-callback": () => {
                    if (captchaInProgress && captchaAttemptId === attemptId) {
                        failVerification("The security check expired. Please try again.");
                    }
                },
                "error-callback": () => {
                    if (captchaInProgress && captchaAttemptId === attemptId) {
                        failVerification("The security check could not be completed. Please try again.");
                    }
                },
            });
            if (!captchaInProgress || captchaAttemptId !== attemptId) {
                if (renderedWidgetId !== null && renderedWidgetId !== undefined &&
                    typeof turnstile.remove === "function") {
                    try {
                        turnstile.remove(renderedWidgetId);
                    } catch (error) {
                        console.error("[Kour Report] Failed to remove the security check widget:", error);
                    }
                }
                return;
            }
            captchaWidgetId = renderedWidgetId;
            setVerificationStatus("Complete the security check to continue.");
        } catch (error) {
            if (!captchaInProgress || captchaAttemptId !== attemptId) return;
            console.error("[Kour Report] Failed to initialize security verification:", error);
            const callKey = callPlayerKey;
            const messagePayload = pendingMessageCaptcha;
            resetReportCaptcha();
            const message = error instanceof Error ? error.message : "The security check could not be loaded.";
            if (messagePayload) {
                finishOutgoingMessageSend(messagePayload.messageId, createOutgoingMessageErrorLog(
                    null, null, "", message, "CAPTCHA_INITIALIZATION_FAILED"
                ));
            } else if (callKey !== null) {
                setCallKbiButtonState(callKey, "error", message);
            } else {
                setReportFormStatus(message, "error");
                reportSubmitButton.focus();
            }
        }

        function failVerification(message) {
            if (!captchaInProgress || captchaAttemptId !== attemptId) return;
            const callKey = pendingCallPlayerKey;
            const messagePayload = pendingMessageCaptcha;
            resetReportCaptcha();
            if (messagePayload) {
                finishOutgoingMessageSend(messagePayload.messageId, createOutgoingMessageErrorLog(
                    null, null, "", message, "CAPTCHA_VERIFICATION_FAILED"
                ));
            } else if (callKey !== null) {
                setCallKbiButtonState(callKey, "error", message);
            } else {
                setReportFormStatus(message, "error");
                reportSubmitButton.focus();
            }
        }
    }

    /***************************************
     * Reporter Identity, Room Links, and Updates
     ***************************************/
    /**
     * Prepare the reporter identity for a report.
     * @returns {{reporter: string}} Reporter identity for the report request.
     * @see reportForm
     * @see openVerificationDialog
     */
    function normalizePlayerName(value) {
        return typeof value === "string"
            ? value.replace(/<[^>]*>/g, "").trim()
            : "";
    }

    function getReportIdentity() {
        let reporter = "";
        const normalizeReporter = (value) => {
            const normalized = normalizePlayerName(value);
            return normalized && normalized.toLowerCase() !== "you" &&
                normalized.toLowerCase() !== "game default"
                ? normalized
                : "";
        };
        try {
            const gameWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
            reporter = normalizeReporter(
                gameWindow.firebase?.auth?.()?.currentUser?.displayName ||
                gameWindow.firebase?.auth?.()?.currentUser?.providerData?.[0]?.displayName
            );
        } catch (error) {
            console.warn("[Kour Report] Could not read the Firebase player name:", error);
        }
        if (!reporter) reporter = normalizeReporter(reportMatchState.localName);
        if (!reporter) {
            try {
                const usernameKeys = [
                    "playerNickname", "playerUsername", "username", "userName",
                    "nickname", "displayName", "gameUsername", "guestUsername"
                ];
                for (const key of usernameKeys) {
                    reporter = normalizeReporter(window.localStorage.getItem(key));
                    if (reporter) break;
                }
                if (!reporter) {
                    for (let index = 0; index < window.localStorage.length; index += 1) {
                        const key = window.localStorage.key(index);
                        if (!key || !/(^|[_:-])(user(name)?|nick(name)?|player(name)?|displayName)([_:-]|$)/i.test(key)) continue;
                        reporter = normalizeReporter(window.localStorage.getItem(key));
                        if (reporter) break;
                    }
                }
            } catch (error) {
                console.warn("[Kour Report] Could not read the saved game username:", error);
            }
        }
        if (!reporter) {
            reporter = normalizeReporter(
                document.getElementById("adminCurrentNickname")?.textContent
            );
        }
        if (!reporter && reportMatchState.localId !== null &&
            String(reportMatchState.localId).trim()) {
            reporter = `Guest_${reportMatchState.localId}`;
        }
        return { reporter };
    }

    /**
     * Extract a non-empty room ID from a user-provided Kour match URL.
     * @param {string} value Link entered in the report form.
     * @returns {{url: URL, roomId: string}|null} Parsed room link, or null when invalid.
     */
    function parseReportSessionLink(value) {
        let sessionUrl;
        try {
            const trimmedValue = String(value || "").trim();
            if (typeof URL === "function") {
                sessionUrl = new URL(trimmedValue);
            } else {
                sessionUrl = document.createElement("a");
                sessionUrl.href = trimmedValue;
            }
        } catch {
            return null;
        }
        const isKourHost = sessionUrl.hostname === "kour.io" ||
            sessionUrl.hostname.endsWith(".kour.io");
        const roomId = sessionUrl.hash.slice(1).trim();
        if (!isKourHost || !/^https?:$/.test(sessionUrl.protocol) ||
            sessionUrl.username || sessionUrl.password || !roomId) {
            return null;
        }
        return { url: sessionUrl, roomId };
    }

    /**
     * Prefill the report link when the current page has a non-empty room ID.
     * @returns {string} Current Kour match URL, or an empty string in the lobby.
     */
    function getCurrentReportSessionLink() {
        const roomId = window.location.hash.slice(1).trim();
        return roomId ? window.location.href : "";
    }

    function updateOpenManualReportSessionLink() {
        if (!manualReport || reportDialogLayer.hidden || reportSessionLinkEdited) return;
        const sessionLink = getCurrentReportSessionLink();
        if (sessionLink) reportSessionLink.value = sessionLink;
    }

    function limitServerResponse(message) {
        const text = String(message).trim();
        if (text.length <= MAX_SERVER_RESPONSE_LENGTH) return text;
        return `${text.slice(0, MAX_SERVER_RESPONSE_LENGTH)}… [response truncated]`;
    }

    function getRetryAfterSeconds(response) {
        const retryAfter = response.headers.get("Retry-After");
        if (!retryAfter) return null;

        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);

        const retryAt = Date.parse(retryAfter);
        return Number.isNaN(retryAt)
            ? null
            : Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    }

    /**
     * Ask the Unity game instance to show a message after report submission.
     * @param {string} message Text displayed in the game.
     * @returns {boolean} Whether Unity accepted the notification call.
     * @see sendReport
     */
    function showUnityReportNotification(message) {
        const gameWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
        const gameInstance = gameWindow.unityInstance || window.unityInstance;
        if (!gameInstance || typeof gameInstance.SendMessage !== "function") {
            console.error("[Kour Report] Unity is not ready; the report was sent but its in-game notification could not be shown.");
            return false;
        }
        try {
            gameInstance.SendMessage("MainManager", "ShowMessageCustom", String(message));
            return true;
        } catch (error) {
            console.error("[Kour Report] Failed to show the Unity notification:", error);
            return false;
        }
    }

    function compareVersions(left, right) {
        const parse = (version) => {
            if (!/^\d+(?:\.\d+)*$/.test(version)) return null;
            return version.split(".").map(Number);
        };
        const leftParts = parse(left);
        const rightParts = parse(right);
        if (!leftParts || !rightParts) return null;
        const partCount = Math.max(leftParts.length, rightParts.length);
        for (let index = 0; index < partCount; index += 1) {
            const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
            if (difference !== 0) return Math.sign(difference);
        }
        return 0;
    }

    function notifyUnityWhenReady(message) {
        const maxAttempts = 60;
        let attempts = 0;
        const tryNotify = () => {
            if (!launcherSettings.showUpdateNotifications) return;
            const gameWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
            const gameInstance = gameWindow.unityInstance || window.unityInstance;
            if (!gameInstance || typeof gameInstance.SendMessage !== "function") {
                attempts += 1;
                if (attempts >= maxAttempts) {
                    console.warn("[Kour Report] Unity did not become ready in time; its update notification was skipped.");
                    return;
                }
                window.setTimeout(tryNotify, 1000);
                return;
            }
            showUnityReportNotification(message);
        };
        tryNotify();
    }

    /**
     * Request a userscript resource through whichever cross-manager API is available.
     * The legacy callback API remains the preferred path for older Tampermonkey versions.
     * @param {object} details Request URL, timeout, and response callbacks.
     * @returns {Promise<{status: number, responseText: string}>} HTTP status and response body.
     */
    function requestUserscriptResource(details) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let timeoutId = null;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                if (timeoutId !== null) window.clearTimeout(timeoutId);
                callback(value);
            };
            const requestDetails = {
                ...details,
                onload: (response) => finish(resolve, response),
                onerror: () => finish(reject, new Error("Network request failed.")),
                ontimeout: () => finish(reject, new Error("The resource request timed out.")),
            };

            try {
                if (typeof GM_xmlhttpRequest === "function") {
                    GM_xmlhttpRequest(requestDetails);
                    return;
                }
                if (typeof GM !== "undefined" &&
                    GM && typeof GM.xmlHttpRequest === "function") {
                    const request = GM.xmlHttpRequest(requestDetails);
                    if (request && typeof request.then === "function") {
                        request.then(
                            (response) => finish(resolve, response),
                            (error) => finish(reject, error)
                        );
                    }
                    return;
                }
                if (typeof fetch !== "function") {
                    finish(reject, new Error("No supported cross-origin request API is available."));
                    return;
                }

                if (Number.isFinite(details.timeout) && details.timeout > 0) {
                    timeoutId = window.setTimeout(
                        () => finish(reject, new Error("The resource request timed out.")),
                        details.timeout
                    );
                }
                fetch(details.url, { cache: "no-store" }).then((response) =>
                    response.text().then((responseText) => finish(resolve, {
                        status: response.status,
                        responseText,
                    }))
                ).catch((error) => finish(reject, error));
            } catch (error) {
                finish(reject, error);
            }
        });
    }

    function parseChangelogMarkdown(markdown) {
        const releases = [];
        let currentRelease = null;
        let currentSection = null;
        const cleanText = (text) => text
            .replace(/`([^`]+)`/g, "$1")
            .replace(/\*\*([^*]+)\*\*/g, "$1")
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
            .trim();

        for (const line of markdown.split(/\r?\n/)) {
            const releaseMatch = line.match(/^##\s+\[?v?(\d+\.\d+(?:\.\d+)*)\]?(?:\s*[-–—]\s*(.+?))?\s*$/i);
            if (releaseMatch) {
                currentRelease = {
                    version: releaseMatch[1],
                    date: releaseMatch[2] ? cleanText(releaseMatch[2]) : "",
                    sections: [],
                };
                releases.push(currentRelease);
                currentSection = null;
                continue;
            }
            if (!currentRelease) continue;

            const sectionMatch = line.match(/^###\s+(.+?)\s*$/);
            if (sectionMatch) {
                currentSection = { title: cleanText(sectionMatch[1]), items: [] };
                currentRelease.sections.push(currentSection);
                continue;
            }

            const itemMatch = line.match(/^\s*[-*]\s+(.+?)\s*$/);
            if (itemMatch) {
                if (!currentSection) {
                    currentSection = { title: "Changes", items: [] };
                    currentRelease.sections.push(currentSection);
                }
                currentSection.items.push(cleanText(itemMatch[1]));
            }
        }
        return releases;
    }

    function renderChangelog(releases) {
        changelogList.replaceChildren();
        releases.forEach((release) => {
            const article = document.createElement("article");
            article.className = "changelog-release";
            article.setAttribute("role", "listitem");

            const header = document.createElement("header");
            header.className = "changelog-release-header";
            const title = document.createElement("h3");
            title.className = "changelog-release-title";
            title.textContent = `Version ${release.version}`;
            header.appendChild(title);
            if (release.date) {
                const date = document.createElement("time");
                date.className = "changelog-release-date";
                date.textContent = release.date;
                header.appendChild(date);
            }
            article.appendChild(header);

            release.sections.forEach((section) => {
                if (section.items.length === 0) return;
                const sectionElement = document.createElement("section");
                sectionElement.className = "changelog-section";
                const sectionTitle = document.createElement("h4");
                sectionTitle.className = "changelog-section-title";
                sectionTitle.textContent = section.title;
                const items = document.createElement("ul");
                items.className = "changelog-items";
                section.items.forEach((item) => {
                    const listItem = document.createElement("li");
                    listItem.textContent = item;
                    items.appendChild(listItem);
                });
                sectionElement.append(sectionTitle, items);
                article.appendChild(sectionElement);
            });
            changelogList.appendChild(article);
        });
    }

    async function loadChangelog() {
        const requestId = ++changelogRequestId;
        changelogStatus.textContent = "Loading release history...";
        changelogList.replaceChildren();
        try {
            const response = await requestUserscriptResource({
                method: "GET",
                url: `${CHANGELOG_URL}?check=${Date.now()}`,
                timeout: 10000,
            });
            if (requestId !== changelogRequestId) return;
            if (response.status !== 200) {
                throw new Error(`Changelog request failed with HTTP ${response.status}.`);
            }
            if (typeof response.responseText !== "string" || response.responseText.length > 250000) {
                throw new Error("The changelog response is empty or too large.");
            }
            const releases = parseChangelogMarkdown(response.responseText);
            if (releases.length === 0) {
                throw new Error("The changelog does not contain any supported version entries.");
            }
            renderChangelog(releases);
            changelogStatus.textContent =
                `Loaded ${releases.length} version${releases.length === 1 ? "" : "s"} from the repository. Newest releases are listed first; scroll down for older versions.`;
        } catch (error) {
            if (requestId !== changelogRequestId) return;
            console.warn("[Kour Report] Could not load the changelog:", error);
            changelogStatus.textContent = "Could not load release history from GitHub. Check your connection and reopen the menu to try again.";
        }
    }

    async function checkForUpdates() {
        let updateManifest;
        try {
            const response = await requestUserscriptResource({
                method: "GET",
                url: `${VERSION_URL}?check=${Date.now()}`,
                timeout: 10000,
            });
            if (response.status !== 200) {
                throw new Error(`Version check failed with HTTP ${response.status}.`);
            }
            updateManifest = JSON.parse(response.responseText);
        } catch (error) {
            console.warn("[Kour Report] Could not check for userscript updates:", error);
            return;
        }
        if (!updateManifest || typeof updateManifest !== "object" ||
            typeof updateManifest.version !== "string" ||
            typeof updateManifest.details !== "string") {
            console.warn("[Kour Report] The update manifest must contain string fields named version and details.");
            return;
        }
        const latestVersion = updateManifest.version.trim();
        const comparison = compareVersions(latestVersion, SCRIPT_VERSION);
        if (comparison === null) {
            console.warn(`[Kour Report] Cannot compare userscript versions "${SCRIPT_VERSION}" and "${latestVersion}".`);
            return;
        }
        if (comparison <= 0) return;

        availableUpdateVersion = latestVersion;
        updateLabel.textContent = `New update available: v${latestVersion}`;
        updateDetails.textContent = updateManifest.details.trim();
        updateDetails.hidden = updateDetails.textContent.length === 0;
        updateDetails.title = updateDetails.textContent;
        applyUpdateNotificationVisibility();
        if (launcherSettings.showUpdateNotifications) {
            notifyUnityWhenReady("<color=#4CAF50>New report script update!</color>");
        }
    }

    /***************************************
     * Report Dialog and Player List
     ***************************************/
    /**
     * Reset the form and prepare it for the selected player.
     * @param {object|null} player Selected roster entry, or null for a manual report.
     * @param {boolean} [isManual=false] Whether the reported name is entered manually.
     * @see updateCombinedReason
     * @see closeReportDialog
     */
    function openReportDialog(player, isManual = false) {
        resetReportCaptcha();
        manualReport = isManual;
        reportedPlayerKey = isManual ? null : player.key;
        reportDialogTitle.textContent = "";
        if (isManual) {
            reportDialogTitle.textContent = "Manual report";
            reportDialogTitle.title = "Manual report";
        } else {
            appendPlayerName(reportDialogTitle, player.rawName || "", player.name);
            reportDialogTitle.title = player.name;
        }
        reportDialogLayer.querySelector(".report-dialog-subtitle").textContent = isManual
            ? "Enter the player's name and report details"
            : "Confirm the player and report details";
        reportTarget.required = !isManual;
        reportTargetHelp.hidden = !isManual;
        manualReportHelpTooltip.hidden = true;
        reportTarget.placeholder = isManual ? "Enter player name" : "";
        reportTarget.value = isManual
            ? ""
            : player.name.replace(/^\[[^\]]{1,32}\]\s*/, "");
        reportTarget.title = reportTarget.value;
        reportSessionLinkEdited = false;
        reportSessionLink.value = getCurrentReportSessionLink();
        reportDialogAvatar.src = PLAYER_AVATAR_URL;
        reportDialogAvatar.alt = isManual ? "Kour Report" : `Profile image for ${player.name}`;
        selectedReportReason = "";
        reportReasonLabel.textContent = "Select a reason";
        setReasonMenuOpen(false);
        reportReasonButtons.forEach((option) => {
            option.setAttribute("aria-selected", "false");
            option.querySelector(".reason-option-check").textContent = "";
        });
        reportDetails.value = "";
        reportDetails.maxLength = MAX_REPORT_REASON_LENGTH;
        reportCombinedReason.value = "";
        updateCombinedReason();
        reportFormStatus.hidden = true;
        reportFormStatus.removeAttribute("data-kind");
        showPopup(reportDialogLayer);
        if (isManual) reportTarget.focus();
        else reportReason.focus();
    }

    /**
     * Combine the selected report category and optional details for submission.
     * @see openReportDialog
     * @see reportForm submit handler
     */
    function updateCombinedReason() {
        const category = selectedReportReason;
        const maxDetailsLength = category
            ? Math.max(0, MAX_REPORT_REASON_LENGTH - category.length - 3)
            : MAX_REPORT_REASON_LENGTH;
        reportDetails.maxLength = maxDetailsLength;
        if (reportDetails.value.length > maxDetailsLength) {
            reportDetails.value = reportDetails.value.slice(0, maxDetailsLength);
        }
        const details = reportDetails.value.trim();
        reportCombinedReason.value = details ? `${category} - ${details}` : category;
        const remainingCharacters = Math.max(0, maxDetailsLength - reportDetails.value.length);
        reportDetailsCount.textContent = `${remainingCharacters} character${remainingCharacters === 1 ? "" : "s"} remaining`;
        reportDetailsCount.dataset.limitReached = String(remainingCharacters === 0);
    }

    reportDetails.addEventListener("input", updateCombinedReason);
    const focusReportTextField = (field) => {
        if (document.activeElement instanceof HTMLCanvasElement) document.activeElement.blur();
        if (document.pointerLockElement && typeof document.exitPointerLock === "function") {
            document.exitPointerLock();
        }
        field.focus();
        reportTextFieldFocused = true;
    };
    [reportTarget, reportSessionLink, reportDetails, menuCallRoomLinkInput, messagesInput, messagesSenderInput].forEach((field) => {
        field.addEventListener("focus", () => {
            reportTextFieldFocused = true;
        });
        field.addEventListener("blur", () => {
            textCompositionActive = false;
            reportTextFieldFocused = reportTextFields.has(shadow.activeElement);
        });
        field.addEventListener("compositionstart", () => {
            textCompositionActive = true;
        });
        field.addEventListener("compositionend", () => {
            textCompositionActive = false;
        });
        if ("PointerEvent" in window) field.addEventListener("pointerdown", () => focusReportTextField(field));
        else {
            field.addEventListener("mousedown", () => focusReportTextField(field));
            field.addEventListener("touchstart", () => focusReportTextField(field), { passive: true });
        }
    });
    reportSessionLink.addEventListener("input", () => {
        reportSessionLinkEdited = true;
    });
    reportTargetHelp.addEventListener("pointerenter", showManualReportHelpTooltip);
    reportTargetHelp.addEventListener("pointerleave", () => {
        if (shadow.activeElement !== reportTargetHelp) manualReportHelpTooltip.hidden = true;
    });
    reportTargetHelp.addEventListener("focus", showManualReportHelpTooltip);
    reportTargetHelp.addEventListener("blur", () => {
        manualReportHelpTooltip.hidden = true;
    });
    // Keep the reason dropdown state and selected option synchronized with the form.
    // @see setReasonMenuOpen
    // @see updateCombinedReason
    reportReason.addEventListener("click", () => {
        setReasonMenuOpen(reportReasonOptions.hidden);
    });
    reportReasonButtons.forEach((option) => {
        option.addEventListener("click", () => {
            selectedReportReason = option.dataset.reason || "";
            reportReasonLabel.textContent = selectedReportReason;
            reportReasonButtons.forEach((item) => {
                const selected = item === option;
                item.setAttribute("aria-selected", String(selected));
                item.querySelector(".reason-option-check").textContent = selected ? "✓" : "";
            });
            setReasonMenuOpen(false);
            reportFormStatus.hidden = true;
            updateCombinedReason();
            reportDetails.focus();
        });
    });

    /**
     * Render game-formatted names as text nodes while preserving colored clan tags.
     * Using text nodes keeps player-provided markup from becoming executable HTML.
     * @see renderPlayers
     * @see openReportDialog
     */
    function appendPlayerName(container, rawName, fallbackName) {
        const colorTag = /<color=(#[\da-f]{3,8}|[a-z]{3,20})>([\s\S]*?)<\/color>/gi;
        const appendText = (text) => {
            const cleanText = text.replace(/<[^>]*>/g, "");
            if (cleanText) container.appendChild(document.createTextNode(cleanText));
        };
        const appendColoredClan = (text, color) => {
            const clanTag = /\[[^\]]{1,32}\]/g;
            let lastIndex = 0;
            let clanMatch;
            while ((clanMatch = clanTag.exec(text)) !== null) {
                appendText(text.slice(lastIndex, clanMatch.index));
                const clan = document.createElement("span");
                clan.textContent = clanMatch[0];
                clan.style.setProperty("color", color, "important");
                container.appendChild(clan);
                lastIndex = clanTag.lastIndex;
            }
            appendText(text.slice(lastIndex));
        };

        let lastIndex = 0;
        let match;
        while ((match = colorTag.exec(rawName)) !== null) {
            appendText(rawName.slice(lastIndex, match.index));
            appendColoredClan(match[2], match[1]);
            lastIndex = colorTag.lastIndex;
        }
        appendText(rawName.slice(lastIndex));
        if (lastIndex === 0 && !container.childNodes.length) {
            container.textContent = fallbackName;
        }
    }

    /**
     * Refresh the visible roster, omitting the local player and avoiding unchanged redraws.
     * @param {boolean} active Whether a match is currently active.
     * @param {Array<object>} players Current match player entries.
     * @see notifyReportMatchPlayers
     * @see openReportDialog
     */
    function updatePlayerListHeight() {
        const visibleRowLimit = window.matchMedia("(max-width: 560px)").matches ? 4 : 6;
        const rows = [...playerList.children];
        if (rows.length <= visibleRowLimit) {
            playerList.style.maxHeight = "";
            return;
        }
        const visibleRows = rows.slice(0, visibleRowLimit);
        const rowHeights = visibleRows.reduce((total, row) => total + row.getBoundingClientRect().height, 0);
        const rowGap = parseFloat(getComputedStyle(playerList).rowGap) || 0;
        playerList.style.maxHeight = `${rowHeights + rowGap * (visibleRows.length - 1)}px`;
    }

    function renderPlayers(active, players) {
        updateOpenManualReportSessionLink();
        playerCount.hidden = true;
        playerCount.textContent = "";
        const reportablePlayers = active
            ? players.filter((player) => !player.local).sort((a, b) => a.name.localeCompare(b.name))
            : [];
        const hasReportablePlayers = reportablePlayers.length > 0;
        playersHeading.hidden = !hasReportablePlayers;
        if (hasReportablePlayers) {
            playerCount.textContent = `${reportablePlayers.length} ${reportablePlayers.length === 1 ? "PLAYER" : "PLAYERS"}`;
            playerCount.hidden = false;
        }
        const signature = JSON.stringify({
            active,
            players: reportablePlayers.map(({ key, name, playerId }) => [key, name, playerId]),
        });
        if (signature === renderedPlayersSignature) return;
        renderedPlayersSignature = signature;
        const existingPlayerKeys = new Set(
            [...playerList.children].map((row) => row.dataset.playerKey)
        );
        emptyState.hidden = hasReportablePlayers;
        if (hasReportablePlayers) {
            emptyState.parentNode.insertBefore(menuReportActions, emptyState.nextSibling);
        } else {
            emptyState.appendChild(menuReportActions);
        }
        emptyStateMessage.textContent = "The player list is unavailable right now. If you're in a match, match detection may not be working. You can still submit a manual report.";
        while (playerList.firstChild) playerList.removeChild(playerList.firstChild);
        playerList.style.maxHeight = "";
        reportablePlayers.forEach((player) => {
            const row = document.createElement("div");
            row.className = "player-row";
            row.dataset.playerKey = player.key;
            if (!existingPlayerKeys.has(player.key)) row.classList.add("player-row-enter");

            const avatar = document.createElement("div");
            avatar.className = "player-avatar";
            avatar.setAttribute("aria-hidden", "true");
            const avatarImage = document.createElement("img");
            avatarImage.src = PLAYER_AVATAR_URL;
            avatarImage.alt = "";
            avatar.appendChild(avatarImage);

            const info = document.createElement("div");
            info.className = "player-info";
            const name = document.createElement("div");
            name.className = "player-name";
            appendPlayerName(name, player.rawName || "", player.name);
            name.title = player.name;
            const status = document.createElement("div");
            status.className = "player-status";
            status.textContent = "IN MATCH";
            info.append(name, status);

            const actions = document.createElement("div");
            actions.className = "player-actions";
            const reportButton = document.createElement("button");
            reportButton.type = "button";
            reportButton.className = "player-action report";
            reportButton.textContent = "Report";
            reportButton.addEventListener("click", () => openReportDialog(player));
            addButtonPressAnimation(reportButton);
            const callButton = document.createElement("button");
            callButton.type = "button";
            callButton.className = "player-action call-kbi";
            callButton.dataset.callPlayerKey = player.key;
            callButton.dataset.playerName = player.name;
            const callIcon = document.createElement("span");
            callIcon.className = "call-kbi-icon";
            callIcon.setAttribute("aria-hidden", "true");
            const callLabel = document.createElement("span");
            callLabel.className = "call-kbi-label";
            callButton.append(callIcon, callLabel);
            callButton.addEventListener("click", () => startKbiCall(player));
            addButtonPressAnimation(callButton);
            applyCallKbiButtonState(callButton, callKbiButtonStates.get(String(player.key)) || null);
            actions.append(reportButton, callButton);
            row.append(avatar, info, actions);
            playerList.appendChild(row);
        });
        updatePlayerListHeight();
    }

    applyCallKbiButtonState(
        menuCallKbiButton,
        callKbiButtonStates.get(MENU_CALL_PLAYER_KEY) || null
    );
    applyCallKbiButtonState(
        launcherQuickCall,
        callKbiButtonStates.get(MENU_CALL_PLAYER_KEY) || null
    );
    onReportMatchPlayersUpdated = (active, players) => renderPlayers(active, players);
    window.addEventListener("hashchange", updateOpenManualReportSessionLink);
    notifyReportMatchPlayers();

    function setApiHealthStatus(state, label, detail) {
        apiHealthButton.classList.remove("is-checking", "is-online", "is-error");
        apiHealthButton.classList.add(`is-${state}`);
        apiHealthLabel.textContent = label;
        apiHealthButton.title = detail;
        apiHealthButton.setAttribute("aria-label", `API status: ${label}. ${detail} Activate to check again.`);
        apiHealthButton.disabled = state === "checking";
    }

    async function checkApiHealth(force = false) {
        if (apiHealthCheckInProgress ||
            (!force && Date.now() - apiHealthLastCheckedAt < API_HEALTH_CHECK_INTERVAL_MS)) return;
        apiHealthCheckInProgress = true;
        apiHealthLastCheckedAt = Date.now();
        setApiHealthStatus("checking", "Checking API…", "Checking API availability.");

        const controller = typeof AbortController === "function" ? new AbortController() : null;
        let timeoutId = 0;
        try {
            const healthRequest = (async () => {
                const response = await fetch(REPORT_HEALTH_API_URL, {
                    method: "GET",
                    cache: "no-store",
                    ...(controller ? { signal: controller.signal } : {}),
                });
                return { response, body: await response.text() };
            })();
            const timeout = new Promise((resolve, reject) => {
                timeoutId = window.setTimeout(() => {
                    if (controller) controller.abort();
                    reject(new Error("Health check timed out."));
                }, API_HEALTH_CHECK_TIMEOUT_MS);
            });
            const { response, body } = await Promise.race([healthRequest, timeout]);
            let responseData = null;
            if (body) {
                try {
                    responseData = JSON.parse(body);
                } catch {
                    responseData = null;
                }
            }
            if (!response.ok || responseData?.success === false) {
                const reason = typeof responseData?.message === "string"
                    ? responseData.message
                    : typeof responseData?.code === "string"
                        ? responseData.code
                        : `HTTP ${response.status}`;
                throw new Error(reason);
            }
            setApiHealthStatus(
                "online",
                "API online",
                `API and health dependencies are responding (HTTP ${response.status}).`
            );
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            setApiHealthStatus("error", "API error", `Health check failed: ${reason}`);
        } finally {
            window.clearTimeout(timeoutId);
            apiHealthCheckInProgress = false;
        }
    }

    apiHealthButton.addEventListener("click", () => {
        void checkApiHealth(true);
    });

    /**
     * Show or hide the main panel and refresh the current roster when it opens.
     * @param {boolean} open Whether the report panel should be visible.
     * @see renderPlayers
     */
    function setOpen(open) {
        if (open) {
            if (document.pointerLockElement) document.exitPointerLock();
            clearTimeout(exitTimers.get(panel));
            exitTimers.delete(panel);
            panel.classList.remove("is-closing");
            panel.classList.add("open");
        } else if (panel.classList.contains("open")) {
            if (!reportHistoryLayer.hidden) hidePopup(reportHistoryLayer);
            clearTimeout(exitTimers.get(panel));
            exitTimers.delete(panel);
            panel.classList.remove("open");
            panel.classList.add("is-closing");
            const timer = setTimeout(() => {
                if (exitTimers.get(panel) !== timer) return;
                panel.classList.remove("is-closing");
                exitTimers.delete(panel);
            }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : POPUP_EXIT_DURATION_MS);
            exitTimers.set(panel, timer);
        }
        panel.setAttribute("aria-hidden", String(!open));
        updateLauncherQuickCallPosition();
        if (open) {
            while (playerList.firstChild) playerList.removeChild(playerList.firstChild);
            playerList.style.maxHeight = "";
            renderedPlayersSignature = null;
            notifyReportMatchPlayers();
            void loadChangelog();
            void checkApiHealth(true);
        }
    }

    launcher.addEventListener("click", () => {
        if (!launcher.dataset.dragged) setOpen(!panel.classList.contains("open"));
        launcher.dataset.dragged = "";
    });
    panel.addEventListener("click", (event) => {
        if (event.target === panel) setOpen(false);
    });
    closeButton.addEventListener("click", () => setOpen(false));
    manualReportButton.addEventListener("click", () => openReportDialog(null, true));
    reportHistoryButton.addEventListener("click", () => {
        closeReportHistoryClearPanel();
        reportHistoryClearStatus.hidden = true;
        renderReportHistory();
        showPopup(reportHistoryLayer);
        reportHistoryCloseButton.focus();
    });
    reportHistoryTabs.forEach((button) => {
        button.addEventListener("click", () => {
            reportHistoryFilter = button.dataset.reportHistoryFilter;
            renderReportHistory();
        });
    });
    reportHistoryCloseButton.addEventListener("click", () => {
        closeReportHistoryClearPanel();
        hidePopup(reportHistoryLayer);
        reportHistoryButton.focus();
    });
    reportHistoryLayer.addEventListener("click", (event) => {
        if (event.target !== reportHistoryLayer) return;
        closeReportHistoryClearPanel();
        hidePopup(reportHistoryLayer);
        reportHistoryButton.focus();
    });
    messagesButton.addEventListener("click", () => openMessages("", messagesButton));
    messagesCloseButton.addEventListener("click", closeMessages);
    messagesIdentityToggle.addEventListener("click", () => {
        if (messagesSettingsLayer.hidden) openMessageSettings();
        else closeMessageSettings();
    });
    messagesSettingsCloseButton.addEventListener("click", () => closeMessageSettings());
    messagesSettingsDoneButton.addEventListener("click", () => closeMessageSettings());
    messagesSettingsLayer.addEventListener("click", (event) => {
        if (event.target === messagesSettingsLayer) closeMessageSettings();
    });
    messagesIdentityEditButton.addEventListener("click", openMessageIdentityEditor);
    messagesIdentityCancelButton.addEventListener("click", cancelMessageIdentityEdit);
    messagesSenderInput.addEventListener("input", () => {
        messagesSettingsStatus.textContent = "Unsaved name changes.";
    });
    messagesIdentitySaveButton.addEventListener("click", () => {
        const senderName = messagesSenderInput.value.trim().slice(0, 100);
        try {
            if (senderName) {
                window.localStorage.setItem(MESSAGE_SENDER_NAME_STORAGE_KEY, senderName);
            } else {
                window.localStorage.removeItem(MESSAGE_SENDER_NAME_STORAGE_KEY);
            }
        } catch (error) {
            console.warn("[Kour Report] Could not save the message sender name:", error);
            messagesSettingsStatus.textContent = "Could not save your chat name. Check this browser's storage settings and try again.";
            return;
        }
        renderMessageIdentity();
        messagesIdentity.hidden = true;
        messagesSettingsStatus.textContent = senderName
            ? "Chat name saved."
            : "Chat name cleared. Your detected name will be used.";
        messagesIdentityEditButton.focus();
    });
    messagesClearButton.addEventListener("click", () => {
        if (!customMessages.length) {
            messagesSettingsStatus.textContent = "Message history is already empty.";
            return;
        }
        messagesSettingsStatus.textContent = "";
        messagesClearConfirmation.hidden = false;
        messagesClearConfirm.focus();
    });
    messagesClearCancel.addEventListener("click", () => {
        messagesClearConfirmation.hidden = true;
        messagesSettingsStatus.textContent = "";
        messagesClearButton.focus();
    });
    messagesClearConfirm.addEventListener("click", () => {
        const previousMessages = customMessages;
        customMessages = [];
        const saved = persistCustomMessages();
        if (!saved) {
            customMessages = previousMessages;
            updateMessagesUI();
            renderMessages();
            messagesSettingsStatus.textContent = "Message history could not be cleared from this device.";
            messagesClearConfirm.focus();
            return;
        }
        updateMessagesUI();
        renderMessages();
        messagesClearConfirmation.hidden = true;
        messagesStatus.textContent = "Message history cleared.";
        messagesSettingsStatus.textContent = "Message history cleared from this device.";
        messagesClearButton.focus();
    });
    messagesLayer.addEventListener("click", (event) => {
        if (event.target === messagesLayer) closeMessages();
    });
    messagesInput.addEventListener("input", () => {
        messagesSendButton.disabled = messageSendingInProgress || !messagesInput.value.trim();
    });
    messagesCompose.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (messageSendingInProgress || captchaInProgress || reportSubmitting) return;
        const message = messagesInput.value.trim();
        if (!message) {
            messagesStatus.textContent = "Enter a message before sending.";
            messagesInput.focus();
            return;
        }
        const senderName = messagesSenderInput.value.trim() || getMessageSenderName();
        messageSendingInProgress = true;
        messagesSendButton.disabled = true;
        messagesStatus.textContent = "";
        const outgoing = storeOutgoingMessage(message, senderName, "sending");
        try {
            const token = await getClientToken();
            updateOutgoingMessage(outgoing.messageId, { clientToken: token });
            await submitOutgoingMessage(outgoing.messageId, message, senderName, token);
        } catch (error) {
            console.error("[Kour Report] Could not prepare the client message:", error);
            const errorLog = createOutgoingMessageErrorLog(
                null,
                null,
                "",
                error instanceof Error ? error.message : String(error),
                "MESSAGE_PREPARATION_FAILED"
            );
            finishOutgoingMessageSend(outgoing.messageId, errorLog);
        }
    });
    window.addEventListener("storage", (event) => {
        if (event.key !== MESSAGE_STORAGE_KEY) return;
        const previousIds = new Set(customMessages.map((item) => item.messageId));
        customMessages = loadCustomMessages();
        updateMessagesUI();
        const newlyUnread = customMessages.filter((item) => !item.read && !previousIds.has(item.messageId));
        newlyUnread.forEach(showMessageNotification);
    });
    reportHistoryClearButton.addEventListener("click", () => {
        if (reportHistoryClearButton.disabled) return;
        reportHistoryClearStatus.hidden = true;
        if (!reportHistoryClearPanel.classList.contains("is-open")) {
            openReportHistoryClearPanel();
            reportHistoryClearChoices.find((button) => !button.disabled)?.focus();
        } else {
            closeReportHistoryClearPanel();
            reportHistoryClearButton.focus();
        }
    });
    reportHistoryClearPanel.addEventListener("click", (event) => {
        if (!(event.target instanceof Element)) return;
        const cancelButton = event.target.closest(".report-history-clear-cancel");
        if (cancelButton) {
            if (reportHistoryClearConfirmation.hidden) {
                closeReportHistoryClearPanel();
                reportHistoryClearButton.focus();
            } else {
                const scope = pendingReportHistoryDeleteScope;
                pendingReportHistoryDeleteScope = null;
                reportHistoryClearConfirmation.hidden = true;
                reportHistoryClearOptions.hidden = false;
                reportHistoryClearChoices
                    .find((button) => button.dataset.deleteScope === scope)
                    ?.focus();
            }
            return;
        }
        const choiceButton = event.target.closest(".report-history-clear-choice");
        if (choiceButton && !choiceButton.disabled) {
            openReportHistoryClearConfirmation(choiceButton.dataset.deleteScope);
            return;
        }
        if (event.target.closest(".report-history-clear-confirm")) {
            deleteReportHistoryEntries();
        }
    });
    reportDetailsCloseButton.addEventListener("click", closeReportDetails);
    reportDetailsLayer.addEventListener("click", (event) => {
        if (event.target !== reportDetailsLayer) return;
        closeReportDetails();
    });
    changelogButton.addEventListener("click", () => {
        changelogList.scrollTop = 0;
        showPopup(changelogLayer);
        changelogCloseButton.focus();
    });
    changelogCloseButton.addEventListener("click", () => {
        hidePopup(changelogLayer);
        changelogButton.focus();
    });
    changelogLayer.addEventListener("click", (event) => {
        if (event.target !== changelogLayer) return;
        hidePopup(changelogLayer);
        changelogButton.focus();
    });
    renderReportHistory();
    /**
     * Ask for a room URL while retaining an optional player target for submission.
     * @param {object|null} player Selected roster player, or null for a room call.
     * @see startKbiCall
     * @see parseReportSessionLink
     */
    function openMenuCallLinkDialog(player) {
        pendingMenuCallPlayer = player || null;
        menuCallLinkForm.reset();
        menuCallLinkStatus.hidden = true;
        menuCallLinkStatus.removeAttribute("data-kind");
        showPopup(menuCallLinkLayer);
        menuCallRoomLinkInput.focus();
    }

    function focusCallKbiButton(playerKey) {
        const buttons = shadow.querySelectorAll(".call-kbi");
        for (let index = 0; index < buttons.length; index += 1) {
            if (buttons[index].dataset.callPlayerKey === String(playerKey) &&
                !buttons[index].disabled) {
                buttons[index].focus();
                return;
            }
        }
        menuCallKbiButton.focus();
    }

    /**
     * Use the detected room URL when available; otherwise request it from the user.
     * @see openMenuCallLinkDialog
     * @see startKbiCall
     */
    function continueMenuCallRoom() {
        const currentSessionLink = getCurrentReportSessionLink();
        if (parseReportSessionLink(currentSessionLink)) {
            startKbiCall(null, currentSessionLink);
            return;
        }
        openMenuCallLinkDialog(null);
    }

    menuCallKbiButton.addEventListener("click", () => {
        const hasSelectablePlayers = reportMatchState.active &&
            [...reportMatchState.players.values()].some((player) =>
                !player.local &&
                (reportMatchState.localId === null ||
                    String(player.key) !== String(reportMatchState.localId))
            );
        if (hasSelectablePlayers) {
            showPopup(menuCallWarningLayer);
            menuCallWarningContinueButton.focus();
            return;
        }
        continueMenuCallRoom();
    });
    menuCallWarningContinueButton.addEventListener("click", () => {
        hidePopup(menuCallWarningLayer);
        continueMenuCallRoom();
    });
    menuCallWarningChooseButton.addEventListener("click", () => {
        hidePopup(menuCallWarningLayer);
        const firstCallButton = playerList.querySelector(".player-row .call-kbi");
        if (firstCallButton && !firstCallButton.disabled) firstCallButton.focus();
        else menuCallKbiButton.focus();
    });
    menuCallWarningLayer.addEventListener("click", (event) => {
        if (event.target !== menuCallWarningLayer) return;
        hidePopup(menuCallWarningLayer);
        menuCallKbiButton.focus();
    });
    menuCallLinkCancelButton.addEventListener("click", () => {
        const pendingPlayer = pendingMenuCallPlayer;
        pendingMenuCallPlayer = null;
        hidePopup(menuCallLinkLayer);
        focusCallKbiButton(pendingPlayer ? pendingPlayer.key : MENU_CALL_PLAYER_KEY);
    });
    menuCallLinkLayer.addEventListener("click", (event) => {
        if (event.target !== menuCallLinkLayer) return;
        const pendingPlayer = pendingMenuCallPlayer;
        pendingMenuCallPlayer = null;
        hidePopup(menuCallLinkLayer);
        focusCallKbiButton(pendingPlayer ? pendingPlayer.key : MENU_CALL_PLAYER_KEY);
    });
    menuCallLinkForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const parsedSessionLink = parseReportSessionLink(menuCallRoomLinkInput.value);
        if (!parsedSessionLink) {
            renderStatusMessage(
                menuCallLinkStatus,
                "Enter a valid Kour room link with a room ID, or join a match first.",
                "error"
            );
            menuCallLinkStatus.dataset.kind = "error";
            menuCallLinkStatus.hidden = false;
            menuCallRoomLinkInput.focus();
            return;
        }
        const pendingPlayer = pendingMenuCallPlayer;
        pendingMenuCallPlayer = null;
        hidePopup(menuCallLinkLayer);
        startKbiCall(pendingPlayer, parsedSessionLink.url.href);
    });
    shadow.querySelector(".cancel-report").addEventListener("click", closeReportDialog);
    reportDialogLayer.addEventListener("click", (event) => {
        if (event.target === reportDialogLayer && !reportSubmitting) closeReportDialog();
    });
    reportDialogLayer.addEventListener("click", (event) => {
        if (!reportDialogLayer.hidden &&
            !reportReasonSelect.contains(event.target) &&
            !reportReasonOptions.hidden) {
            setReasonMenuOpen(false);
        }
    });
    function cancelVerification() {
        const callKey = pendingCallPlayerKey;
        const messagePayload = pendingMessageCaptcha;
        resetReportCaptcha();
        if (messagePayload) {
            finishOutgoingMessageSend(messagePayload.messageId, createOutgoingMessageErrorLog(
                null,
                null,
                "",
                "Captcha verification canceled. The message was not sent.",
                "CAPTCHA_CANCELLED"
            ));
            return;
        }
        if (callKey !== null) {
            setCallKbiButtonState(callKey, "error", "The KBI call was canceled.");
            return;
        }
        setReportFormStatus("Security check canceled. Press Send report to try again.", "info");
        reportSubmitButton.focus();
    }
    verificationCancelButton.addEventListener("click", cancelVerification);
    // Validate the selected player and report details before starting verification.
    // @see getReportIdentity
    // @see openVerificationDialog
    reportForm.addEventListener("submit", (event) => {
        event.preventDefault();
        if (reportSubmitting || captchaInProgress || messageSendingInProgress) return;
        if (!selectedReportReason) {
            setReportFormStatus("Select a reason before continuing.");
            reportReason.focus();
            return;
        }
        if (!reportForm.reportValidity()) return;
        updateCombinedReason();
        if (!manualReport && (!reportMatchState.active ||
            ![...reportMatchState.players.values()].some((player) =>
                String(player.key) === String(reportedPlayerKey)))) {
            setReportFormStatus("The reported player is no longer in the current match. Select a player who is still present.");
            return;
        }

        const reporter = getReportIdentity().reporter || "No detected";
        const selectedTarget = reportedPlayerKey === null
            ? null
            : reportMatchState.players.get(String(reportedPlayerKey));
        const target = normalizePlayerName(selectedTarget?.name || reportTarget.value);
        const reason = reportCombinedReason.value.trim();
        const parsedSessionLink = parseReportSessionLink(reportSessionLink.value);
        if (!manualReport && !target) {
            setReportFormStatus("Enter the reported player's name.");
            return;
        }
        if (!parsedSessionLink) {
            setReportFormStatus("Enter a Kour room link that includes a room ID, for example https://kour.io/#ABC123.");
            return;
        }
        pendingReportPayload = {
            reporter,
            target,
            reason,
            roomId: parsedSessionLink.roomId,
            sessionLink: parsedSessionLink.url.href,
            reminderType: manualReport ? "manual-report" : "player-report",
        };
        reportFormStatus.hidden = true;
        void sendReport(pendingReportPayload, null);
    });
    /***************************************
     * Report Submission
     ***************************************/
    /**
     * Submit a report, handle any conditional CAPTCHA challenge, and restore the form state.
     * @param {object} payload Report fields prepared by the submit handler.
     * @param {string|null} verificationToken Optional token returned by Turnstile.
     * @see openVerificationDialog
     * @see showUnityReportNotification
     */
    async function sendReport(payload, verificationToken, callPlayerKey = null) {
        reportSubmitting = true;
        const useTestEndpoint = launcherSettings.testMode;
        if (callPlayerKey === null) {
            reportSubmitButton.disabled = true;
            reportCancelButton.disabled = true;
            setReportFormStatus("Sending report…", "info");
        }
        const playerCount = getDetectedRoomPlayerCount();
        const { reminderType, ...submissionPayload } = payload;
        const reportPayload = {
            ...submissionPayload,
            reporter: normalizePlayerName(submissionPayload.reporter) || "No detected",
            target: normalizePlayerName(submissionPayload.target) || "Unknown player",
            reason: typeof submissionPayload.reason === "string"
                ? submissionPayload.reason.trim()
                : "",
        };
        let captchaRequired = false;
        try {
            const token = await getClientToken();
            const requestBody = {
                reportScriptVersion: (SCRIPT_VERSION || "No detected").slice(0, 100),
                ...reportPayload,
                clientToken: token,
                ...(Number.isSafeInteger(playerCount) && playerCount >= 0
                    ? { roomPlayerCount: playerCount }
                    : {}),
                ...(verificationToken ? { turnstileToken: verificationToken } : {}),
            };
            const response = await fetch(
                useTestEndpoint ? TEST_REPORT_API_URL : REPORT_API_URL,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-Client-Token": token,
                    },
                    credentials: "include",
                    body: JSON.stringify(requestBody),
                }
            );
            const responseText = await response.text();
            let responseData = null;
            if (responseText) {
                try {
                    responseData = JSON.parse(responseText);
                } catch {
                    responseData = null;
                }
            }
            let serverMessage = "";
            if (typeof responseData === "string") {
                serverMessage = responseData.trim();
            } else if (responseData && typeof responseData === "object") {
                const message = responseData.message ?? responseData.error;
                serverMessage = typeof message === "string"
                    ? message.trim()
                    : message !== undefined && message !== null
                        ? JSON.stringify(message)
                        : typeof responseData.code === "string"
                            ? responseData.code
                            : responseText.trim();
            } else {
                serverMessage = responseText.trim();
            }
            const reportSucceeded = response.status === 201 &&
                responseData?.code === "KOUR_REPORT_API_REPORT_SUBMITTED" &&
                responseData?.success === true &&
                responseData?.message === "Report submitted successfully.";
            const captchaInitiallyRequired = response.status === 428 &&
                responseData?.code === "KOUR_REPORT_API_CAPTCHA_REQUIRED" &&
                responseData?.captcha?.provider === "turnstile";
            const captchaTokenRejected = Boolean(verificationToken) &&
                ((response.status === 403) ||
                    (response.status === 400 &&
                        responseData?.code === "KOUR_REPORT_API_INVALID_TURNSTILE_TOKEN"));
            captchaRequired = captchaInitiallyRequired || captchaTokenRejected;
            if (captchaRequired) {
                setVerificationStatus(
                    captchaTokenRejected
                        ? "The security check was rejected. Loading a fresh Turnstile…"
                        : "The server requires a security check. Loading Turnstile…"
                );
            } else if (reportSucceeded) {
                const reportId = normalizeReportId(responseData.reportId);
                if (!reportId) {
                    console.warn(
                        "[Kour Report] The API accepted the report but returned no usable reportId.",
                        responseData.reportId
                    );
                }
                const historyTargetKey = callPlayerKey !== null ? callPlayerKey : reportedPlayerKey;
                const historyTargetPlayer = historyTargetKey === null
                    ? null
                    : reportMatchState.players.get(String(historyTargetKey));
                const historyEntry = {
                    reportId,
                    clientToken: token,
                    target: String(reportPayload.target || "Unknown player").slice(0, 1000),
                    targetRawName: typeof historyTargetPlayer?.rawName === "string"
                        ? historyTargetPlayer.rawName.slice(0, 2000)
                        : "",
                    reporterRawName: typeof reportMatchState.localRawName === "string" &&
                        normalizePlayerName(reportMatchState.localRawName) === reportPayload.reporter
                        ? reportMatchState.localRawName.slice(0, 2000)
                        : "",
                    kind: callPlayerKey !== null ? "KBI call" : "Player report",
                    testMode: useTestEndpoint,
                    reporter: String(reportPayload.reporter || "No detected").slice(0, 1000),
                    reason: String(reportPayload.reason || ""),
                    roomId: String(reportPayload.roomId || "").slice(0, 1000),
                    sessionLink: String(reportPayload.sessionLink || "").slice(0, 1000),
                    endpoint: useTestEndpoint ? TEST_REPORT_API_URL : REPORT_API_URL,
                    submittedAt: Date.now(),
                };
                recordReportHistory(historyEntry);
                recordReportActivity(
                    historyEntry,
                    callPlayerKey !== null
                        ? "kbi-call"
                        : reminderType === "manual-report"
                            ? "manual-report"
                            : "player-report"
                );
                if (callPlayerKey !== null) {
                    const callLabel = useTestEndpoint ? "Test KBI call" : "KBI call";
                    const callSuccessMessage = reportId
                        ? `${callLabel} sent successfully. Report ID: ${reportId}.`
                        : `${callLabel} accepted, but no report ID was returned.`;
                    setCallKbiButtonState(callPlayerKey, "success", callSuccessMessage);
                    showUnityReportNotification(`<color=#4CAF50>${callSuccessMessage}</color>`);
                } else {
                    const reportLabel = useTestEndpoint ? "Test report" : "Report";
                    const reportSuccessMessage = reportId
                        ? `${reportLabel} sent successfully. Report ID: ${reportId}.`
                        : `${reportLabel} accepted, but no report ID was returned.`;
                    showUnityReportNotification(`<color=#4CAF50>${reportSuccessMessage}</color>`);
                    if (reportId) {
                        setReportSuccessStatus(reportLabel, reportId);
                    } else {
                        setReportFormStatus(reportSuccessMessage, "success");
                    }
                }
                showReportReminderOnce(reportPayload, callPlayerKey, reminderType);
            } else {
                const apiRateLimited = response.status === 429 ||
                    responseData?.code === "KOUR_REPORT_API_REPORT_COOLDOWN";
                const retryAfterSeconds = apiRateLimited
                    ? getRetryAfterSeconds(response)
                    : null;
                const retryMessage = retryAfterSeconds === null
                    ? ""
                    : ` Please try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}.`;
                const errorMessage = limitServerResponse(
                    `${serverMessage || `No response body received (HTTP ${response.status}).`}${retryMessage}`
                );
                if (callPlayerKey !== null) {
                    if (apiRateLimited && retryAfterSeconds !== null && retryAfterSeconds > 0) {
                        setCallKbiButtonState(
                            callPlayerKey,
                            "cooldown",
                            errorMessage,
                            retryAfterSeconds
                        );
                        showUnityReportNotification(
                            `<color=#f4c842>KBI request limit: try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}.</color>`
                        );
                    } else {
                        setCallKbiButtonState(callPlayerKey, "error", errorMessage);
                        showUnityReportNotification(`<color=#ed3434>${errorMessage}</color>`);
                    }
                } else {
                    setReportFormStatus(errorMessage, "error", "Server response:");
                }
            }
        } catch (error) {
            console.error("[Kour Report] Failed to submit report:", error);
            const message = error instanceof Error ? error.message : String(error);
            if (callPlayerKey !== null) {
                const errorNotice = `Unable to send the KBI call. ${message}`;
                setCallKbiButtonState(callPlayerKey, "error", errorNotice);
                showUnityReportNotification(`<color=#ed3434>${errorNotice}</color>`);
            } else {
                setReportFormStatus(`Unable to send the report. ${message}`);
            }
        } finally {
            resetReportCaptcha();
            reportSubmitting = false;
            reportSubmitButton.disabled = false;
            reportCancelButton.disabled = false;
        }
        if (captchaRequired) {
            pendingReportPayload = payload;
            pendingCallPlayerKey = callPlayerKey;
            if (callPlayerKey !== null) setCallKbiButtonState(callPlayerKey, "loading");
            void openVerificationDialog(callPlayerKey);
        }
    }
    /**
     * Identify editable targets so global shortcuts do not interrupt user input.
     * @param {KeyboardEvent} event Keyboard event being checked.
     * @returns {boolean} Whether the event originated in a text-entry control.
     * @see document keydown handler
     */
    /***************************************
     * Keyboard Shortcuts and Initialization
     ***************************************/
    function isTextEntry(event) {
        const activeTarget = reportShadowRoot?.activeElement || null;
        if (isEditableEventTarget(activeTarget) || reportTextFields?.has(activeTarget)) return true;
        const path = typeof event.composedPath === "function"
            ? event.composedPath()
            : [event.target];
        return (path || []).some((target) => isEditableEventTarget(target));
    }

    // Handle dialog dismissal and launcher shortcuts without hijacking text-entry keys.
    // @see isTextEntry
    // @see matchesOpenKey
    document.addEventListener("keydown", (event) => {
        if (capturingKeySetting) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") {
                capturingKeySetting = null;
                settingsKeyHint.hidden = true;
                updateSettingsKeyLabels();
                return;
            }
            if (event.key && event.key !== "Unidentified") {
                launcherSettings[capturingKeySetting] = event.code || event.key;
                updateSettingsKeyLabels();
                settingsKeyHint.hidden = true;
                capturingKeySetting = null;
                persistLauncherSettings();
            }
            return;
        }
        if (launcherShortcutActive && event.key === "Escape") {
            event.preventDefault();
            finishLauncherShortcutWheel(false);
            return;
        }
        if (event.key === "Escape" && !changelogLayer.hidden) {
            hidePopup(changelogLayer);
            changelogButton.focus();
            return;
        }
        if (event.key === "Escape" && !settingsLayer.hidden) {
            closeSettingsDialog();
            return;
        }
        if (event.key === "Escape" && !updateMethodLayer.hidden) {
            hidePopup(updateMethodLayer);
            updateButton.focus();
            return;
        }
        if (event.key === "Escape" && !infoDialogLayer.hidden) {
            hidePopup(infoDialogLayer);
            infoButton.focus();
            return;
        }
        if (event.key === "Escape" && !menuCallLinkLayer.hidden) {
            const pendingPlayer = pendingMenuCallPlayer;
            pendingMenuCallPlayer = null;
            hidePopup(menuCallLinkLayer);
            focusCallKbiButton(pendingPlayer ? pendingPlayer.key : MENU_CALL_PLAYER_KEY);
            return;
        }
        if (event.key === "Escape" && !menuCallWarningLayer.hidden) {
            hidePopup(menuCallWarningLayer);
            menuCallKbiButton.focus();
            return;
        }
        if (event.key === "Escape" && !verificationLayer.hidden) {
            cancelVerification();
            return;
        }
        if (event.key === "Escape" && !reportDetailsLayer.hidden) {
            closeReportDetails();
            return;
        }
        if (event.key === "Escape" && !messagesSettingsLayer.hidden) {
            if (!messagesClearConfirmation.hidden) {
                messagesClearConfirmation.hidden = true;
                messagesClearButton.focus();
            } else if (!messagesIdentity.hidden) {
                cancelMessageIdentityEdit();
            } else {
                closeMessageSettings();
            }
            return;
        }
        if (event.key === "Escape" && !messagesLayer.hidden) {
            closeMessages();
            return;
        }
        if (event.key === "Escape" && !reportHistoryLayer.hidden) {
            hidePopup(reportHistoryLayer);
            reportHistoryButton.focus();
            return;
        }
        if (event.key === "Escape" && !reportDialogLayer.hidden) {
            if (!reportReasonOptions.hidden) {
                setReasonMenuOpen(false);
                reportReason.focus();
                return;
            }
            closeReportDialog();
            return;
        }
        if (event.key === "Escape" && panel.classList.contains("open")) {
            setOpen(false);
            return;
        }
        if (launcherShortcutActive) return;
        if (event.repeat || isTextEntry(event) || !settingsLayer.hidden) return;
        if (matchesKey(event, launcherSettings.toggleIconKey)) {
            event.preventDefault();
            event.stopPropagation();
            launcherSettings.hideBothButtons = !launcherSettings.hideBothButtons;
            applyLauncherSettings();
            persistLauncherSettings();
            return;
        }
        if (matchesOpenKey(event)) {
            event.preventDefault();
            event.stopPropagation();
            if (launcherSettings.openKey === "Alt" ||
                launcherSettings.openKey === "AltLeft" ||
                launcherSettings.openKey === "AltRight") {
                beginLauncherShortcutWheel();
            } else {
                setOpen(!panel.classList.contains("open"));
            }
        }
    }, true);

    document.addEventListener("keyup", (event) => {
        if (!launcherShortcutActive || !matchesOpenKey(event)) return;
        event.preventDefault();
        event.stopPropagation();
        finishLauncherShortcutWheel(true);
    }, true);

    document.addEventListener("pointermove", (event) => {
        if (launcherShortcutActive) {
            updateLauncherShortcutSelection(event.clientX, event.clientY);
        }
    }, true);

    window.addEventListener("blur", () => {
        finishLauncherShortcutWheel(false);
    });

    window.addEventListener("resize", () => {
        updatePlayerListHeight();
        updateLauncherQuickCallPosition();
        if (launcherShortcutActive) positionLauncherShortcutWheel();
        if (!manualReportHelpTooltip.hidden) positionManualReportHelpTooltip();
        if (!settingsTestModeTooltip.hidden) positionTestModeTooltip();
        if (!settingsAnnouncementTooltip.hidden) positionAnnouncementTooltip();
        if (!settingsClientTokenTooltip.hidden) positionClientTokenTooltip();
        if (launcherSettings.left === null || launcherSettings.top === null) return;
        applyLauncherSettings();
        persistLauncherSettings();
    });

    void pollCustomMessages();
    window.setInterval(pollCustomMessages, MESSAGE_POLL_INTERVAL_MS);
    void checkApiHealth(true);
    window.setInterval(() => {
        if (document.visibilityState === "visible") void checkApiHealth();
    }, API_HEALTH_CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            void pollCustomMessages();
            void checkApiHealth();
        }
    });

    void checkForUpdates();
    }

    // Wait for the page body before attaching the launcher and shadow-root UI.
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initialize, { once: true });
    } else {
        initialize();
    }
})();