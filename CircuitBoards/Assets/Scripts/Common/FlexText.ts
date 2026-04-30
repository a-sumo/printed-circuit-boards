/**
 * FlexText.ts — Text component with automatic word-wrap and size reporting.
 *
 * Inspired by pretext (github.com/chenglou/pretext): two-phase measurement
 * where text is segmented and measured once, then reflowed cheaply at any
 * width constraint using pure arithmetic.
 *
 * Since Lens Studio has no canvas.measureText(), we use calibrated
 * character-width estimates. The algorithm:
 *   1. Segment text into words and whitespace
 *   2. Estimate each word's width using per-character width factors
 *   3. Greedy line breaking: place words until overflow, then wrap
 *   4. Character-level breaking for words wider than maxWidth
 *   5. Report total (width, height) for FlexContainer integration
 *
 * Two usage modes:
 *   A. @component — attach in editor, FlexContainer auto-reads size
 *   B. Utility functions — import and use in custom scripts:
 *        import { TextLayout } from './FlexText';
 *        var result = TextLayout.wrap("hello world", 42, 20);
 *
 * Part of SpatialFlex — a generic layout library for Snap Spectacles.
 */

// =====================================================================
// TEXT METRICS — character width estimation (replaces canvas.measureText)
// =====================================================================

// Average character width as fraction of em (font size).
// Latin proportional fonts average ~0.52em per character.
// These ratios are from standard typeface metrics (Helvetica/Inter family).
var NARROW_CHARS = "iIl|!.,;:'1 ";
var WIDE_CHARS = "mwMWOQGD@%";
var NARROW_FACTOR = 0.35;
var NORMAL_FACTOR = 0.52;
var WIDE_FACTOR = 0.72;
var MONO_FACTOR = 0.60;      // monospace: all chars equal width

// Conversion: LS text size (points) → world-space centimeters.
// Calibrated against Component.Text rendering on Spectacles.
var PT_TO_CM_WIDTH = 0.022;   // cm per point per character (average)
var PT_TO_CM_HEIGHT = 0.042;  // cm per point per line
var LINE_SPACING = 1.25;      // multiplier for line-to-line distance

// Known monospace font families (checked by prefix match on font name).
var MONO_FONTS = ["hack", "fira code", "source code", "jetbrains", "consolas",
                  "courier", "menlo", "monaco", "roboto mono", "sf mono",
                  "ibm plex mono", "ubuntu mono", "droid sans mono"];

/** Check if a font name looks monospace. */
function isMonoFont(fontName: string): boolean {
    if (!fontName) return false;
    var lower = fontName.toLowerCase();
    for (var i = 0; i < MONO_FONTS.length; i++) {
        if (lower.indexOf(MONO_FONTS[i]) >= 0) return true;
    }
    return lower.indexOf("mono") >= 0;
}

/**
 * Metrics config passed through the measurement pipeline.
 *   monospace: true → uniform char width (no narrow/wide)
 *   widthScale: multiplier on final width (>1 = wider estimate, use for safety margin)
 */
export class TextMetricsConfig {
    monospace: boolean = false;
    widthScale: number = 1.0;
}

var DEFAULT_METRICS = new TextMetricsConfig();

/** Estimate the world-space width (cm) of a string at a given font size. */
function estimateWidth(text: string, fontSize: number, cfg?: TextMetricsConfig): number {
    var mono = cfg ? cfg.monospace : false;
    var scale = cfg ? cfg.widthScale : 1.0;
    var totalEm = 0;
    for (var i = 0; i < text.length; i++) {
        if (mono) {
            totalEm += MONO_FACTOR;
        } else {
            var ch = text.charAt(i);
            if (NARROW_CHARS.indexOf(ch) >= 0) {
                totalEm += NARROW_FACTOR;
            } else if (WIDE_CHARS.indexOf(ch) >= 0) {
                totalEm += WIDE_FACTOR;
            } else {
                totalEm += NORMAL_FACTOR;
            }
        }
    }
    return totalEm * fontSize * PT_TO_CM_WIDTH * scale;
}

/** Estimate line height in cm for a given font size. */
function estimateLineHeight(fontSize: number): number {
    return fontSize * PT_TO_CM_HEIGHT;
}

// =====================================================================
// LINE BREAKING — pretext-inspired greedy word-wrap
// =====================================================================

interface Segment {
    text: string;
    width: number;
    isSpace: boolean;
}

