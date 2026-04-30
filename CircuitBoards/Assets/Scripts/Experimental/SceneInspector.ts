/**
 * SceneInspector - Lens Studio component that streams the live scene graph
 * to the inspector over WebSocket.
 *
 * Drop this onto any SceneObject in your project. It walks the entire scene
 * tree every N frames and sends a JSON snapshot to the connected viewer.
 * Captures both design-time and runtime-created objects, including full
 * component introspection for all standard LS types.
 *
 * Setup:
 *   1. Copy this file into your LS project's Assets folder
 *   2. Attach to any SceneObject (e.g. Camera)
 *   3. Enable Experimental APIs in Project Settings > General
 *   4. Hit Play -- the editor plugin auto-connects, or use `npx scene-inspector`
 *      for a standalone browser viewer
 */

// @ts-nocheck - LS types not available outside Lens Studio

@component
export class SceneInspector extends BaseScriptComponent {
  @input
  @hint("Inspector server URL. Change port if you ran: npx scene-inspector --port XXXX")
  public wsUrl: string = "ws://localhost:8200?role=ls";

  @input
  @hint("How often to send snapshots (frames between updates)")
  public updateInterval: number = 15; // ~2Hz at 30fps

  @input
  @hint("Max tree depth to traverse (prevents runaway recursion)")
  public maxDepth: number = 20;

  private internetModule: any = null;
  private ws: any = null;
  private wsId: number = 0; // monotonic id to detect stale handlers
  private connected: boolean = false;
  private frameCounter: number = 0;
  private reconnectCountdown: number = -1;
  private static RECONNECT_FRAMES = 90; // ~3s at 30fps

  onAwake() {
    this.createEvent("OnStartEvent").bind(() => {
      this.connect();
    });

    this.createEvent("UpdateEvent").bind(() => {
      // Reconnect timer (counts down frames, no leaked events)
      if (this.reconnectCountdown > 0) {
        this.reconnectCountdown--;
        if (this.reconnectCountdown === 0) {
          this.reconnectCountdown = -1;
          this.connect();
        }
        return;
      }
      if (!this.connected) return;
      this.frameCounter++;
      if (this.frameCounter >= this.updateInterval) {
        this.frameCounter = 0;
        this.sendSnapshot();
      }
    });

    this.createEvent("OnDestroyEvent").bind(() => {
      this.reconnectCountdown = -1;
      if (this.ws) try { this.ws.close(); } catch (e) {}
    });
  }

  private connect() {
    try {
      this.internetModule = require("LensStudio:InternetModule") as any;
    } catch (e) {
      print("[SceneInspector] ERROR: Could not load InternetModule: " + e);
      return;
    }

    print("[SceneInspector] Connecting to " + this.wsUrl);
    var ws = this.internetModule.createWebSocket(this.wsUrl);
    var id = ++this.wsId;
    this.ws = ws;
    var self = this;

    ws.addEventListener("open", function () {
      if (id !== self.wsId) return; // stale connection
      self.connected = true;
      print("[SceneInspector] Connected");
      self.sendSnapshot();
    });

    ws.addEventListener("close", function () {
      if (id !== self.wsId) return; // stale connection
      self.connected = false;
      // Silent disconnect, no auto-reconnect
      self.reconnectCountdown = -1;
    });

    ws.addEventListener("error", function (err: any) {
      print("[SceneInspector] WS error: " + err);
    });
  }

  private sendSnapshot() {
    if (!this.ws || !this.connected) return;

    var scene = global.scene;
    var rootCount = scene.getRootObjectsCount();
    var children: any[] = [];

    for (var i = 0; i < rootCount; i++) {
      var rootObj = scene.getRootObject(i);
      var node = this.walkObject(rootObj, 0);
      if (node) children.push(node);
    }

    var payload = JSON.stringify({
      event: "scene_snapshot",
      ts: Date.now(),
      roots: children,
      totalObjects: this.countNodes(children),
    });

    try {
      this.ws.send(payload);
    } catch (e) {
      print("[SceneInspector] Send error: " + e);
    }
  }

