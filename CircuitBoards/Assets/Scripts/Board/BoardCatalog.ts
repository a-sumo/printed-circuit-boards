// BoardCatalog.ts — Single source of truth for all board metadata.
// Add new boards HERE. All consumers import from this file.
// The require() map for board .js modules stays in KiCadBoard.ts (static LS resolution).

export interface BoardMeta {
    slug: string;
    displayName: string;
    desc: string;
    layers: number;
    mcu: string;
}

// ---- THE CATALOG (edit this array to add/remove boards) ----
export var BOARD_CATALOG: BoardMeta[] = [
    { slug: "arduino-nano",  displayName: "Arduino Nano",  desc: "ATmega328P-based development board. 8-bit AVR, 16 MHz, 32 KB flash. Compact DIP form factor, USB-B mini connector.", layers: 2, mcu: "ATmega328P" },
    { slug: "stickhub-usb",  displayName: "StickHub USB",  desc: "USB hub controller in a compact stick form factor. Multi-port USB 2.0 with power distribution and ESD protection.", layers: 2, mcu: "USB hub IC" },
    { slug: "rpi-cm4io",     displayName: "RPi CM4 IO",    desc: "Compute Module 4 carrier board. Dual HDMI, PCIe, Gigabit Ethernet, 40-pin GPIO. Designed for embedded deployments.", layers: 4, mcu: "BCM2711" },
    { slug: "raspi-3",       displayName: "Raspberry Pi 3B+", desc: "Quad-core Cortex-A53 SBC. Hand-authored labeled overlay (no public KiCad layout) showing the GPIO header, USB stack, Ethernet, HDMI, SoC, and Wi-Fi module positions.", layers: 6, mcu: "BCM2837B0" },
    { slug: "xiao-servo",    displayName: "XIAO Servo",    desc: "XIAO RP2040 servo controller breakout. Controls up to 4 PWM servos with 5V level shifting and JST connectors.", layers: 2, mcu: "RP2040" },
];

// ---- Derived lookup helpers ----

export function getBoardDisplayName(slug: string): string {
    for (var i = 0; i < BOARD_CATALOG.length; i++) {
        if (BOARD_CATALOG[i].slug === slug) return BOARD_CATALOG[i].displayName;
    }
    return slug;
}

export function getBoardMeta(slug: string): BoardMeta {
    for (var i = 0; i < BOARD_CATALOG.length; i++) {
        if (BOARD_CATALOG[i].slug === slug) return BOARD_CATALOG[i];
    }
    return { slug: slug, displayName: slug, desc: "Custom KiCad PCB.", layers: 2, mcu: "Unknown" };
}

export function getAllSlugs(): string[] {
    var result: string[] = [];
    for (var i = 0; i < BOARD_CATALOG.length; i++) {
        result.push(BOARD_CATALOG[i].slug);
    }
    return result;
}

export function getAllDisplayNames(): string[] {
    var result: string[] = [];
    for (var i = 0; i < BOARD_CATALOG.length; i++) {
        result.push(BOARD_CATALOG[i].displayName);
    }
    return result;
}