/** Segment text into words and whitespace runs. */
function segmentText(text: string, fontSize: number, cfg?: TextMetricsConfig): Segment[] {
    var segments: Segment[] = [];
    var current = "";
    var currentIsSpace = text.length > 0 && text.charAt(0) === " ";

    for (var i = 0; i < text.length; i++) {
        var ch = text.charAt(i);
        var isSpace = ch === " " || ch === "\t";

        if (isSpace !== currentIsSpace && current.length > 0) {
            segments.push({
                text: current,
                width: estimateWidth(current, fontSize, cfg),
                isSpace: currentIsSpace
            });
            current = "";
            currentIsSpace = isSpace;
        }
        current += ch;
    }
    if (current.length > 0) {
        segments.push({
            text: current,
            width: estimateWidth(current, fontSize, cfg),
            isSpace: currentIsSpace
        });
    }
    return segments;
}

// Exported as classes (not interfaces) to avoid isolatedModules re-export issues.
export class WrappedLine {
    text: string;
    width: number;
}

export class WrapResult {
    lines: WrappedLine[];
    width: number;
    height: number;
    lineCount: number;
    effectiveFontSize: number;
}

export class CircleWrapLine {
    text: string;
    width: number;
    xOffset: number;    // horizontal shift to avoid circle
    y: number;          // vertical position (panel-local, Y-up)
    maxWidth: number;   // available width at this line
}

export class CircleWrapResult {
    lines: CircleWrapLine[];
    fontSize: number;
    lineHeight: number;
}

/**
 * Break text into lines that fit within maxWidth.
 *
 * Algorithm (from pretext):
 *   - Walk segments left to right, accumulating width
 *   - When adding a word would exceed maxWidth, start a new line
 *   - Trailing whitespace hangs past the edge (doesn't trigger breaks)
 *   - Words wider than maxWidth are broken at character boundaries
 */
function wrapLines(segments: Segment[], maxWidth: number, fontSize: number, cfg?: TextMetricsConfig): WrappedLine[] {
    if (segments.length === 0) return [{ text: "", width: 0 }];
    if (maxWidth <= 0) {
        // No constraint — single line
        var fullText = "";
        var fullWidth = 0;
        for (var i = 0; i < segments.length; i++) {
            fullText += segments[i].text;
            fullWidth += segments[i].width;
        }
        return [{ text: fullText, width: fullWidth }];
    }

    var lines: WrappedLine[] = [];
    var lineText = "";
    var lineWidth = 0;

    for (var i = 0; i < segments.length; i++) {
        var seg = segments[i];

        if (seg.isSpace) {
            // Trailing space hangs past edge (CSS behavior)
            lineText += seg.text;
            lineWidth += seg.width;
            continue;
        }

        // Word segment — check if it fits
        if (lineWidth + seg.width <= maxWidth || lineText.length === 0) {
            // Fits, or first word on line (must place at least one word)
            if (lineWidth + seg.width > maxWidth && seg.width > maxWidth) {
                // Word itself is wider than maxWidth — character-level break
                var chars = seg.text;
                for (var ci = 0; ci < chars.length; ci++) {
                    var ch = chars.charAt(ci);
                    var chW = estimateWidth(ch, fontSize, cfg);
                    if (lineWidth + chW > maxWidth && lineText.length > 0) {
                        lines.push({ text: rTrim(lineText), width: trimmedWidth(lineText, lineWidth, fontSize, cfg) });
                        lineText = "";
                        lineWidth = 0;
                    }
                    lineText += ch;
                    lineWidth += chW;
                }
            } else {
                lineText += seg.text;
                lineWidth += seg.width;
            }
        } else {
            // Doesn't fit — wrap to new line
            lines.push({ text: rTrim(lineText), width: trimmedWidth(lineText, lineWidth, fontSize, cfg) });
            lineText = seg.text;
            lineWidth = seg.width;
        }
    }

    // Push last line
    if (lineText.length > 0) {
        lines.push({ text: rTrim(lineText), width: trimmedWidth(lineText, lineWidth, fontSize, cfg) });
    }

    return lines;
}

/** Strip trailing whitespace (LS runtime may lack String.trimEnd). */
function rTrim(s: string): string {
    var end = s.length;
    while (end > 0 && (s.charAt(end - 1) === " " || s.charAt(end - 1) === "\t")) end--;
    return s.substring(0, end);
}