  private classifyComponent(typeName: string): string {
    // Map LS component types to categories for the viewer
    if (typeName.includes("Camera")) return "camera";
    if (typeName.includes("Light") || typeName === "LightSource") return "light";
    if (typeName.includes("RenderMeshVisual") || typeName.includes("Image") ||
        typeName.includes("FaceMask") || typeName.includes("FaceInset") ||
        typeName.includes("Cloth") || typeName.includes("PostEffect") ||
        typeName.includes("Liquify") || typeName.includes("Retouch") ||
        typeName.includes("EyeColor") || typeName.includes("Hair") ||
        typeName.includes("SpriteVisual") || typeName.includes("ClearScreen")) return "visual";
    if (typeName.includes("Text3D") || typeName.includes("Text")) return "text";
    if (typeName.includes("Script") || typeName.includes("SceneInspector") ||
        typeName.includes("RuntimeSpawner")) return "script";
    if (typeName.includes("Audio")) return "audio";
    if (typeName.includes("Animation") || typeName.includes("AnimationMixer") ||
        typeName.includes("AnimationPlayer") || typeName.includes("BlendShapes")) return "animation";
    if (typeName.includes("Body") || typeName.includes("Collider") ||
        typeName.includes("Constraint") || typeName.includes("WorldComponent") ||
        typeName.includes("Physics")) return "physics";
    if (typeName.includes("VFX") || typeName.includes("Particle")) return "vfx";
    if (typeName.includes("Interaction") || typeName.includes("Manipulate")) return "interaction";
    if (typeName.includes("Tracking") || typeName.includes("DeviceTracking") ||
        typeName.includes("Head") || typeName.includes("Landmarker") ||
        typeName.includes("MarkerTracking") || typeName.includes("ObjectTracking")) return "tracking";
    if (typeName.includes("ScreenTransform") || typeName.includes("ScreenRegion") ||
        typeName.includes("Canvas") || typeName.includes("RectangleSetter")) return "ui";
    if (typeName.includes("ML") || typeName.includes("SnapML")) return "ml";
    if (typeName.includes("LookAt") || typeName.includes("PinToMesh") ||
        typeName.includes("Hints") || typeName.includes("Skin")) return "utility";
    return "unknown";
  }

  private processComponent(comp: any, typeName: string, components: any[]) {
    var category = this.classifyComponent(typeName);
    var compInfo: any = {
      type: typeName,
      enabled: comp.enabled !== false,
      category: category,
    };

    // Extract text content
    if (typeName === "Text" || typeName === "Component.Text") {
      compInfo.text = comp.text || null;
      if (comp.size !== undefined) compInfo.textSize = comp.size;
    }
    if (typeName === "Text3D" || typeName === "Component.Text3D") {
      compInfo.text = comp.text || null;
    }

    // Extract visual info
    if (category === "visual") {
      try {
        var mat = comp.mainMaterial;
        if (mat && mat.mainPass) {
          var bc = mat.mainPass["baseColor"];
          if (bc) compInfo._color = [
            Math.round(bc.x * 255),
            Math.round(bc.y * 255),
            Math.round(bc.z * 255),
            Math.round(bc.w * 255),
          ];
          compInfo.materialName = mat.name || null;
        }
      } catch (e) {}
      try {
        if (comp.mesh) compInfo.meshName = comp.mesh.name || null;
      } catch (e) {}
    }

    // Extract script info
    if (category === "script") {
      try {
        if (comp.scriptAsset) compInfo.scriptName = comp.scriptAsset.name || null;
      } catch (e) {}
    }

    // Extract camera info
    if (category === "camera") {
      try {
        compInfo.cameraType = comp.cameraType === 1 ? "orthographic" : "perspective";
        if (comp.fov !== undefined) compInfo.fov = comp.fov;
        if (comp.size !== undefined) compInfo.orthoSize = comp.size;
        if (comp.near !== undefined) compInfo.near = comp.near;
        if (comp.far !== undefined) compInfo.far = comp.far;
        compInfo.renderOrder = comp.renderOrder || 0;
      } catch (e) {}
    }

    // Extract physics info
    if (category === "physics") {
      try {
        if (comp.dynamic !== undefined) compInfo.dynamic = comp.dynamic;
        if (comp.mass !== undefined) compInfo.mass = comp.mass;
      } catch (e) {}
    }

    // Extract audio info
    if (category === "audio") {
      try {
        if (comp.volume !== undefined) compInfo.volume = comp.volume;
        if (comp.audioTrack) compInfo.trackName = comp.audioTrack.name || null;
      } catch (e) {}
    }

    components.push(compInfo);
  }

