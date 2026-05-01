// BoardCatalog.ts — Single source of truth for all board metadata.
// Add new boards HERE. All consumers import from this file.
// The require() map for board .js modules stays in KiCadBoard.ts (static LS resolution).

export interface BoardMeta {
    slug: string;
    displayName: string;
    // Optional short label for the panel's board buttons. Falls back to
    // displayName when omitted. Use this to keep narrow column buttons
    // readable for boards with verbose names (e.g. "RPi CM4 IO" → "CM4 IO").
    buttonLabel?: string;
    desc: string;
    layers: number;
    mcu: string;
}

// ---- THE CATALOG (edit this array to add/remove boards) ----
export var BOARD_CATALOG: BoardMeta[] = [
    { slug: "arduino-nano",  displayName: "Arduino Nano",  buttonLabel: "Arduino", desc: "ATmega328P-based development board. 8-bit AVR, 16 MHz, 32 KB flash. Compact DIP form factor, USB-B mini connector.", layers: 2, mcu: "ATmega328P" },
    { slug: "stickhub-usb",  displayName: "StickHub USB",  buttonLabel: "StickHub", desc: "USB hub controller in a compact stick form factor. Multi-port USB 2.0 with power distribution and ESD protection.", layers: 2, mcu: "USB hub IC" },
    { slug: "rpi-cm4io",     displayName: "RPi CM4 IO",    buttonLabel: "CM4 IO", desc: "Compute Module 4 carrier board. Dual HDMI, PCIe, Gigabit Ethernet, 40-pin GPIO. Designed for embedded deployments.", layers: 4, mcu: "BCM2711" },
    { slug: "attiny85-usb",  displayName: "ATtiny85 USB", buttonLabel: "ATtiny85", desc: "Digispark-style ATtiny85 dev board with V-USB direct connection. 8-bit AVR @16.5 MHz, 8 KB flash, DIP-8 socket, on-board AMS1117 3.3V regulator and status LEDs.", layers: 2, mcu: "ATtiny85" },
    { slug: "xiao-servo",    displayName: "XIAO Servo",    buttonLabel: "XIAO", desc: "XIAO RP2040 servo controller breakout. Controls up to 4 PWM servos with 5V level shifting and JST connectors.", layers: 2, mcu: "RP2040" },
];

// ---- Derived lookup helpers ----

export function getBoardDisplayName(slug: string): string {
    for (var i = 0; i < BOARD_CATALOG.length; i++) {
        if (BOARD_CATALOG[i].slug === slug) return BOARD_CATALOG[i].displayName;
    }
    return slug;
}

// Short label for the panel's board buttons. Falls back to the full
// displayName when the catalog entry omits buttonLabel.
export function getBoardButtonLabel(slug: string): string {
    for (var i = 0; i < BOARD_CATALOG.length; i++) {
        if (BOARD_CATALOG[i].slug === slug) {
            return BOARD_CATALOG[i].buttonLabel || BOARD_CATALOG[i].displayName;
        }
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