/** Recalculate width after trimming trailing spaces. */
function trimmedWidth(text: string, fullWidth: number, fontSize: number, cfg?: TextMetricsConfig): number {
    var trimmed = rTrim(text);
    if (trimmed.length === text.length) return fullWidth;
    return estimateWidth(trimmed, fontSize, cfg);
}

// =====================================================================
// PUBLIC UTILITY API — use from any script without the @component
// =====================================================================

export class TextLayout {

    /** Estimate width of a string in cm at the given font size. */
    static estimateWidth(text: string, fontSize: number, cfg?: TextMetricsConfig): number {
        return estimateWidth(text, fontSize, cfg);
    }

    /** Build a metrics config from a font name (auto-detects monospace). */
    static configForFont(fontName: string, widthScale?: number): TextMetricsConfig {
        var c = new TextMetricsConfig();
        c.monospace = isMonoFont(fontName);
        c.widthScale = widthScale !== undefined ? widthScale : 1.0;
        return c;
    }

    /** Estimate single-line height in cm at the given font size. */
    static lineHeight(fontSize: number): number {
        return estimateLineHeight(fontSize);
    }

    /** Line spacing multiplier (line-to-line distance = lineHeight * spacing). */
    static lineSpacing(): number {
        return LINE_SPACING;
    }

    /**
     * Full word-wrap pipeline: segment, measure, break, compute bounds.
     *
     * @param text The text to wrap
     * @param fontSize Font size in LS points
     * @param maxWidth Max width in cm (0 = no wrap)
     * @param autoShrink Shrink font to fit single line
     * @param minFontSize Floor for auto-shrink
     * @returns WrapResult with lines, dimensions, effective font size
     */
    static wrap(text: string, fontSize: number, maxWidth: number, autoShrink?: boolean, minFontSize?: number, cfg?: TextMetricsConfig): WrapResult {
        var fs = fontSize;

        if (autoShrink && maxWidth > 0) {
            var singleW = estimateWidth(text, fs, cfg);
            if (singleW > maxWidth) {
                var ratio = maxWidth / singleW;
                fs = Math.max(minFontSize || 24, Math.floor(fs * ratio));
            }
        }

        var segments = segmentText(text, fs, cfg);
        var lines = wrapLines(segments, maxWidth, fs, cfg);

        var maxLineW = 0;
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].width > maxLineW) maxLineW = lines[i].width;
        }

        var lh = estimateLineHeight(fs);

        return {
            lines: lines,
            width: maxLineW,
            height: lines.length * lh * LINE_SPACING,
            lineCount: lines.length,
            effectiveFontSize: fs
        };
    }

    /**
     * Wrap text around a circular obstacle on the panel.
     *
     * The circle is defined in panel-local space (origin = panel center).
     * For each line at a given Y, the circle's chord is subtracted from
     * the available width on the side where the circle sits.
     *
     * Returns per-line data: text, width, xOffset (shift away from circle).
     * This is the pretext layoutNextLine() pattern — each line gets a
     * different maxWidth.
     */
    static wrapAroundCircle(
        text: string, fontSize: number,
        panelW: number, panelH: number,
        cx: number, cy: number, cr: number,
        padding: number,
        cfg?: TextMetricsConfig
    ): CircleWrapResult {
        var lh = estimateLineHeight(fontSize) * LINE_SPACING;
        var contentW = panelW - padding * 2;
        var contentH = panelH - padding * 2;
        if (contentW < 1) contentW = 1;

        // Segment text once
        var segments = segmentText(text, fontSize, cfg);

        // Walk lines top-to-bottom with variable width
        var lines: CircleWrapLine[] = [];
        var segIdx = 0;
        var y = contentH / 2 - lh / 2; // start at top

        while (segIdx < segments.length && y > -contentH / 2) {
            // Compute circle chord at this Y (with generous margin)
            var dy = y - cy;
            var chordHalf = 0;
            var margin = cr * 0.6 + 1.0; // generous padding: 60% of radius + 1cm
            if (Math.abs(dy) < cr + 0.5) {
                var d = Math.abs(dy);
                if (d < cr) {
                    chordHalf = Math.sqrt(cr * cr - d * d) + margin;
                } else {
                    chordHalf = margin * 0.5; // soft fade at edge
                }
            }

            // Determine available width and x offset for this line
            var lineMaxW = contentW;
            var xOff = 0;

            if (chordHalf > 0) {
                // Circle eats into the line. Push text to opposite side.
                if (cx >= 0) {
                    // Circle on right → reduce right, shift text left
                    var rightEdge = contentW / 2;
                    var circleLeft = cx - chordHalf;
                    var eaten = rightEdge - circleLeft;
                    if (eaten > 0) {
                        lineMaxW = contentW - eaten;
                        xOff = -eaten / 2;
                    }
                } else {
                    // Circle on left → reduce left, shift text right
                    var leftEdge = -contentW / 2;
                    var circleRight = cx + chordHalf;
                    var eaten = circleRight - leftEdge;
                    if (eaten > 0) {
                        lineMaxW = contentW - eaten;
                        xOff = eaten / 2;
                    }
                }
            }

            if (lineMaxW < 1) lineMaxW = 1;

            // Greedy wrap: consume segments until this line is full.
            // Never force a word that overflows — skip to next line instead.
            var lineText = "";
            var lineWidth = 0;
            var placed = false;

            // Skip leading whitespace at line start
            while (segIdx < segments.length && segments[segIdx].isSpace) {
                segIdx++;
            }

            while (segIdx < segments.length) {
                var seg = segments[segIdx];
                if (seg.isSpace) {
                    lineText += seg.text;
                    lineWidth += seg.width;
                    segIdx++;
                    continue;
                }
                if (lineWidth + seg.width <= lineMaxW) {
                    lineText += seg.text;
                    lineWidth += seg.width;
                    segIdx++;
                    placed = true;
                } else if (!placed && lineMaxW >= contentW * 0.5) {
                    // Only force-place on lines with at least half the panel width
                    lineText += seg.text;
                    lineWidth += seg.width;
                    segIdx++;
                    placed = true;
                } else {
                    break; // word doesn't fit, carry to next line
                }
            }

            if (lineText.length > 0 || placed) {
                var trimmed = rTrim(lineText);
                var tw = estimateWidth(trimmed, fontSize, cfg);
                lines.push({ text: trimmed, width: tw, xOffset: xOff, y: y, maxWidth: lineMaxW });
            }

            y -= lh;
        }

        return { lines: lines, fontSize: fontSize, lineHeight: lh };
    }

    /** Join wrapped lines into a single string with newlines (for Component.Text). */
    static joinLines(lines: WrappedLine[]): string {
        var result = "";
        for (var i = 0; i < lines.length; i++) {
            if (i > 0) result += "\n";
            result += lines[i].text;
        }
        return result;
    }
}