  // Known LS component types to probe individually when generic lookup fails
  private static KNOWN_TYPES: string[] = [
    "Camera",
    "ScriptComponent",
    "RenderMeshVisual",
    "Image",
    "Text",
    "Text3D",
    "LightSource",
    "ScreenTransform",
    "ScreenRegionComponent",
    "Canvas",
    "AnimationMixer",
    "AnimationPlayer",
    "AudioComponent",
    "AudioListenerComponent",
    "VFXComponent",
    "BodyComponent",
    "ColliderComponent",
    "WorldComponent",
    "InteractionComponent",
    "ManipulateComponent",
    "DeviceTracking",
    "ObjectTracking3D",
    "MarkerTrackingComponent",
    "Head",
    "BlendShapes",
    "SpriteVisual",
    "PostEffectVisual",
    "FaceMaskVisual",
    "FaceInsetVisual",
    "RectangleSetter",
    "PinToMeshComponent",
    "LookAtComponent",
    "ClothVisual",
    "HintsComponent",
    "SkinComponent",
    "MLComponent",
    "RetouchVisual",
    "EyeColorVisual",
    "HairVisual",
    "LiquifyVisual",
    "ClearScreenComponent",
    "ParticlesVisual",
  ];

  private walkObject(obj: SceneObject, depth: number): any {
    if (depth > this.maxDepth) return null;

    var t = obj.getTransform();
    var pos = t.getWorldPosition();
    var scl = t.getWorldScale();
    var rot = t.getWorldRotation();

    // Gather components
    var components: any[] = [];
    var text: string | null = null;
    var hasVisual = false;
    var color: number[] | null = null;
    var primaryCategory = "empty";

    // Try generic component lookup first
    var compCount = obj.getComponentCount("Component");
    if (compCount > 0) {
      for (var ci = 0; ci < compCount; ci++) {
        try {
          var comp = obj.getComponentByIndex("Component", ci) as any;
          var typeName = comp.getTypeName ? comp.getTypeName() : "Unknown";
          this.processComponent(comp, typeName, components);
        } catch (e) {}
      }
    } else {
      // Fallback: probe each known type individually.
      // getComponentCount("Component") returns 0 in some LS versions
      // but type-specific lookups still work.
      for (var ti = 0; ti < SceneInspector.KNOWN_TYPES.length; ti++) {
        var probeName = SceneInspector.KNOWN_TYPES[ti];
        try {
          var probeCount = obj.getComponentCount(probeName);
          for (var pi = 0; pi < probeCount; pi++) {
            try {
              var probeComp = obj.getComponentByIndex(probeName, pi) as any;
              var probeTypeName = probeComp.getTypeName ? probeComp.getTypeName() : probeName;
              this.processComponent(probeComp, probeTypeName, components);
            } catch (e2) {}
          }
        } catch (e3) {}
      }
    }

    // Derive category and visual flags from collected components
    for (var ci2 = 0; ci2 < components.length; ci2++) {
      var compInfo = components[ci2];
      var category = compInfo.category;
      if (compInfo.text) text = compInfo.text;
      if (category === "visual") hasVisual = true;
      if (compInfo._color) color = compInfo._color;

      if (primaryCategory === "empty" || primaryCategory === "unknown") {
        if (category !== "unknown") primaryCategory = category;
      }
      if (category === "camera" || category === "script" || category === "visual" || category === "text") {
        if (primaryCategory !== "camera") primaryCategory = category;
      }
    }

    // Clean internal fields
    for (var ci3 = 0; ci3 < components.length; ci3++) {
      delete components[ci3]._color;
    }

    // Get layer info
    var layerName = null;
    try {
      var layer = obj.layer;
      if (layer) layerName = layer.toString();
    } catch (e) {}

    // Walk children
    var childNodes: any[] = [];
    var childCount = obj.getChildrenCount();
    for (var ki = 0; ki < childCount; ki++) {
      var child = obj.getChild(ki);
      var childNode = this.walkObject(child, depth + 1);
      if (childNode) childNodes.push(childNode);
    }

    return {
      name: obj.name,
      enabled: obj.enabled,
      category: primaryCategory,
      pos: [+pos.x.toFixed(3), +pos.y.toFixed(3), +pos.z.toFixed(3)],
      scale: [+scl.x.toFixed(3), +scl.y.toFixed(3), +scl.z.toFixed(3)],
      rot: [+rot.x.toFixed(3), +rot.y.toFixed(3), +rot.z.toFixed(3), +rot.w.toFixed(3)],
      components,
      text,
      hasVisual,
      color,
      layer: layerName,
      children: childNodes,
    };
  }

  private countNodes(nodes: any[]): number {
    var count = 0;
    for (var i = 0; i < nodes.length; i++) {
      count += 1 + this.countNodes(nodes[i].children || []);
    }
    return count;
  }
}
