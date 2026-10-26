<p align="center">
  <img src="assets/kourkbi-report-script-banner.jpg" alt="Report hackers to the K.B.I. — Kour Report" width="100%">
</p>

<h1 align="center">Kour Report</h1>

<p align="center">
  <a href="https://discord.gg/R9wuHc6ucg">
    <img src="https://img.shields.io/badge/Discord-Join%20KBI-5865F2?logo=discord&logoColor=white" alt="Join the KBI Discord">
  </a>
  <a href="./LICENSE.md">
    <img src="https://img.shields.io/badge/License-MIT-blue" alt="MIT License">
  </a>
</p>

**Kour Report** is a userscript for reporting players in a [Kour.io](https://kour.io/) match. It shows the players currently in your room and lets you submit a report to the KBI team without leaving the game.

> [!IMPORTANT]
> **Kour Report is an independent community project. It is not affiliated with, endorsed by, sponsored by, or officially connected to Kour.io or Legion Platforms, the developer of Kour.io.**

> [!IMPORTANT]
> This script and its endpoint are intended for use on **Kour.io**. The endpoint only works in the Kour.io context. Running the script or an integration from another website, a server, or an external application will not work.

## 📦 Script

The userscript is **[kour-report.js](./kour-report.js)**. Install this file to use the in-game reporting menu.

## 🚀 Installation

1. Install a userscript manager compatible with your browser, such as Tampermonkey or Violentmonkey.
2. Open [kour-report.js](./kour-report.js), copy its contents, and create a new userscript in your manager. You can also import the file if your manager supports it.
3. Save the script and open or reload [Kour.io](https://kour.io/).
4. Join a match and press **Left Alt** to open the report menu, or select the report icon.

In **Settings**, you can change the menu shortcut and the shortcut for showing or hiding the icon. You can also adjust the icon's size and opacity, hide it, and enable dragging to reposition it.

> [!NOTE]
> The default menu shortcut is **Left Alt**, and the default shortcut for showing or hiding the icon is **Right Alt**. Both shortcuts can be changed in settings.

## 🖼️ Screenshots

### Report Menu

![The report menu showing players in the current room and report options.](./assets/report-menu.png)

### Report Details Menu

![The report details menu for selecting a reason and adding optional details.](./assets/report-details-menu.png)

### Report Settings Menu

![The settings menu for configuring the report icon and keyboard shortcuts.](./assets/report-settings-menu.png)

## ⚙️ How It Works

1. When run on Kour.io, the script detects the current match and lists the players in the room.
2. Select a player and choose a reason: **Invisibility**, **Aimbot**, **Flying**, **Wallhack**, or **Other**.
3. Optionally add details (up to 250 characters).
4. Complete the Cloudflare Turnstile security check to submit the report. The result is shown in the report menu.

The selected player must still be in the current match, and the room ID must be valid. Report submission is handled by the KBI service, which can reject reports that do not meet its validation requirements.

> [!WARNING]
> Submit only legitimate reports. Do not repeatedly report players to harass them, submit false information, or attempt to bypass Turnstile or the service's controls.

> [!CAUTION]
> The reporting service is operated by KBI. Its availability and behavior may change without notice.

## 💬 Discord

Join the KBI Discord to discuss the project and reports:

[![Join the KBI Discord](https://img.shields.io/badge/Discord-Join%20KBI-5865F2?logo=discord&logoColor=white)](https://discord.gg/R9wuHc6ucg)

## 📄 License

This project is distributed under the **MIT License**, which permits use, modification, distribution, sublicensing, and sale, provided the copyright and permission notice are included with copies or substantial portions of the software. Read the full terms in [LICENSE.md](./LICENSE.md).