// =====================================================================
// FLEXTEXT COMPONENT
// =====================================================================

@component
export class FlexText extends BaseScriptComponent {

    // ── Content ──

    @input @hint("Text content to display")
    text: string = "";

    @input @hint("Font size in points (LS units). [CSS: font-size]")
    fontSize: number = 42;

    // ── Layout constraints ──

    @input @hint("Max width in cm. 0 = auto from parent (if fillWidth) or no wrap. [CSS: max-width]")
    maxWidth: number = 0;

    @input @hint("Auto-fill parent FlexContainer width as maxWidth. Reflows on container resize.")
    fillWidth: boolean = false;

    @input @hint("Auto-shrink font to fit maxWidth. Minimum fontSize = minFontSize.")
    autoShrink: boolean = false;

    @input @hint("Text never overflows maxWidth — auto-shrinks if needed. Like HTML text-box behavior.")
    fitWidth: boolean = true;

    @input @hint("Minimum font size when autoShrink or fitWidth is enabled")
    minFontSize: number = 24;

    // ── Font metrics ──

    @input @hint("Monospace font (all chars equal width). Auto-detected from font name if false.")
    monospace: boolean = false;

    @input @hint("Width estimate multiplier. >1 = wider lines (wraps sooner, prevents bleed). Tune per-font.")
    widthScale: number = 1.0;

    // ── Appearance ──

    @input @hint("Text color RGBA (0-1)")
    color: vec4 = new vec4(0.75, 0.72, 0.70, 1);

    @input
    @widget(new ComboBoxWidget([
        new ComboBoxItem("Left", "left"),
        new ComboBoxItem("Center", "center"),
        new ComboBoxItem("Right", "right")
    ]))
    @hint("Horizontal alignment within the text block. [CSS: text-align]")
    textAlign: string = "center";

    @input @allowUndefined
    @hint("Custom font asset")
    font: Font;

    // ── Computed size (read by SizeResolver) ──

    /** Computed width after word-wrap, in cm. */
    computedWidth: number = 0;
    /** Computed height after word-wrap, in cm. */
    computedHeight: number = 0;
    /** Number of wrapped lines. */
    lineCount: number = 0;
    /** Effective font size (may differ from fontSize if autoShrink is active). */
    effectiveFontSize: number = 0;

