# Tron Frame Reference

Reference: sci-fi HUD with red/amber corner brackets around panels.
Screenshot saved in conversation (2026-03-07).

## Visual Elements
- Corner brackets: L-shaped (or 3D angle-bracket) pieces at each panel corner
- 3 orthogonal arms at each corner: along horizontal edge, vertical edge, and depth (normal)
- Short arms = corner accent brackets. Full-length arms = wireframe cage/bounding box
- Thin bright lines with hot core (white/yellow) and vivid edge glow (amber/red)
- Additive look: bright on dark, works naturally on Spectacles display

## Architecture
- TronFrame.ts: procedural geo-tube mesh, 12 segments (4 corners x 3 arms)
- TronFrameShader.js: straight tube rendering with glow color
- Same data texture pattern as CircuitConnector (16-bit fixed-point positions)
- CircuitConnector.ts / CircuitShader.js: kept as-is for point-to-point routing
