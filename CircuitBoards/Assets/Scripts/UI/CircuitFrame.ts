/**
 * CircuitFrame.ts — Frame subclass for Circuit Board Explorer.
 *
 * Extends the UIKit Frame with circuit-boards defaults:
 *   - autoShowHide = false  (panel is always visible, not proximity-gated)
 *   - autoScaleContent = false  (content positioned manually by CircuitPanel)
 *   - follow behavior enabled (uses parent SmoothFollow module)
 *
 * All Frame API is inherited: innerSize, onScalingUpdate, allowTranslation,
 * useBillboarding, autoScaleContent, etc.
 *
 * Attach this in place of the Frame script on CircuitPanel.
 */

import {Frame} from 'SpectaclesUIKit.lspkg/Scripts/Components/Frame/Frame'

@component
export class CircuitFrame extends Frame {

  @input
  @hint("Enable smooth-follow behavior + corner follow toggle button")
  enableFollow: boolean = true

  @input
  @hint("Start in following state (only effective if enableFollow is true)")
  startFollowing: boolean = true

  onAwake() {
    // Set before super.onAwake() so Frame.initialize() sees these from the start.
    // Parent fields are private, so go through `as any`. LS does not always
    // populate parent-class @input defaults on a subclass instance, so we
    // also seed `_appearance` (otherwise ButtonHandler's createButton crashes
    // reading buttonSize off an undefined ButtonManagerConstants entry).
    var p = this as any
    if (!p._appearance) p._appearance = "Large"
    p.autoShowHide = false
    p.autoScaleContent = false

    if (this.enableFollow) {
      p._showFollowButton = true
      p.useFollowBehavior = true
      p._following = this.startFollowing
    }

    super.onAwake()
  }

}
