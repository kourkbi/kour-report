// ==UserScript==
// @name         Kour Report
// @namespace    https://kour.io/
// @version      1.0.5
// @description  In-game player reporting tool for Kour.io. Join the KBI Discord: https://discord.gg/Ke3a7ZZWMd
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

    const PLAYER_AVATAR = "https://raw.githubusercontent.com/kourkbi/kour-report/main/assets/menu/player-avatar.jpg";
    const DISCORD_URL = "https://discord.gg/Ke3a7ZZWMd";

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
    const reportMatchState = { active: false, localId: null, localName: "", players: new Map() };
    let onReportMatchPlayersUpdated = null;
    let activeReportMatchSocket = null;

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
        reportMatchState.active = false;
        reportMatchState.localId = null;
        reportMatchState.localName = "";
        reportMatchState.players.clear();
        notifyReportMatchPlayers();
    }

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
            if (name && name.toLowerCase() !== "you") reportMatchState.localName = name;
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
                reportMatchState.active = true;
                reportMatchState.localId = getReportMatchPlayerId(fields.get(0xfe)) ?? null;
                reportMatchState.localName = "";
                reportMatchState.players.clear();
                const roster = fields.get(0xf9);
                if (roster instanceof Map) {
                    roster.forEach((stats, id) => rememberReportMatchPlayer(id, stats));
                }
            } else if (type === "selfJoin") {
                reportMatchState.active = true;
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
            } else if (type === "leave") {
                const id = getReportMatchPlayerId(fields.get(0xfe));
                if (id !== undefined && id !== null) {
                    reportMatchState.players.delete(String(id));
                    if (String(id) === String(reportMatchState.localId)) {
                        reportMatchState.localId = null;
                        reportMatchState.localName = "";
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
    let installedScriptVersion = "";
    try {
        if (typeof GM_info !== "undefined" && GM_info && GM_info.script) {
            installedScriptVersion = GM_info.script.version || "";
        } else if (typeof GM !== "undefined" && GM && GM.info && GM.info.script) {
            installedScriptVersion = GM.info.script.version || "";
        }
    } catch (error) {
        console.warn("[Kour Report] Could not read the installed userscript version:", error);
    }
    const SCRIPT_VERSION = installedScriptVersion && installedScriptVersion !== "dev"
        ? installedScriptVersion
        : "1.0.5";
    const GITHUB_REPOSITORY_URL = "https://github.com/kourkbi/kour-report";
    const GITHUB_SCRIPT_FILE_URL = "https://github.com/kourkbi/kour-report/blob/main/kour-report.js";
    const GREASYFORK_SCRIPT_URL = "https://greasyfork.org/scripts/602206-kour-report";
    // Keep version.json synchronized with @version when publishing.
    const VERSION_URL = "https://raw.githubusercontent.com/kourkbi/kour-report/main/version.json";
    const WINDOW_SIZE_SCALE = 1.08;
    const MAX_REPORT_REASON_LENGTH = 250;
    const MAX_SERVER_RESPONSE_LENGTH = 1200;
    const UI_COLORS = Object.freeze({
        white: "#fff",
        ink: "#111",
    });
    let reportTextFieldFocused = false;
    const shieldReportTextFieldKeys = (event) => {
        if (reportTextFieldFocused && event.key !== "Escape") {
            event.stopImmediatePropagation();
        }
    };
    ["keydown", "keyup", "keypress"].forEach((eventType) => {
        window.addEventListener(eventType, shieldReportTextFieldKeys, true);
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
                --scrollbar-thumb: rgba(190, 190, 190, 0.52);
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
            * { box-sizing: border-box; }
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
            .top-action-button svg { width: 15px; height: 15px; fill: currentColor; }
            .top-action-button .info-icon {
                display: grid; width: 14px; height: 14px; place-items: center;
                border: 1.5px solid currentColor; border-radius: 50%; font: 800 10px/1 Arial, sans-serif;
            }
            .settings-button {
                width: auto; height: auto;
            }
            .settings-button svg { width: 15px; height: 15px; }
            .menu-footer { display: flex; flex-direction: column; align-items: center; gap: 9px; margin-top: 14px; }
            .menu-footer-actions { display: flex; justify-content: center; gap: 8px; }
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
                display: flex; width: 100%; align-self: stretch; align-items: center; justify-content: center; gap: 5px;
                margin: -5px 0 0; color: #858589; font: 600 10px/1 Arial, sans-serif; text-align: center;
            }
            .menu-footer-version-separator {
                color: #626267; font-size: 13px;
            }
            .close {
                position: relative; z-index: 0;
                width: 32px; height: 32px; border: 0; border-radius: var(--radius-control);
                color: var(--color-white); background: transparent; cursor: pointer; font-size: 24px; font-weight: 800; line-height: 1;
            }
            .close::before {
                position: absolute; z-index: -1; inset: 0; border-radius: inherit;
                background: var(--color-close); content: ""; transition: transform var(--button-press-duration) ease;
            }
            .close:hover::before { transform: scale(1.08); }
            .close:active::before, .close.is-pressed::before { background: var(--button-press-background); transform: scale(1); }
            .content { min-height: 0; flex: 1; overflow: auto; padding: 14px 15px 16px; }
            .players-heading {
                margin: 0 0 10px; color: #d7d7d9; font-size: 13px; font-weight: 800;
                text-align: center; text-transform: uppercase;
            }
            .players-heading[hidden] { display: none; }
            .player-list {
                display: flex; flex-direction: column; gap: 5px; overflow-x: hidden; overflow-y: auto;
                scrollbar-color: var(--scrollbar-thumb) transparent; scrollbar-width: thin;
            }
            .player-list::-webkit-scrollbar { width: 7px; }
            .player-list::-webkit-scrollbar-track { background: transparent; }
            .player-list::-webkit-scrollbar-thumb {
                border: 0; border-radius: 0; background: var(--scrollbar-thumb);
                box-shadow: none; background-clip: border-box;
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
                width: 79px; min-width: 79px; height: 79px; min-height: 79px;
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
            .popup-layer:not(.is-closing) > .settings-dialog,
            .popup-layer:not(.is-closing) > .report-dialog,
            .popup-layer:not(.is-closing) > .verification-dialog,
            .popup-layer:not(.is-closing) > .menu-call-link-dialog,
            .popup-layer:not(.is-closing) > .update-method-dialog {
                animation: var(--animation-popup-enter);
            }
            .popup-layer.is-closing {
                pointer-events: none; animation: popup-backdrop-exit var(--duration-exit) ease-in both;
            }
            .popup-layer.is-closing > .info-dialog,
            .popup-layer.is-closing > .settings-dialog,
            .popup-layer.is-closing > .report-dialog,
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
            .update-method-layer { z-index: 6; }
            .update-method-layer[hidden] { display: none; }
            .update-method-dialog {
                display: flex; width: min(440px, 100%); max-height: calc(100vh - 36px);
                flex-direction: column; overflow: hidden; border: 1px solid var(--color-border-dialog);
                border-radius: var(--radius-dialog); color: var(--color-text-primary);
                background: var(--color-menu); box-shadow: var(--shadow-dialog-strong);
            }
            .update-method-header {
                display: flex; min-height: 58px; align-items: center; gap: 11px;
                padding: 9px 14px; background: var(--color-menu-header);
            }
            .update-method-close {
                width: 32px; height: 32px; flex: 0 0 32px; border: 0;
                border-radius: var(--radius-control); color: var(--color-white);
                background: var(--color-close); cursor: pointer; font-size: 22px; font-weight: 800;
            }
            .update-method-title { margin: 0; color: var(--color-text-heading); font-size: 19px; font-weight: 850; }
            .update-method-content {
                display: flex; max-height: min(560px, calc(100vh - 112px)); flex-direction: column;
                gap: 11px; overflow-y: auto; padding: 16px;
                scrollbar-color: var(--scrollbar-thumb) transparent; scrollbar-width: thin;
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
                display: flex; min-height: 58px; align-items: center; gap: 11px;
                padding: 9px 14px; background: var(--color-menu-header);
            }
            .settings-title { margin: 0; font-size: 20px; font-weight: 850; }
            .settings-close {
                width: 32px; height: 32px; border: 0; border-radius: var(--radius-control);
                color: var(--color-white); background: var(--color-close); cursor: pointer; font-size: 22px; font-weight: 800;
            }
            .settings-content {
                min-height: 0; overflow: auto; padding: 12px 18px 17px;
                scrollbar-color: var(--scrollbar-thumb) transparent; scrollbar-width: thin;
            }
            .settings-row {
                display: flex; min-height: 58px; align-items: center; justify-content: space-between;
                gap: 16px; padding: 8px 5px; border-bottom: 1px solid var(--color-surface-muted);
            }
            .settings-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
            .settings-label { color: var(--color-text-bright); font-size: 14px; font-weight: 800; }
            .settings-default { color: #77777b; font-size: 10px; font-weight: 700; }
            .tooltip {
                position: fixed; z-index: 10; width: var(--tooltip-width);
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
                border: 0; border-radius: var(--radius-medium); color: var(--color-white); background: #bd3434; cursor: pointer;
                font: 800 28px/1 "Trebuchet MS", Arial, sans-serif; transform: translateY(-50%);
            }
            .info-dialog-close:hover { background: #d34343; }
            .button-press-held.info-dialog-close { transform: translateY(-50%) scale(var(--button-press-scale)) !important; }
            .info-dialog-heading { position: relative; z-index: 1; }
            .info-dialog-title { margin: 0; color: var(--color-white); font-size: 30px; font-weight: 850; line-height: 1.1; text-shadow: 0 2px 5px var(--color-deep-shadow); }
            .info-dialog-subtitle {
                margin: 5px 0 0; color: var(--color-white); font: 800 16px/1.25 var(--font-decorative);
                text-shadow: 0 2px 5px var(--color-deep-shadow);
            }
            .info-dialog-content {
                min-height: 0; overflow: auto; padding: 23px 27px 27px;
                scrollbar-color: var(--scrollbar-thumb) transparent; scrollbar-width: thin;
            }
            .info-dialog-content::-webkit-scrollbar { width: 7px; }
            .info-dialog-content::-webkit-scrollbar-track { background: transparent; }
            .info-dialog-content::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); }
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
            }
            .report-field input::placeholder, .report-field textarea::placeholder { color: #828286; opacity: 1; }
            .report-field input:focus, .report-field textarea:focus {
                border-color: #77777d; background: #29292d;
            }
            .report-field textarea {
                min-height: 92px; resize: vertical; line-height: 1.45;
                scrollbar-color: var(--scrollbar-thumb) transparent; scrollbar-width: thin;
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
            .reason-options {
                position: absolute; z-index: 3; top: calc(100% + 4px); right: 0; left: 0;
                max-height: 220px; overflow-y: auto; overflow-x: hidden; padding: 4px; border: 1px solid #4a4a4d;
                border-radius: var(--radius-card); background: #3b3b3e; box-shadow: 0 8px 20px var(--color-shadow);
                scrollbar-color: var(--scrollbar-thumb) transparent; scrollbar-width: thin;
                transform-origin: top center; animation: reason-options-enter var(--duration-dropdown) ease-out both;
            }
            .reason-options::-webkit-scrollbar, .report-field textarea::-webkit-scrollbar { width: 7px; }
            .reason-options::-webkit-scrollbar-track, .report-field textarea::-webkit-scrollbar-track { background: transparent; }
            .reason-options::-webkit-scrollbar-thumb, .report-field textarea::-webkit-scrollbar-thumb {
                border: 0; border-radius: 0; background: var(--scrollbar-thumb);
                box-shadow: none; background-clip: border-box;
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
            @media (prefers-reduced-motion: reduce) {
                .info-dialog, .settings-dialog, .report-dialog, .verification-layer, .verification-dialog, .update-method-dialog, .reason-options,
                .popup-layer.is-closing, .popup-layer.is-closing > .info-dialog, .popup-layer.is-closing > .settings-dialog,
                .popup-layer.is-closing > .report-dialog, .popup-layer.is-closing > .verification-dialog, .popup-layer.is-closing > .update-method-dialog,
                .popup-layer.is-closing > .menu-call-link-dialog,
                .popup-layer:not(.is-closing), .popup-layer:not(.is-closing) > .info-dialog,
                .popup-layer:not(.is-closing) > .settings-dialog, .popup-layer:not(.is-closing) > .report-dialog,
                .popup-layer:not(.is-closing) > .verification-dialog, .popup-layer:not(.is-closing) > .update-method-dialog,
                .popup-layer:not(.is-closing) > .menu-call-link-dialog,
                .panel.open, .panel.open .main, .panel.is-closing, .panel.is-closing .main { animation: none; }
                .button-pressable, .reason-control,
                .launcher-call-kbi.button-pressable { transition: none; }
            }
            .report-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 3px; }
            .report-dialog-button {
                min-height: 36px; padding: 0 13px; border: 0; border-radius: var(--radius-card);
                color: var(--color-white); background: var(--color-control); cursor: pointer; font-size: 13px; font-weight: 800;
                transform: scale(1);
            }
            .report-dialog-button.submit { background: var(--gradient-report); }
            .report-dialog-button:disabled { opacity: .55; cursor: not-allowed; filter: none; }
            .report-dialog-button:hover { filter: brightness(1.08); }
            .report-form-status {
                min-width: 0; max-height: 88px; overflow: auto; margin: 0; padding: 3px 0; color: var(--color-text-primary);
                font: 800 14px/1.35 Arial, Helvetica, sans-serif;
                letter-spacing: 0; overflow-wrap: anywhere; word-break: break-word; white-space: pre-wrap;
                scrollbar-color: var(--scrollbar-thumb) transparent; scrollbar-width: thin;
            }
            .status-prefix { font-weight: 900; }
            .status-prefix[data-kind="error"], .verification-status .status-prefix[data-kind="error"] { color: var(--color-status-error); }
            .status-prefix[data-kind="success"], .verification-status .status-prefix[data-kind="success"] { color: var(--color-status-success); }
            .status-prefix[data-kind="info"], .verification-status .status-prefix[data-kind="info"] { color: var(--color-text-secondary); }
            .report-form-status[data-kind="error"] .status-message { color: var(--color-white); }
            .report-form-status::-webkit-scrollbar { width: 7px; }
            .report-form-status::-webkit-scrollbar-track { background: transparent; }
            .report-form-status::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); }
            .report-form-status[hidden] { display: none; }
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
                            <span>v${SCRIPT_VERSION}</span>
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
                            <input id="menu-call-room-link" type="text" autocomplete="url" aria-describedby="menu-call-link-description" placeholder="https://kour.io/#ABC123">
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
                    <header class="update-method-header">
                        <button class="update-method-close" type="button" aria-label="Close update options">×</button>
                        <h2 class="update-method-title" id="update-method-title">Choose an update method</h2>
                    </header>
                    <div class="update-method-content">
                        <p class="update-method-description">Choose how you want to get the latest version of Kour Report.</p>
                        <a class="update-method-option recommended" href="${GREASYFORK_SCRIPT_URL}" target="_blank" rel="noopener noreferrer">
                            <span class="update-method-icon" aria-hidden="true">
                                <img src="https://raw.githubusercontent.com/denilsonsa/denilsonsa.github.io/master/icons/GreasyFork.svg" alt="">
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
                        <img src="https://raw.githubusercontent.com/kourkbi/kour-report/main/assets/menu/info-dialog-banner.jpg" alt="">
                        <button class="info-dialog-close" type="button" aria-label="Close information">×</button>
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
                            <a class="info-dialog-github" href="https://github.com/kourkbi/kour-report" target="_blank" rel="noopener noreferrer">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .9a11.1 11.1 0 0 0-3.51 21.63c.56.1.76-.24.76-.54v-2.08c-3.1.67-3.75-1.32-3.75-1.32-.51-1.29-1.24-1.63-1.24-1.63-1.01-.69.08-.68.08-.68 1.12.08 1.71 1.15 1.71 1.15 1 .1.98 2.2 3.34 1.57.1-.72.39-1.21.71-1.49-2.48-.28-5.09-1.24-5.09-5.52 0-1.22.44-2.22 1.15-3-.12-.28-.5-1.42.11-2.96 0 0 .94-.3 3.05 1.15a10.6 10.6 0 0 1 5.55 0c2.12-1.44 3.05-1.15 3.05-1.15.61 1.54.23 2.68.11 2.96.72.78 1.15 1.78 1.15 3 0 4.29-2.61 5.23-5.1 5.51.4.35.76 1.02.76 2.06v3.06c0 .3.2.65.77.54A11.1 11.1 0 0 0 12 .9Z"/></svg>
                                <span>GitHub</span>
                            </a>
                        </div>
                    </div>
                </section>
            </div>
            <div class="settings-layer popup-layer" hidden>
                <section class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
                    <header class="settings-header">
                        <button class="settings-close" type="button" aria-label="Close settings">×</button>
                        <h2 class="settings-title" id="settings-title">Kour Report Settings</h2>
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
                                <span class="settings-label">Hide both Report and Call KBI buttons</span>
                                <span class="settings-default">Default: Off</span>
                            </span>
                            <input class="settings-checkbox" data-setting="hideBothButtons" type="checkbox" aria-label="Hide both Report and Call KBI buttons">
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
                                <span class="settings-default">Default: 79 px</span>
                            </label>
                            <span class="settings-range-group">
                                <input class="settings-range" id="settings-size" data-setting="size" type="range" min="44" max="140" step="1">
                                <output class="settings-value" data-value="size">79 px</output>
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
                        <p class="settings-key-hint" role="status" hidden></p>
                        <button class="settings-reset" type="button">RESET DEFAULT</button>
                    </div>
                </section>
                <div class="tooltip settings-warning-tooltip" data-hide-icon-warning role="tooltip" hidden></div>
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
                            <input id="report-target" name="target" type="text" required>
                        </div>
                        <div class="report-field">
                            <label for="report-session-link">Room link</label>
                            <input id="report-session-link" name="sessionLink" type="text" placeholder="https://kour.io/#ABC123" autocomplete="url" required>
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
                            <textarea id="report-details" aria-describedby="report-details-count" placeholder="Optional: add details or evidence."></textarea>
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
                <p class="verification-description">Complete this check to send your report.</p>
                <div class="verification-widget"></div>
                <p class="verification-status" role="status" aria-live="polite"></p>
                <div class="verification-actions">
                    <button class="report-dialog-button cancel-verification" type="button">Cancel</button>
                </div>
            </section>
        </div>
    `;

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
        width: "79px",
        height: "79px",
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
    launcherShortcutHint.textContent = "Choose an option, then release Alt";
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
        const bounds = launcher.getBoundingClientRect();
        activeLauncherDrag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            left: bounds.left,
            top: bounds.top,
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
        const left = Math.min(
            Math.max(0, window.innerWidth - launcher.offsetWidth),
            Math.max(0, activeLauncherDrag.left + deltaX)
        );
        const top = Math.min(
            Math.max(0, window.innerHeight - launcher.offsetHeight),
            Math.max(0, activeLauncherDrag.top + deltaY)
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
            const bounds = launcher.getBoundingClientRect();
            launcherSettings.left = bounds.left;
            launcherSettings.top = bounds.top;
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
        color: "#fff",
        background: "#f01444",
        font: "800 13px/1 Arial, sans-serif",
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
    const settingsKeyHint = shadow.querySelector(".settings-key-hint");
    const settingsResetButton = shadow.querySelector(".settings-reset");
    const settingsInputs = {
        moveIcon: shadow.querySelector('[data-setting="moveIcon"]'),
        hideIcon: shadow.querySelector('[data-setting="hideIcon"]'),
        hideCallIcon: shadow.querySelector('[data-setting="hideCallIcon"]'),
        hideBothButtons: shadow.querySelector('[data-setting="hideBothButtons"]'),
        opacity: shadow.querySelector('[data-setting="opacity"]'),
        size: shadow.querySelector('[data-setting="size"]'),
    };
    shadow.querySelectorAll(".contributor-avatar").forEach((avatar) => {
        avatar.src = PLAYER_AVATAR;
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
    const reportReasonLabel = shadow.querySelector(".reason-trigger-label");
    const reportReasonOptions = shadow.querySelector(".reason-options");
    const reportReasonButtons = [...shadow.querySelectorAll(".reason-option")];
    const reportDetails = shadow.querySelector("#report-details");
    const reportDetailsCount = shadow.querySelector("#report-details-count");
    const reportCombinedReason = shadow.querySelector("#report-combined-reason");
    const reportFormStatus = reportForm.querySelector(".report-form-status");
    const reportSubmitButton = reportForm.querySelector('button[type="submit"]');
    const reportCancelButton = shadow.querySelector(".cancel-report");
    const reportDialogAvatar = shadow.querySelector(".report-dialog-avatar");
    const verificationLayer = shadow.querySelector(".verification-layer");
    const verificationWidget = shadow.querySelector(".verification-widget");
    const verificationStatus = shadow.querySelector(".verification-status");
    const verificationCancelButton = shadow.querySelector(".cancel-verification");
    let selectedReportReason = "";
    let captchaWidgetId = null;
    let captchaScriptPromise = null;
    let captchaInProgress = false;
    let captchaAttemptId = 0;
    let pendingReportPayload = null;
    let pendingCallPlayerKey = null;
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
    const exitTimers = new WeakMap();
    let heldPressButton = null;
    let heldPressControl = null;

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
        opacity: 100,
        size: 79,
        openKey: "AltLeft",
        toggleIconKey: "AltRight",
        left: null,
        top: null,
    };
    let launcherSettings = { ...DEFAULT_LAUNCHER_SETTINGS };
    let capturingKeySetting = null;
    let activeLauncherDrag = null;
    let settingsTooltipCursorX = 0;
    let settingsTooltipCursorY = 0;

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
                opacity: Number.isFinite(savedSettings.opacity)
                    ? Math.min(100, Math.max(10, savedSettings.opacity))
                    : DEFAULT_LAUNCHER_SETTINGS.opacity,
                size: Number.isFinite(savedSettings.size)
                    ? Math.min(140, Math.max(44, [88, 66, 64, 52, 44].includes(savedSettings.size) ? 79 : savedSettings.size))
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
        return key === "Alt"
            ? event.key === "Alt"
            : event.code === key || event.key.toLowerCase() === key.toLowerCase();
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
        settingsHideIconWarning.textContent =
            `Warning: With the buttons hidden, press ${toggleIconKeyLabel} to show them again.\nPress ${openKeyLabel} to open or close the menu directly.`;
        if (!settingsHideIconWarning.hidden) positionSettingsTooltip();
    }

    /**
     * Keep the hide-icon warning inside the visible browser window.
     * @see showSettingsTooltipAt
     * @see updateSettingsKeyLabels
     */
    function positionSettingsTooltip() {
        const margin = 12;
        const offset = 14;
        const bounds = settingsHideIconWarning.getBoundingClientRect();
        let left = settingsTooltipCursorX + offset;
        let top = settingsTooltipCursorY + offset;
        if (left + bounds.width > window.innerWidth - margin) {
            left = settingsTooltipCursorX - bounds.width - offset;
        }
        if (top + bounds.height > window.innerHeight - margin) {
            top = settingsTooltipCursorY - bounds.height - offset;
        }
        const maxLeft = Math.max(margin, window.innerWidth - bounds.width - margin);
        const maxTop = Math.max(margin, window.innerHeight - bounds.height - margin);
        settingsHideIconWarning.style.left = `${Math.min(maxLeft, Math.max(margin, left))}px`;
        settingsHideIconWarning.style.top = `${Math.min(maxTop, Math.max(margin, top))}px`;
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
        const launcherBounds = launcherSettings.hideIcon
            ? {
                right: launcherSettings.left !== null && launcherSettings.top !== null
                    ? launcherSettings.left + buttonWidth
                    : window.innerWidth,
                top: launcherSettings.left !== null && launcherSettings.top !== null
                    ? launcherSettings.top
                    : (window.innerHeight - buttonHeight) / 2,
            }
            : launcher.getBoundingClientRect();
        const callIconSize = Math.min(34, Math.round(buttonWidth * 0.38));
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
        launcherQuickCall.style.left = `${launcherBounds.right - buttonWidth}px`;
        launcherQuickCall.style.top = `${launcherBounds.top - buttonHeight}px`;
        launcherQuickCall.style.right = "auto";

        const shouldShow = !launcherSettings.hideCallIcon &&
            !launcherSettings.hideBothButtons &&
            !launcherShortcutActive &&
            !activeLauncherDrag &&
            !panel.classList.contains("open");
        if (shouldShow) {
            launcherQuickCall.classList.add("is-visible");
            launcherQuickCall.setAttribute("aria-hidden", "false");
            launcherQuickCall.tabIndex = 0;
        } else {
            launcherQuickCall.classList.remove("is-visible");
            launcherQuickCall.setAttribute("aria-hidden", "true");
            launcherQuickCall.tabIndex = -1;
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
        launcherShortcutMenuOption.classList.remove("is-selected");
        launcherShortcutCallOption.classList.remove("is-selected");
        launcherShortcutMenuOption.setAttribute("aria-pressed", "false");
        launcherShortcutCallOption.setAttribute("aria-pressed", "false");
        updateLauncherQuickCallPosition();
        if (!commit) return;
        if (selectedAction === "call") {
            startKbiCall(null, getCurrentReportSessionLink(), { requireDetectedRoom: true });
        } else if (selectedAction === "menu") {
            setOpen(!panel.classList.contains("open"));
        }
    }

    function updateLauncherHoverRelationship() {
        const launcherHovered = launcher.matches(":hover") || document.activeElement === launcher;
        const callVisible = launcherQuickCall.classList.contains("is-visible");
        const callHovered = callVisible &&
            (launcherQuickCall.matches(":hover") || shadow.activeElement === launcherQuickCall);
        launcher.style.transformOrigin = "100% 0%";
        launcherQuickCall.style.transformOrigin = "100% 100%";
        launcherQuickCall.classList.toggle("is-hovered", callHovered);
        launcherQuickCall.classList.toggle("neighbor-hover", launcherHovered && !callHovered && callVisible);
        launcher.style.borderTopColor = callHovered ? "transparent" : "#242424";
        launcherReportSeam.style.opacity = callHovered ? "1" : "0";
        launcher.style.transform = callHovered
            ? "scale(1)"
            : launcherHovered && callVisible ? "scale(1.12)" : "scale(1)";
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
        launcher.style.display = launcherSettings.hideIcon || launcherSettings.hideBothButtons
            ? "none"
            : "flex";
        launcher.style.cursor = launcherSettings.moveIcon ? "grab" : "pointer";
        launcherIcon.setAttribute("width", String(iconSize));
        launcherIcon.setAttribute("height", String(iconSize));
        launcherIcon.style.flex = `0 0 ${iconSize}px`;
        launcherLabel.style.fontSize = `${Math.max(9, Math.round(size * 0.17))}px`;
        if (launcherSettings.left !== null && launcherSettings.top !== null) {
            const maxLeft = Math.max(0, window.innerWidth - size);
            const maxTop = Math.max(0, window.innerHeight - size);
            launcherSettings.left = Math.min(maxLeft, Math.max(0, launcherSettings.left));
            launcherSettings.top = Math.min(maxTop, Math.max(0, launcherSettings.top));
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
        settingsInputs.opacity.value = String(launcherSettings.opacity);
        settingsInputs.size.value = String(launcherSettings.size);
        shadow.querySelector('[data-value="opacity"]').textContent = `${launcherSettings.opacity}%`;
        shadow.querySelector('[data-value="size"]').textContent = `${launcherSettings.size} px`;
        updateSettingsKeyLabels();
        updateLauncherQuickCallPosition();
    }
    applyLauncherSettings();

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
    addButtonPressAnimation(closeButton);
    [discordButton, githubButton, infoButton, settingsButton, updateButton, updateMethodCloseButton, ...updateMethodOptions].forEach((button) => {
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
    addButtonPressAnimation(infoDialogCloseButton);
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
        hidePopup(settingsLayer);
        settingsButton.focus();
    }

    // Settings handlers manage the dialog, hide-icon warning, and shortcut capture.
    settingsButton.addEventListener("click", () => {
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
    settingsCloseButton.addEventListener("click", closeSettingsDialog);
    settingsLayer.addEventListener("click", (event) => {
        if (event.target === settingsLayer) closeSettingsDialog();
    });
    [settingsCloseButton, ...Object.values(settingsKeyButtons), settingsResetButton].forEach((button) => {
        addButtonPressAnimation(button);
    });
    [
        settingsInputs.moveIcon,
        settingsInputs.hideIcon,
        settingsInputs.hideCallIcon,
        settingsInputs.hideBothButtons,
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
        if (captchaInProgress || reportSubmitting ||
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
            reporter: getReportIdentity().reporter || "Not detected",
            target: player ? (player.name || "Unknown player") : "No player selected",
            reason: "This user is calling KBI",
            roomId: parsedSessionLink.roomId,
            sessionLink: parsedSessionLink.url.href,
        };
        setCallKbiButtonState(key, "loading");
        void openVerificationDialog(key);
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
        hidePopup(verificationLayer);
        removeCaptchaWidget();
        verificationStatus.textContent = "";
        verificationStatus.removeAttribute("data-kind");
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
            script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
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
     * Gate either report type on Turnstile and submit only from its token callback.
     * The attempt ID invalidates callbacks from a canceled or superseded widget.
     * @param {string|null} [callPlayerKey] KBI button key, or null for a manual report.
     * @see loadCaptchaApi
     * @see sendReport
     * @see resetReportCaptcha
     */
    async function openVerificationDialog(callPlayerKey = null) {
        if (captchaInProgress) return;
        const attemptId = captchaAttemptId + 1;
        captchaAttemptId = attemptId;
        captchaInProgress = true;
        pendingCallPlayerKey = callPlayerKey;
        showPopup(verificationLayer);
        setVerificationStatus("Loading security check…");
        verificationCancelButton.focus();

        try {
            const turnstile = await loadCaptchaApi();
            if (!captchaInProgress || captchaAttemptId !== attemptId) return;
            const renderedWidgetId = turnstile.render(verificationWidget, {
                sitekey: "0x4AAAAAAFh9F7Gz7tkh9rAD",
                theme: "dark",
                callback: (token) => {
                    if (!captchaInProgress || captchaAttemptId !== attemptId ||
                        !token || !pendingReportPayload) return;
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
            resetReportCaptcha();
            const message = error instanceof Error ? error.message : "The security check could not be loaded.";
            if (callKey !== null) {
                setCallKbiButtonState(callKey, "error", message);
            } else {
                setReportFormStatus(message, "error");
                reportSubmitButton.focus();
            }
        }

        function failVerification(message) {
            if (!captchaInProgress || captchaAttemptId !== attemptId) return;
            const callKey = pendingCallPlayerKey;
            resetReportCaptcha();
            if (callKey !== null) {
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
    function getReportIdentity() {
        let reporter = "";
        const normalizeReporter = (value) => {
            if (typeof value !== "string") return "";
            const normalized = value.replace(/<[^>]*>/g, "").trim();
            return normalized && normalized.toLowerCase() !== "you" &&
                normalized.toLowerCase() !== "game default"
                ? normalized
                : "";
        };
        try {
            reporter = normalizeReporter(window.localStorage.getItem("playerNickname"));
        } catch (error) {
            console.warn("[Kour Report] Could not read the saved player nickname:", error);
        }
        if (!reporter) {
            const matchName = normalizeReporter(reportMatchState.localName);
            if (matchName) reporter = matchName;
        }
        if (!reporter) {
            try {
                const gameWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
                reporter = normalizeReporter(
                    gameWindow.firebase?.auth?.()?.currentUser?.displayName
                );
            } catch (error) {
                console.warn("[Kour Report] Could not read the signed-in player name:", error);
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
                ontimeout: () => finish(reject, new Error("The version check timed out.")),
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
                        () => finish(reject, new Error("The version check timed out.")),
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

        updateLabel.textContent = `New update available: v${latestVersion}`;
        updateDetails.textContent = updateManifest.details.trim();
        updateDetails.hidden = updateDetails.textContent.length === 0;
        updateDetails.title = updateDetails.textContent;
        updateNotice.hidden = false;
        updateBadge.style.display = "grid";
        launcher.setAttribute("aria-label", "Open Kour Report menu; new update available");
        launcher.title = "Open Kour Report - new update available";
        notifyUnityWhenReady("<color=#4CAF50>New report script update!</color>");
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
        reportDialogAvatar.src = PLAYER_AVATAR;
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
    [reportTarget, reportSessionLink, reportDetails].forEach((field) => {
        field.addEventListener("focus", () => {
            reportTextFieldFocused = true;
        });
        field.addEventListener("blur", () => {
            reportTextFieldFocused = false;
        });
        field.addEventListener("pointerdown", () => {
            if (document.activeElement instanceof HTMLCanvasElement) {
                document.activeElement.blur();
            }
            field.focus();
        });
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
            avatarImage.src = PLAYER_AVATAR;
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
            !shadow.querySelector(".reason-select").contains(event.target) &&
            !reportReasonOptions.hidden) {
            setReasonMenuOpen(false);
        }
    });
    function cancelVerification() {
        const callKey = pendingCallPlayerKey;
        resetReportCaptcha();
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
        if (reportSubmitting || captchaInProgress) return;
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

        const reporter = getReportIdentity().reporter || "Not detected";
        const target = reportTarget.value.trim();
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
        };
        reportFormStatus.hidden = true;
        void openVerificationDialog();
    });
    /***************************************
     * Report Submission
     ***************************************/
    /**
     * Submit a verified report, show the server result, and restore the form state.
     * @param {object} payload Report fields prepared by the submit handler.
     * @param {string} verificationToken Token returned by Turnstile.
     * @see openVerificationDialog
     * @see showUnityReportNotification
     */
    async function sendReport(payload, verificationToken, callPlayerKey = null) {
        reportSubmitting = true;
        if (callPlayerKey === null) {
            reportSubmitButton.disabled = true;
            reportCancelButton.disabled = true;
            setReportFormStatus("Sending report…", "info");
        }
        const playerCount = reportMatchState.active && reportMatchState.localId !== null
            ? reportMatchState.players.size + 1
            : null;
        const playerCountLabel = playerCount === null
            ? "not detected"
            : String(playerCount);
        const reportPayload = {
            ...payload,
            reason: `${payload.reason} [Players in match: ${playerCountLabel}]`,
        };
        try {
            const response = await fetch(
                "https://kour-report-api.kourkbi.workers.dev/api/report",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({
                        turnstileToken: verificationToken,
                        ...reportPayload,
                    }),
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
                responseData?.success !== false &&
                responseData?.message === "Report submitted successfully.";
            if (reportSucceeded) {
                if (callPlayerKey !== null) {
                    setCallKbiButtonState(callPlayerKey, "success", "KBI call sent successfully.");
                    showUnityReportNotification("<color=#4CAF50>KBI call sent successfully!</color>");
                } else {
                    showUnityReportNotification("<color=#4CAF50>Report sent successfully!</color>");
                    setReportFormStatus(responseData.message, "success");
                }
            } else {
                const retryAfterSeconds = responseData?.code === "KOUR_REPORT_API_REPORT_COOLDOWN"
                    ? getRetryAfterSeconds(response)
                    : null;
                const retryMessage = retryAfterSeconds === null
                    ? ""
                    : ` Please try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}.`;
                const errorMessage = limitServerResponse(
                    `${serverMessage || `No response body received (HTTP ${response.status}).`}${retryMessage}`
                );
                if (callPlayerKey !== null) {
                    if (responseData?.code === "KOUR_REPORT_API_REPORT_COOLDOWN" &&
                        retryAfterSeconds !== null && retryAfterSeconds > 0) {
                        setCallKbiButtonState(
                            callPlayerKey,
                            "cooldown",
                            errorMessage,
                            retryAfterSeconds
                        );
                        showUnityReportNotification(
                            `<color=#f4c842>KBI call cooldown: try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}.</color>`
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
        return event.composedPath().some((target) =>
            target instanceof Element &&
            (target.matches("input, textarea, select, [contenteditable='true'], [role='textbox']") ||
                target.isContentEditable)
        );
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
            launcherSettings.hideBothButtons = !launcherSettings.hideBothButtons;
            applyLauncherSettings();
            persistLauncherSettings();
            return;
        }
        if (matchesOpenKey(event)) {
            event.preventDefault();
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
        if (launcherSettings.left === null || launcherSettings.top === null) return;
        applyLauncherSettings();
        persistLauncherSettings();
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