    // ── Internal ──

    private textComponent: any = null;
    private prepared: boolean = false;

    onAwake() {
        this.createEvent("OnStartEvent").bind(() => this.prepare());
    }

    // =====================================================================
    // PUBLIC API
    // =====================================================================

    /** Reflow text with current settings. Call after changing text, fontSize, or maxWidth. */
    reflow() {
        this.prepare();
    }

    /** Update text content and reflow. */
    setText(newText: string) {
        this.text = newText;
        this.prepare();
    }

    /** Update max width constraint and reflow. */
    setMaxWidth(w: number) {
        this.maxWidth = w;
        this.prepare();
    }

    /** Update font size and reflow. */
    setFontSize(size: number) {
        this.fontSize = size;
        this.prepare();
    }

    /** Update color without reflowing. */
    setColor(c: vec4) {
        this.color = c;
        if (this.textComponent) {
            (this.textComponent as any).textColor = c;
        }
    }

    /** Get computed size for layout. Used by SizeResolver. */
    getComputedSize(): vec2 {
        if (!this.prepared) this.measure();
        return new vec2(this.computedWidth, this.computedHeight);
    }

    // =====================================================================
    // PREPARE — two-phase: measure then render
    // =====================================================================

    private prepare() {
        this.measure();
        this.render();
        this.prepared = true;
    }

    /** Resolve effective maxWidth: explicit > fillWidth from parent > 0. */
    private resolveMaxWidth(): number {
        if (this.maxWidth > 0) return this.maxWidth;
        if (!this.fillWidth) return 0;

        // Walk up to find parent FlexContainer's available width
        var parent = this.getSceneObject().getParent();
        if (!parent) return 0;

        var components = parent.getComponents("ScriptComponent");
        for (var i = 0; i < components.length; i++) {
            var sc = components[i] as any;
            // Duck-type FlexContainer: has containerWidth, paddingLeft, layout()
            if (sc && sc.containerWidth !== undefined &&
                sc.paddingLeft !== undefined &&
                typeof sc.layout === "function") {
                var avail = sc.containerWidth - (sc.paddingLeft || 0) - (sc.paddingRight || 0);
                if (avail > 0) return avail;
            }
        }
        return 0;
    }

    /** Build metrics config from component inputs. */
    private buildConfig(): TextMetricsConfig {
        var c = new TextMetricsConfig();
        c.monospace = this.monospace;
        c.widthScale = this.widthScale > 0 ? this.widthScale : 1.0;
        // Auto-detect monospace from font name if not explicitly set
        if (!c.monospace && this.font) {
            try { c.monospace = isMonoFont((this.font as any).name || ""); } catch (e) {}
        }
        return c;
    }

    /** Phase 1: Segment, measure, and line-break (pure arithmetic). */
    private measure() {
        var mw = this.resolveMaxWidth();
        var cfg = this.buildConfig();
        // fitWidth implies autoShrink when a width constraint exists
        var shrink = this.autoShrink || (this.fitWidth && mw > 0);
        var result = TextLayout.wrap(this.text, this.fontSize, mw, shrink, this.minFontSize, cfg);

        this.effectiveFontSize = result.effectiveFontSize;
        this.lineCount = result.lineCount;
        this.computedWidth = result.width;
        this.computedHeight = result.height;

        // Store lines for render phase
        (this as any)._wrappedLines = result.lines;
    }

    /** Phase 2: Create/update Component.Text with wrapped content. */
    private render() {
        var obj = this.getSceneObject();
        var lines: WrappedLine[] = (this as any)._wrappedLines;
        if (!lines || lines.length === 0) return;

        var joined = TextLayout.joinLines(lines);

        // Create or reuse text component
        if (!this.textComponent) {
            this.textComponent = obj.createComponent("Component.Text");
        }

        var tc = this.textComponent as any;
        tc.text = joined;
        tc.size = this.effectiveFontSize;

        if (this.font) tc.font = this.font;

        // Horizontal alignment
        if (this.textAlign === "left") {
            tc.horizontalAlignment = HorizontalAlignment.Left;
        } else if (this.textAlign === "right") {
            tc.horizontalAlignment = HorizontalAlignment.Right;
        } else {
            tc.horizontalAlignment = HorizontalAlignment.Center;
        }
        tc.verticalAlignment = VerticalAlignment.Center;

        tc.textColor = this.color;
    }
}

