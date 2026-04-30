# XFeat ONNX → Lens Studio FastDNN: Import Fix Log

Running log of everything we've learned about getting XFeat's ONNX backbone to
import into Lens Studio's FastDNN ML converter. The XFeat graph has ~66 nodes
(dynamo) or ~484 nodes (legacy torchscript) and LS silently rejects it on
import — no log line, no error, just no asset appears.

## Context

- **Model:** XFeat backbone-only (`XFeatModel.forward` returning `(feats, kpts, heatmap)`)
- **Source:** `models/xfeat/accelerated_features/modules/model.py` (MIT-licensed, VerLab/DCC-UFMG)
- **Export script:** `models/xfeat/export_backbone.py` (dynamo, opset 18) and
  `models/xfeat/export_backbone_opset11.py` (legacy torchscript, opset 11)
- **Runtime target:** `CircuitBoards/Assets/Connectors/BoardFeatureTracker.ts` →
  `MLComponent` → `DepthCache` → `Kabsch.ts`
- **Input:** `[1, 1, 480, 640]` grayscale float32

## Historical gotchas (already solved)

### 1. `noop_with_empty_axes` on ReduceMean (2026-04-10)
`onnxsim` added `noop_with_empty_axes` (opset 13+) to the single ReduceMean node.
LS FastDNN predates opset 13 and silently rejected the whole graph. Strip recipe:

```python
import onnx
m = onnx.load("xfeat_backbone_simplified.onnx")
for node in m.graph.node:
    if node.op_type == "ReduceMean":
        node.attribute[:] = [a for a in node.attribute if a.name != "noop_with_empty_axes"]
onnx.save(m, "xfeat_backbone_stripped.onnx")
```

Status: **fixed.** Committed in `4d71b0e`. Unblocked the import beyond
"invalid file" but the graph still silently fails for a different reason.

### 2. Programmatic asset import is impossible via LS MCP (2026-04-11)
Exhausted paths: `ls_write_file` (UTF-8 only, no binary), `InstallLensStudioPackage`
(silent no-op for non-`.lspkg`), `CreateLensStudioAsset` (enum rejects `MLAsset`),
filesystem move-out-and-back into `Assets/` (ignored mid-session), preview runs
(no asset rescan). LS only auto-imports new binary assets **on project open**.

Workaround: keep the ONNX file at the **project root** (not under `Assets/`) and
have the user import it manually via **File > Import Asset** in LS.

## Current bisection (2026-04-11)

### Sanity probes
| File | Opset | Nodes | Result |
|---|---|---|---|
| `tiny_conv_opset11.onnx` | 11 | 1 Conv | **imports** |
| `tiny_conv_opset17.onnx` | 17 | 1 Conv | **imports** |
| `xfeat_backbone_opset17.onnx` | 17 | 484 | fails silently |
| `xfeat_backbone_opset11.onnx` | 11 | 484 | fails silently |

Conclusion: LS handles opset 17 for simple graphs. The problem is **graph-specific**,
not an opset ceiling. Re-exporting at opset 11 didn't help — same silent failure.

### Suspect op probes
Built `models/xfeat/build_op_probes.py` — three tiny probes each isolating one
suspect op from XFeat's graph at opset 11, legacy torchscript path:

| Probe | Suspect | Op count | LS result |
|---|---|---|---|
| `tiny_instancenorm_opset11.onnx` | `InstanceNormalization` (XFeat has 1) | 5 nodes | **imports** |
| `tiny_resize_bilinear_opset11.onnx` | `Resize` linear half_pixel (XFeat has 2) | 12 nodes | **FAILS** |
| `tiny_unfold_opset11.onnx` | Slice/Transpose chain from `_unfold2d` | 105 nodes | **FAILS** |

**Verdict:** LS's FastDNN converter rejects

1. **`Resize` with `mode=linear`** (bilinear interpolation).
   XFeat uses this in pyramid fusion at `model.py:146-147`:
   ```python
   x4 = F.interpolate(x4, (x3.shape[-2], x3.shape[-1]), mode='bilinear')
   x5 = F.interpolate(x5, (x3.shape[-2], x3.shape[-1]), mode='bilinear')
   ```

