/**
 * CircuitFrame.ts — Frame subclass for Circuit Board Explorer.
 *
 * Extends the UIKit Frame with circuit-boards defaults:
 *   - autoShowHide = false  (panel is always visible, not proximity-gated)
 *   - autoScaleContent = false  (content positioned manually by CircuitPanel)
 *
 * All Frame API is inherited: innerSize, onScalingUpdate, allowTranslation,
 * useBillboarding, autoScaleContent, etc.
 *
 * Attach this in place of the Frame script on CircuitPanel.
 */

import {Frame} from 'SpectaclesUIKit.lspkg/Scripts/Components/Frame/Frame'

@component
export class CircuitFrame extends Frame {

  onAwake() {
    // Set before super.onAwake() so Frame.initialize() sees these from the start.
    this.autoShowHide = false
    this.autoScaleContent = false
    super.onAwake()
  }

}
