# LS FastDNN: Hardware Constraints and Compatible Architecture Space

## Why the limitations exist

Snap Spectacles run on a Qualcomm SoC with a dedicated NPU (Neural Processing Unit). NPUs are not GPUs. They are fixed-function matrix engines optimized for one fused pipeline stage: `Conv -> BN -> ReLU -> Pool`. This is what 95% of production mobile vision models looked like when Snap built FastDNN (~2020-2021, MobileNet/EfficientNet era).

FastDNN compiles ONNX graphs down to this NPU. The op limitations are not software bugs or missing implementations. They are constraints of the silicon itself.

### Normalization

NPU hardware fuses BatchNorm into the preceding Conv as a per-channel scale+bias (two multiplies at zero additional cost). This fusion requires the normalization to be per-channel with fixed statistics.

- **BatchNorm**: Supported everywhere (CPU, iPhone GPU, iPhone NPU, Android GPU). Fused at compile time.
- **InstanceNorm**: Supported on CPU, iPhone GPU, Android GPU. NOT on iPhone NPU.
- **LayerNorm**: Not supported. Requires a runtime reduction across channels, which breaks the fusion pipeline. The NPU has no execution unit for cross-channel reductions at normalization granularity.
- **GroupNorm**: Not supported. Same reason as LayerNorm: requires reduction across channel subsets that don't align with the per-channel fusion.

### Activations

NPUs implement activations via hardware lookup tables (LUTs) burned into the chip.

| Activation | Supported | Why |
|---|---|---|
| ReLU, ReLU6 | Yes (all backends) | Trivial: `max(0, x)` or `min(6, max(0, x))` |
| LeakyReLU, PReLU, ELU | Yes (all backends) | Simple piecewise functions, standard LUT entries |
| Sigmoid, Tanh | Yes (all backends) | Standard LUT entries since the LSTM era |
| GELU | No | `x * Phi(x)` was not in the LUT when silicon was taped out. Decomposition into `x * 0.5 * (1 + tanh(sqrt(2/pi) * (x + 0.044715 * x^3)))` would work in theory but FastDNN does not perform automatic op decomposition. |
| SiLU / Swish | No | `x * sigmoid(x)`. Same issue. Manual decomposition into `Mul(x, Sigmoid(x))` using supported ops should work but is not tested. |
| Softplus, Softsign | CPU + iPhone GPU + Android GPU only | Not on NPU |

### Spatial operations

| Op | CPU | iPhone GPU | iPhone NPU | Android GPU | Notes |
|---|---|---|---|---|---|
| Conv2d | Y | Y | Y | Y | Same dilation/stride in H/W; padding <= kernel |
| DepthwiseConv2d | Y | Y | Y | Y | Android GPU: group must be 1 or exactly depthwise |
| ConvTranspose2d | Y | Y | Y | Y | Dilation=1; same stride/padding/kernel in H/W |
| MaxPool | Y | Y | Y | Y | |
| AvgPool | Y | Y | Y | Y | Empirically fails with large kernels (k=4, s=4). Workaround: F.conv2d with uniform 1/(k*k) weight. |
| GlobalAvgPool | Y | Y | Y | Y | |
| Resize nearest | Y | Y | Y | Y | Equal H/W scale |
| Resize bilinear | Y | Y | Y | Y | Officially supported but empirically failed in XFeat probes. Workaround: ConvTranspose2d with bilinear-weight kernels. |
| grid_sample | No | No | No | No | Spatial transformer op. Requires bilinear interpolation at arbitrary float coordinates. GPUs have texture units for this; NPUs do not. |
| PixelShuffle | No | No | No | No | Exports as Reshape+Transpose with rank-6 intermediate, which exceeds rank-4 limit. |
| SpaceToDepth | No | No | No | No | Not in compatibility table at all. |

### Tensor operations

| Op | CPU | iPhone GPU | iPhone NPU | Android GPU | Notes |
|---|---|---|---|---|---|
| Reshape | Y | Y | N | Y | Rank must stay <= 4 |
| Permute | Y | Y | N | Y | Rank must stay <= 4 |
| Concat | Y | Y | Y | Y | Batch and channel axis only |
| Slice | Y | Y | N | Y | |
| Flatten | Y | Y | N | Y | |
| Split | - | - | - | - | Not in compatibility table |
| Softmax | Y | Y | Y | Y | Channel axis only |
| MatMul / Gemm | Y | Y | Y | Y | Via "Fully Connected" |
| Batch MatMul | Y | Y | N | N | No NPU, no Android GPU |
| Einsum | - | - | - | - | Not in compatibility table |