2. **The torch.unfold -> Slice/Transpose/Unsqueeze expansion chain** that the legacy
   torchscript exporter produces from `model.py:113-120`:
   ```python
   def _unfold2d(self, x, ws=2):
       B, C, H, W = x.shape
       x = x.unfold(2, ws, ws).unfold(3, ws, ws) \
           .reshape(B, C, H//ws, W//ws, ws**2)
       return x.permute(0, 1, 4, 2, 3).reshape(B, -1, H//ws, W//ws)
   ```
   Called once at `model.py:152` as `self._unfold2d(x, ws=8)` inside the keypoint head.

## Round 2: replacement candidates

Built `models/xfeat/build_replacement_probes.py`. Each candidate avoids one of
the two failure modes above.

| Probe | Strategy | Op mix | LS result |
|---|---|---|---|
| `tiny_upsample_nearest_opset11.onnx` | `nn.Upsample(mode='nearest')` replaces bilinear | Resize × 1 (mode=nearest) | **imports** |
| `tiny_convtranspose_2x_opset11.onnx` | `ConvTranspose2d(stride=2)` replaces upsample entirely | ConvTranspose × 1 | **imports** |
| `tiny_reshape_permute_unfold_opset11.onnx` | `x.reshape(...).permute(...).reshape(...)` space-to-depth | Reshape × 2, Transpose × 1 | **FAILS** |
| `tiny_pixel_unshuffle_opset11.onnx` | `F.pixel_unshuffle(x, 8)` (exports to Reshape+Transpose at opset 11) | Reshape × 2, Transpose × 1 | **FAILS** |

**Resize side: solved.** Swap `mode='bilinear'` → `mode='nearest'` in
`model.py:146-147`. Small numerical drift, acceptable for keypoint matching.

**Unfold side: root cause found via shape inference on the failing probe.**
Both reshape+permute and pixel_unshuffle produce a **rank-6 intermediate**:
```
Reshape:   [1, 1, 64, 64]  ->  [1, 1, 8, 8, 8, 8]    <-- rank 6
Transpose: [1, 1, 8, 8, 8, 8]  ->  [1, 1, 8, 8, 8, 8]
Reshape:   [1, 1, 8, 8, 8, 8]  ->  [1, 64, 8, 8]
```
LS FastDNN appears to only accept rank ≤ 4 (NCHW). Any space-to-depth has
to stay 4D throughout. ConvTranspose2d works because it never leaves 4D;
strided Conv (the proven in-XFeat operation) also stays 4D.

## Round 3: rank-4-only unfold replacements

Built `models/xfeat/build_unfold_rank4_probes.py`:

| Probe | Strategy | Op mix | Max rank | LS result |
|---|---|---|---|---|
| `tiny_strided_conv_unfold_opset11.onnx` | Strided Conv2d with **fixed identity kernel** (byte-exact parity vs `_unfold2d`) | Conv × 3 | 4 | **imports** |
| `tiny_spacetodepth_native_opset11.onnx` | Native `SpaceToDepth` ONNX primitive, injected via `onnx.helper` | Conv × 2, SpaceToDepth × 1 | 4 | **FAILS** |

**FastDNN op support so far:**
- Supported: Conv, ConvTranspose, Relu, Sigmoid, Add, Concat, AveragePool,
  ReduceMean, InstanceNormalization, Resize (nearest only, no bilinear)
- Rejected: Resize (mode=linear), Slice chains, SpaceToDepth, any rank > 4

## Round 4: first patched XFeat backbone (v1: nearest-mode pyramid fusion)

Patched `modules/model.py` in place:

1. `__init__` — added a non-persistent `_unfold_kernel` buffer: identity kernel
   of shape `[64, 1, 8, 8]` where `weight[c, 0, c//8, c%8] = 1.0`.
2. `_unfold2d` — body replaced with `F.conv2d(x, self._unfold_kernel, stride=ws)`.
   Byte-exact parity with the torch.unfold version for `ws=8`, `C=1`.
3. Pyramid fusion (model.py:146-147) — `F.interpolate(..., mode='bilinear')`
   replaced with `F.interpolate(scale_factor=k, mode='nearest')` where `k` is
   2 for x4 and 4 for x5 (derived from block4/block5 stride=2 counts given
   static 480×640 input).

### v1 re-export result

