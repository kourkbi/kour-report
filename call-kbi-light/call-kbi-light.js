// ==UserScript==
// @name         Call KBI Light
// @namespace    https://kour.io/
// @version      1.0.2
// @description  Lightweight KBI call requests for Kour.io. Join the KBI Discord: https://discord.gg/Ke3a7ZZWMd
// @author       kourkbi
// @license      MIT
// @icon         https://raw.githubusercontent.com/kourkbi/kour-report/main/assets/menu/light/call-kbi-light-icon.png
// @match        *://kour.io/*
// @match        *://*.kour.io/*
// @run-at       document-idle
// @grant        unsafeWindow
// ==/UserScript==

(() => {
    "use strict";
    // Avoid installing duplicate launchers if the userscript runs more than once.
    if (document.getElementById("call-kbi-light")) return;

    // API and Turnstile are loaded only when the user submits a room link.
    const API = "https://kour-report-api.kourkbi.workers.dev/api/report";
    const SITE_KEY = "0x4AAAAAAFh9F7Gz7tkh9rAD";
    const page = typeof unsafeWindow === "undefined" ? window : unsafeWindow;

    // Build an isolated UI so page styles cannot affect the launcher or dialog.
    const host = document.createElement("div");
    host.id = "call-kbi-light";
    const ui = host.attachShadow({ mode: "closed" });
    ui.innerHTML = `
        <style>
            *{box-sizing:border-box}button,input{font:inherit}
            .icon{position:fixed;z-index:2147483647;right:0;top:50%;display:grid;width:64px;height:64px;place-content:center;gap:3px;transform:translateY(-50%);border:1px solid #74232a;border-radius:12px 0 0 12px;background:#b92b32;color:#fff;cursor:pointer;box-shadow:0 4px 14px #0008}
            .icon:hover{background:#d13b40}.icon svg{width:26px;height:26px;margin:auto;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.icon span{font:700 11px/1.1 Verdana,Arial,sans-serif}
            .panel{position:fixed;z-index:2147483647;inset:0;display:grid;place-items:center;overflow:auto;padding:18px;background:#0009;font:15px/1.45 Verdana,Arial,sans-serif;color:#f5e9eb}
            .card{position:relative;width:min(475px,100%);max-height:calc(100vh - 36px);overflow:auto;padding:20px;border:1px solid rgba(255,220,225,.2);border-radius:14px;background:rgba(75,24,34,.48);box-shadow:0 16px 42px #0008,inset 0 1px 0 #ffffff1a;-webkit-backdrop-filter:blur(20px) saturate(160%);backdrop-filter:blur(20px) saturate(160%)}
            header{display:flex;align-items:center;justify-content:space-between;gap:13px;margin:0 0 8px}h2{margin:0;color:#fff4f5;font:700 19px/1.3 Verdana,Arial,sans-serif}
            .close{width:36px;height:36px;border:1px solid #ffffffb3;border-radius:11px;background:linear-gradient(145deg,#ffffff4d,#b45a6461);color:#fff;cursor:pointer;font:700 22px/1 Verdana,Arial,sans-serif;box-shadow:0 3px 12px #28090c66,inset 0 1px 0 #ffffff80;-webkit-backdrop-filter:blur(18px) saturate(180%);backdrop-filter:blur(18px) saturate(180%);text-shadow:0 1px 3px #4a1018}
            .close:hover{background:linear-gradient(145deg,#ffffff6b,#d2646e8f)}.hint{margin:8px 0 18px;color:#e2c6cb;font:400 14px/1.55 Verdana,Arial,sans-serif}
            label{display:block;margin-bottom:5px;color:#f2dce0;font:600 12px Verdana,Arial,sans-serif}
            input{width:100%;padding:11px 13px;border:1px solid #ffffff38;border-radius:9px;outline:none;background:#2313176b;color:#fff4f5;font:400 14px Verdana,Arial,sans-serif;box-shadow:inset 0 1px 0 #ffffff12;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}
            input::placeholder{color:#c09ba1}input:focus{border-color:#ffffff8c;background:#2d151d94}
            .captcha{margin-top:12px}.send{display:flex;align-items:center;justify-content:center;gap:9px;min-height:38px;margin-top:14px;padding:0 16px;border:1px solid #ffffff94;border-radius:10px;background:linear-gradient(145deg,#ffffff40,#b03342a3 48%,#5c1723b8);color:white;cursor:pointer;font:600 13px Verdana,Arial,sans-serif;box-shadow:0 4px 14px #25090d66,inset 0 1px 0 #ffffff70;-webkit-backdrop-filter:blur(18px) saturate(180%);backdrop-filter:blur(18px) saturate(180%);text-shadow:0 1px 3px #4a1018}
            .send svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.send:hover:not(:disabled){filter:brightness(1.18)}.send:disabled{opacity:.55;cursor:not-allowed}
            .status{min-height:18px;margin:10px 0 0;color:#f4f4f4;font:800 13px/1.4 Arial,Helvetica,sans-serif;overflow-wrap:anywhere;white-space:pre-wrap}[hidden]{display:none!important}
        </style>
        <button class="icon" aria-label="Call KBI Light" title="Call KBI Light (Alt)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.2 3.8 10 3l2 4.8-2.1 1.6a15 15 0 0 0 4.7 4.7l1.6-2.1 4.8 2-.8 2.8a3 3 0 0 1-3.3 2.1A17.5 17.5 0 0 1 5.1 7.1a3 3 0 0 1 2.1-3.3Z"/></svg><span>Call KBI</span></button>
        <section class="panel" role="dialog" aria-label="Call KBI" hidden><div class="card"><header><h2>Call KBI</h2><button class="close" aria-label="Close">×</button></header>
            <p class="hint">Enter the Kour room link so KBI can identify the match. If you don't have one, join a match first.</p>
            <form><label for="room">Room link</label><input id="room" type="url" required placeholder="https://kour.io/#ABC123"><div class="captcha"></div>
                <button class="send" type="submit"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.2 3.8 10 3l2 4.8-2.1 1.6a15 15 0 0 0 4.7 4.7l1.6-2.1 4.8 2-.8 2.8a3 3 0 0 1-3.3 2.1A17.5 17.5 0 0 1 5.1 7.1a3 3 0 0 1 2.1-3.3Z"/></svg>Continue</button><p class="status" role="status" aria-live="polite"></p>
            </form></div></section>`;

    // Cache UI elements and keep small helpers for opening and validating the form.
    const $ = (selector) => ui.querySelector(selector), panel = $(".panel"), form = $("form"),
        link = $("#room"), captcha = $(".captcha"), send = $(".send"), status = $(".status");
    let turnstilePromise, turnstile, widget, flowId = 0, checking = false, requestPending = false;
    let automaticRoomLink = "", manualRoomLink = false;
    let roomTextFieldFocused = false;
    const shieldRoomTextFieldKeys = (event) => {
        if (roomTextFieldFocused && event.key !== "Escape") event.stopImmediatePropagation();
    };
    ["keydown", "keyup", "keypress"].forEach((type) => window.addEventListener(type, shieldRoomTextFieldKeys, true));
    const roomLink = () => location.hash.length > 1 ? location.href : "";
    const syncRoomLink = (force = false) => {
        const current = roomLink();
        if (current && (force || !manualRoomLink)) {
            link.value = automaticRoomLink = current;
            manualRoomLink = false;
        } else if (!current && link.value === automaticRoomLink) {
            link.value = automaticRoomLink = "";
            manualRoomLink = false;
        }
    };
    const resetFlow = () => {
        flowId++;
        checking = false;
        clearCaptcha();
        status.textContent = "";
        send.disabled = requestPending;
    };
    const open = (show) => {
        if (show) {
            resetFlow();
            panel.hidden = false;
            syncRoomLink(true);
            link.focus();
        } else {
            panel.hidden = true;
            roomTextFieldFocused = false;
            resetFlow();
            syncRoomLink();
        }
    };

    // Accept only HTTP(S) Kour links containing a room ID; reject credentials and other hosts.
    const parseRoom = (value) => {
        try {
            const url = new URL(value.trim()), roomId = url.hash.slice(1).trim();
            return (url.hostname === "kour.io" || url.hostname.endsWith(".kour.io")) && /^https?:$/.test(url.protocol) &&
                !url.username && !url.password && roomId ? { url, roomId } : null;
        } catch { return null; }
    };
    // Share one script-load promise across retries; reset it after a failed load.
    const loadTurnstile = () => {
        if (page.turnstile?.render) return Promise.resolve(page.turnstile);
        return turnstilePromise ||= new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
            script.async = true;
            script.onload = () => page.turnstile?.render ? resolve(page.turnstile) : reject(new Error("Verification failed to load."));
            script.onerror = () => reject(new Error("Could not load verification."));
            document.head.appendChild(script);
        }).catch((error) => { turnstilePromise = null; throw error; });
    };
    // Remove the previous widget before retrying or sending the verified request.
    const clearCaptcha = () => {
        if (widget !== undefined && turnstile?.remove) try { turnstile.remove(widget); }
        catch (error) { console.warn("[Call KBI Light] Could not remove verification widget:", error); }
        widget = undefined; captcha.replaceChildren();
    };
    const failVerification = (id, message) => {
        if (id !== flowId) return;
        clearCaptcha(); checking = false; status.textContent = message; send.disabled = requestPending;
    };
    // Submit the same payload contract as the full Kour Report's room-level KBI call.
    const sendReport = async (payload, token, id) => {
        try {
            if (id === flowId && !panel.hidden) status.textContent = "Sending KBI request…";
            const response = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" },
                credentials: "include", body: JSON.stringify({ turnstileToken: token, ...payload }) });
            const text = await response.text();
            let result;
            try { result = JSON.parse(text); } catch { result = null; }
            // Treat only the API's documented success response as a completed request.
            if (response.status === 201 && result?.code === "KOUR_REPORT_API_REPORT_SUBMITTED" &&
                result?.success !== false && result?.message === "Report submitted successfully.") {
                if (id === flowId && !panel.hidden) {
                    status.textContent = "KBI request sent successfully.";
                    form.reset();
                    syncRoomLink(true);
                }
            } else if (id === flowId && !panel.hidden) {
                status.textContent = `Unable to send request: ${String(result?.message || result?.error || text || `HTTP ${response.status}`).slice(0, 400)}`;
            }
        } catch (error) {
            console.error("[Call KBI Light] Failed to send request:", error);
            if (id === flowId && !panel.hidden) status.textContent = `Unable to send request: ${error.message || error}`;
        } finally {
            requestPending = false;
            send.disabled = checking;
        }
    };

    // Keep menu interactions from reaching page-level gameplay handlers.
    const isolateMenuEvent = (event) => {
        if (event.composedPath().includes(host)) event.stopPropagation();
    };
    ["keydown", "keyup", "keypress", "beforeinput", "input", "change", "click", "dblclick",
        "pointerdown", "pointerup", "pointermove", "pointercancel", "mousedown", "mouseup", "mousemove",
        "touchstart", "touchmove", "touchend", "touchcancel", "wheel", "contextmenu",
        "copy", "cut", "paste", "submit"].forEach((type) => host.addEventListener(type, isolateMenuEvent));

    // Launcher, close button, backdrop, and keyboard controls.
    $(".icon").addEventListener("click", () => open(panel.hidden));
    $(".close").addEventListener("click", () => open(false));
    panel.addEventListener("click", (event) => { if (event.target === panel) open(false); });
    link.addEventListener("input", () => { manualRoomLink = Boolean(link.value && link.value !== automaticRoomLink); });
    link.addEventListener("focus", () => { roomTextFieldFocused = true; });
    link.addEventListener("blur", () => { roomTextFieldFocused = false; });
    link.addEventListener("pointerdown", () => {
        if (document.activeElement instanceof HTMLCanvasElement) document.activeElement.blur();
        link.focus();
    });
    window.addEventListener("hashchange", () => {
        syncRoomLink();
        if (panel.hidden) return;
        if (checking) {
            resetFlow();
            status.textContent = "The match changed. Verify the updated room link to continue.";
        } else if (!requestPending) status.textContent = "";
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !panel.hidden) open(false);
        if (!roomTextFieldFocused && event.key === "Alt" && !event.repeat) {
            event.preventDefault();
            open(panel.hidden);
        }
    }, true);
    // Validate the room, create the room-level KBI payload, then require Turnstile.
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!form.reportValidity() || send.disabled) return;
        const room = parseRoom(link.value);
        if (!room) { status.textContent = "Enter a valid Kour room link with a room ID."; link.focus(); return; }
        let reporter = "";
        try { reporter = localStorage.getItem("playerNickname")?.replace(/<[^>]*>/g, "").trim() || ""; }
        catch (error) { console.warn("[Call KBI Light] Could not read saved player name:", error); }
        const payload = { reporter: reporter || "Not detected", target: "No player selected",
            reason: "This user is calling KBI", roomId: room.roomId, sessionLink: room.url.href };
        const id = ++flowId;
        checking = true;
        send.disabled = true; status.textContent = "Complete the verification to send your request.";
        try {
            turnstile = await loadTurnstile();
            if (id !== flowId || panel.hidden) return;
            clearCaptcha();
            widget = turnstile.render(captcha, { sitekey: SITE_KEY, theme: "dark",
                callback: (token) => {
                    if (token && id === flowId && !panel.hidden) {
                        clearCaptcha(); checking = false; requestPending = true;
                        void sendReport(payload, token, id);
                    }
                },
                "error-callback": () => failVerification(id, "Verification failed. Please try again."),
                "expired-callback": () => failVerification(id, "Verification expired. Please try again.") });
        } catch (error) {
            console.error("[Call KBI Light] Could not start verification:", error);
            if (id === flowId) {
                checking = false;
                status.textContent = error.message || String(error);
                send.disabled = requestPending;
            }
        }
    });
    // Mount after body exists; document-idle usually reaches the second branch.
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => document.body.appendChild(host), { once: true });
    else document.body.appendChild(host);
})();