### Reductions

| Op | CPU | iPhone GPU | iPhone NPU | Android GPU | Notes |
|---|---|---|---|---|---|
| ReduceMean | Y | Y | N | Y | Axes: N, C, HW, HWC only |
| ReduceMax | Y | Y | N | Y | Same axis constraints |
| ReduceSum | - | - | - | - | Not in compatibility table |
| Argmax/Argmin | Y | Y | N | Y | Channel axis only |

## Hard rules

1. **Max tensor rank = 4 (NCHW).** Any intermediate above rank 4 kills the graph. This means no `view(B, C, H, W, ...)` tricks, no einsum with batch dimensions.
2. **No modern activations.** GELU, SiLU, Mish must be manually decomposed before export.
3. **No normalization beyond BatchNorm and InstanceNorm.**
4. **Import success != runtime success.** FastDNN import and MLComponent runtime binding are separate validation stages. Always test end-to-end with a bound MLComponent in a running scene.
5. **Export at opset 11.** Avoids modern ONNX attributes (e.g. `noop_with_empty_axes` on ReduceMean from opset 13+) that LS silently rejects.
6. **Input values are [0, 255]** from camera textures. Set scale=0.00392 for [0,1] normalization at import, or train on [0,255] inputs.
7. **10MB total model size limit** for all ML assets in a Lens. Use K-Means quantization (8-bit or 16-bit).
8. **Concat only on batch or channel axis.** Spatial-axis concat is not supported.
9. **Softmax and Argmax only on channel axis.**

## Compatible architecture families

These work: MobileNetV2, EfficientNet-Lite, YOLOv7-tiny, simple CNNs with Conv+BN+ReLU blocks, U-Nets with nearest-neighbor upsampling or ConvTranspose2d, HomographyNet-style regression networks.

These do NOT work without significant surgery: any transformer (LayerNorm, GELU, attention), ViT, DETR, LoFTR, LightGlue, anything with spatial transformers / grid_sample, anything using GroupNorm.

**The compatible design space is: anything that could have shipped as a MobileNet variant circa 2020.**

## Workaround recipes

### Bilinear upsampling -> ConvTranspose2d
```python
# Replace F.interpolate(x, scale_factor=2, mode='bilinear')
# with ConvTranspose2d using bilinear-weight kernel:
def make_bilinear_convtranspose(in_channels):
    k = 4  # kernel size for 2x upsample
    ct = nn.ConvTranspose2d(in_channels, in_channels, k, stride=2, padding=1,
                            groups=in_channels, bias=False)
    # Fill with bilinear weights
    w = torch.zeros(k, k)
    for i in range(k):
        for j in range(k):
            w[i,j] = (1 - abs(i - 1.5) / 2) * (1 - abs(j - 1.5) / 2)
    ct.weight.data[:] = w.unsqueeze(0).unsqueeze(0)
    ct.weight.requires_grad_(False)
    return ct
```

### AvgPool large kernel -> Conv2d with uniform weights
```python
# Replace F.avg_pool2d(x, 4, 4)
# with depthwise conv using uniform 1/16 kernel:
def make_avgpool_conv(in_channels, k=4):
    conv = nn.Conv2d(in_channels, in_channels, k, stride=k,
                     groups=in_channels, bias=False)
    conv.weight.data[:] = 1.0 / (k * k)
    conv.weight.requires_grad_(False)
    return conv
```

### SiLU -> manual decomposition
```python
# Replace nn.SiLU()
class SiLU_Decomposed(nn.Module):
    def forward(self, x):
        return x * torch.sigmoid(x)  # Mul and Sigmoid both supported
```

## References

- Snap ML compatibility table: developers.snap.com/lens-studio/features/snap-ml/compatibility
- XFeat bisection log: `docs/xfeat-ls-import-fixes.md` (394 lines of empirical probe results)
- Session handoff: `SESSION_HANDOFF.md` (runtime build freeze analysis)