| Metric | Before patch | After patch |
|---|---|---|
| Total nodes | 484 | **60** |
| Slice nodes | 140 | 0 |
| Transpose nodes | 141 | 0 |
| Unsqueeze nodes | 140 | 0 |
| Conv nodes | 27 | 28 (`+1` for unfold replacement) |
| Resize mode | linear | nearest |
| Max intermediate rank | 4 | 4 |
| IR version / opset | 6 / 11 | 6 / 11 |

File: `xfeat_backbone_fastdnn_v1_nearest.onnx` (project root, ~2.67 MB).

### v1 numerical drift vs original XFeat
| Head | Shape | max\|patch − original\| | relative drift |
|---|---|---|---|
| `descriptor_map` | (1, 64, 60, 80) | 0.878 | 13.8% |
| `keypoint_logits` | (1, 65, 60, 80) | **0.000** | **0%** |
| `heatmap` | (1, 1, 60, 80) | 0.025 | 54% |

ONNX vs patched-torch parity is ~3e-5 max (float precision), confirming the
ONNX graph correctly represents the patched model.

**Interpretation:**
- Strided-Conv unfold replacement contributes **zero drift** (keypoint_logits is
  byte-exact because it's the only head touched by `_unfold2d`).
- All 13-54% drift comes from the nearest-neighbor upsampling in pyramid fusion.
- Descriptors still encode the same scene content but absolute values shift —
  likely survives feature matching because cosine similarity is robust to
  monotonic perturbations, but needs empirical validation against the browser
  baseline once the model is bound to MLComponent.

### v2 result: bilinear via ConvTranspose2d (virtually drift-free)

Patched pyramid fusion in `modules/model.py`:
```python
x4 = F.conv_transpose2d(x4, self._upsample_kernel_2x, stride=2, padding=1, groups=64)
x5 = F.conv_transpose2d(x5, self._upsample_kernel_4x, stride=4, padding=2, groups=64)
```
Kernels are Long-et-al-FCN bilinear weights, registered as non-persistent
buffers in `__init__` so `load_state_dict` still works strict.

Probe parity on random input showed **interior of the image matches
`F.interpolate(mode='bilinear')` byte-exact**, with max edge-pixel differences
of 1.21 (2x) and 1.69 (4x) caused by zero-padding outside the image bounds.

Re-exported graph: **60 nodes**, now with `ConvTranspose × 2` instead of
`Resize × 2`. No Resize op at all.

**v2 numerical drift vs original XFeat (center-cropped, floating-point domain):**

| Head | inner median | inner p99 | cosine sim |
|---|---|---|---|
| `descriptor_map` | 1.79e-07 | 7.15e-07 | **0.99943** |
| `keypoint_logits` | 0.000 | 0.000 | **1.00000** |
| `heatmap` | 4.66e-10 | 1.02e-08 | **0.98776** |

Per-descriptor cosine similarity: **99.9% of descriptors have cos ≥ 0.99**,
median = 1.0000, min = 0.9896 (edge pixels only).

This is an effectively zero-cost replacement — drift is at floating-point
rounding level except for a 4-pixel border where ConvTranspose zero-pads.
Feature matching behavior should be indistinguishable from the original.

File: `xfeat_backbone_fastdnn_v2_bilinear.onnx` (project root, ~2.69 MB).

## Round 5: assembled-graph bisection (v1 and v2 both failed LS)

Both v1 and v2 imported individually-probed ops but the assembled 60-node
graph failed silently. Inspecting the v2 node dump flagged four ops that
were never probed in their XFeat-specific configuration:

- `ConvTranspose` with `group=64` (previous probes used groups=4)
- `ReduceMean` with `axes=[1]` on a 4D tensor (channel-axis collapse)
- `AveragePool` with `kernel=4, stride=4` (skip1 downsample)
- `Add` in residual form (skip connection)

Built 5 probes organized into `probes/round5_assembled_graph/NN_NAME/` folders:

| # | Probe | LS result |
|---|---|---|
| 01 | `xfeat_first_half.onnx` — real XFeat block1+block2+skip1, 480×640 input | **FAIL** |
| 02 | `convtranspose_groups64.onnx` — depthwise ConvTranspose | passes |
| 03 | `reducemean_channel.onnx` — ReduceMean axis=1 | passes |
| 04 | `avgpool_4x4.onnx` — AveragePool k=4 s=4 | **FAIL** |
| 05 | `add_residual.onnx` — residual Add | passes |

**Offender: `AveragePool` with kernel=4, stride=4.** Probe 01 (first half of
XFeat) failed because it includes `skip1`'s AvgPool. Once the AvgPool is
replaced, the assembled graph should only contain ops that have individual
passing probes.

## Round 6: v3 patch — replace AvgPool with F.conv2d

Patched `modules/model.py`:

1. Added `_skip1_avgpool_kernel` buffer in `__init__`: constant
   `torch.full((1, 1, 4, 4), 1/16)`, non-persistent.
2. In `forward()`, replaced `self.skip1(x)` with:
   ```python
   skip_pooled = F.conv2d(x, self._skip1_avgpool_kernel, bias=None, stride=4)
   x2 = self.block2(x1 + self.skip1[1](skip_pooled))
   ```
   Uses `F.conv2d` for the pooling (mathematically identical — a 4×4 mean
   IS a conv with uniform 1/16 weights) and the pretrained `skip1[1]` 1×1
   Conv for channel projection (unchanged weights).

### v3 re-export result

| Metric | v2 | v3 |
|---|---|---|
| Total nodes | 60 | 60 |
| Conv nodes | 28 | 29 (`+1` for AvgPool replacement) |
| AveragePool nodes | 1 | **0** |
| Resize nodes | 0 | 0 |
| ConvTranspose nodes | 2 | 2 |
| Max tensor rank | 4 | 4 |

**Full op set**: Conv, ConvTranspose, Relu, InstanceNormalization, ReduceMean,
Sigmoid, Add. Every op has a passing isolation probe.

### v3 numerical drift

Identical to v2 (AvgPool→Conv replacement is mathematically exact):

| Head | inner median | inner p99 | cosine sim |
|---|---|---|---|
| `descriptor_map` | 4.17e-07 | 1.67e-06 | **0.99943** |
| `keypoint_logits` | 0.000 | 0.000 | **1.00000** |
| `heatmap` | 8.15e-10 | 9.78e-09 | **0.98776** |

Per-descriptor cosine similarity unchanged: 99.9% of descriptors at cos ≥ 0.99.

File: `xfeat_backbone_fastdnn_v3.onnx` (project root, ~2.69 MB).

## Final production path

1. Import `xfeat_backbone_fastdnn_v2_bilinear.onnx` into LS via
   File > Import Asset (keeps the file outside `Assets/` until LS writes
   its `.meta` sidecar via successful import).
2. In `BoardFeatureTrackerObj`, bind the imported ONNX to `MLComponent.Model`.
3. Verify `MLComponent.state` transitions from 3 to 2 (Idle) and the model's
   input/output ports match the expected shapes (`image: [1,1,480,640]`,
   `descriptor_map: [1,64,60,80]`, `keypoint_logits: [1,65,60,80]`,
   `heatmap: [1,1,60,80]`).
4. Remove the old stale `xfeat_backbone_simplified.onnx` from
   `CircuitBoards/Assets/` (the one committed in `4d71b0e` with the opset-18
   noop_with_empty_axes strip) — it's superseded by v2.
5. Commit the `modules/model.py` patch under the `models/xfeat` directory,
   along with the build scripts and this fix log.

## Op probe files (kept at project root for future bisections)

All sanity + suspect + replacement probes are still at the project root:
```
tiny_conv_opset11.onnx          (sanity)
tiny_conv_opset17.onnx          (sanity)
tiny_instancenorm_opset11.onnx  (passes)
tiny_resize_bilinear_opset11.onnx      (FAILS — bilinear Resize)
tiny_unfold_opset11.onnx                (FAILS — unfold expansion)
tiny_upsample_nearest_opset11.onnx      (passes)
tiny_convtranspose_2x_opset11.onnx      (passes)
tiny_reshape_permute_unfold_opset11.onnx     (FAILS — rank-6)
tiny_pixel_unshuffle_opset11.onnx            (FAILS — rank-6)
tiny_strided_conv_unfold_opset11.onnx        (passes)
tiny_spacetodepth_native_opset11.onnx        (FAILS — SpaceToDepth not supported)
tiny_convtranspose_bilinear_opset11.onnx     (passes)
```

These are not committed (they're at root, not in `CircuitBoards/Assets/`).
Consider moving them into a `models/xfeat/probes/` directory if the import
issue resurfaces for another op.

### Strided Conv identity kernel — why it's equivalent to `_unfold2d(x, ws=8)` for C=1

`_unfold2d(x, ws=8)` on `[1, 1, H, W]` produces `[1, 64, H/8, W/8]` where
channel `c` of each output tile picks up input position `(i=c//8, j=c%8)` of
the corresponding 8×8 input block. A strided Conv with:
- in_channels = 1, out_channels = 64, kernel_size = 8, stride = 8
- `weight[c, 0, i, j] = 1.0 if c == i*8+j else 0.0`

produces `output[b, c, y, x] = input[b, 0, y*8 + c//8, x*8 + c%8]`, which is
exactly the same layout. Probe reports `max|diff| = 0.000e+00` vs `_unfold2d`.

XFeat's single `_unfold2d` call site has `C=1` (after `x.mean(dim=1, keepdim=True)`
and InstanceNorm), so this is a direct drop-in — no retraining required.

### If upsample-nearest passes
Patch `modules/model.py`:
```python
# Before
x4 = F.interpolate(x4, (x3.shape[-2], x3.shape[-1]), mode='bilinear')
x5 = F.interpolate(x5, (x3.shape[-2], x3.shape[-1]), mode='bilinear')

# After
x4 = F.interpolate(x4, (x3.shape[-2], x3.shape[-1]), mode='nearest')
x5 = F.interpolate(x5, (x3.shape[-2], x3.shape[-1]), mode='nearest')
```

Numerical impact: minimal for feature matching (the downstream keypoint head
collapses spatial info anyway), but expect small drift in matching scores.

### If reshape-permute-unfold passes
Patch `modules/model.py`:
```python
def _unfold2d(self, x, ws=2):
    B, C, H, W = x.shape
    x = x.reshape(B, C, H // ws, ws, W // ws, ws)
    x = x.permute(0, 1, 3, 5, 2, 4)
    return x.reshape(B, C * ws * ws, H // ws, W // ws)
```

Semantically **identical** to the unfold-based version. Output bytes should match.

### Fallbacks (only if primary candidates fail LS)
- **ConvTranspose2d** if even nearest-mode Resize fails: fixed bilinear-weight kernel,
  groups=num_channels to keep per-channel behavior.
- **Strided Conv2d with fixed kernel** if reshape+permute also fails: compile
  `_unfold2d(ws=8)` into a single Conv2d with kernel_size=8, stride=8, and an
  identity-per-output-channel weight tensor of shape `[C*64, C, 8, 8]`.

## Re-export plan once replacements validate

1. Patch `models/xfeat/accelerated_features/modules/model.py` in place
   (working tree only; don't commit upstream).
2. Run `python models/xfeat/export_backbone_opset11.py` to re-export and simplify.
3. Copy the simplified ONNX to the project root (not Assets/) for manual import.
4. User imports via File > Import Asset in LS.
5. Verify MLComponent.state transitions from 3 → 2 (Idle) with the new model bound.
6. Re-run numerical parity check vs the unpatched PyTorch backbone to quantify
   the drift introduced by nearest-neighbor upsample.

## Files written by this debugging session

**Scripts:**
- `models/xfeat/export_backbone_opset11.py` — opset 11 re-export harness
- `models/xfeat/build_op_probes.py` — suspect-op isolation probes
- `models/xfeat/build_replacement_probes.py` — replacement candidate probes

**Probe ONNX files at project root (not under Assets/, not committed):**
- `tiny_conv_opset11.onnx`, `tiny_conv_opset17.onnx` — sanity
- `tiny_instancenorm_opset11.onnx` — InstanceNorm isolated
- `tiny_resize_bilinear_opset11.onnx` — FAILS, Resize bilinear
- `tiny_unfold_opset11.onnx` — FAILS, unfold chain
- `tiny_upsample_nearest_opset11.onnx` — replacement candidate
- `tiny_convtranspose_2x_opset11.onnx` — replacement candidate fallback
- `tiny_reshape_permute_unfold_opset11.onnx` — replacement candidate
- `tiny_pixel_unshuffle_opset11.onnx` — replacement candidate

**ONNX artifacts in `models/xfeat/`:** raw and simplified dynamo/legacy exports
at opset 11 and 17. The `xfeat_backbone_simplified.onnx` that's committed in
`CircuitBoards/Assets/` is the opset-18 stripped version from `4d71b0e`.
