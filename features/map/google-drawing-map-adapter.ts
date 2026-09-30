import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import type { Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { pointInScreenPolygon } from "@/features/drawing/pencil";

export type GoogleRenderingType = "RASTER" | "UNINITIALIZED" | "VECTOR";

export type GoogleMapsEventListener = {
  remove: () => void;
};

type GooglePoint = { x: number; y: number };
type GoogleLatLng = { lat: () => number; lng: () => number };

type GoogleMapCanvasProjection = {
  fromContainerPixelToLatLng: (
    point: GooglePoint,
    noClampNoWrap?: boolean,
  ) => GoogleLatLng | null;
  fromLatLngToContainerPixel: (
    latLng: { lat: number; lng: number },
  ) => GooglePoint | null;
  fromLatLngToDivPixel: (latLng: GoogleLatLng) => GooglePoint | null;
  getWorldWidth: () => number;
};

export type GoogleMap = {
  getRenderingType: () => GoogleRenderingType;
  setOptions: (options: Record<string, unknown>) => void;
};

type GoogleOverlayView = {
  draw(): void;
  getPanes(): { overlayLayer: Element } | null;
  getProjection(): GoogleMapCanvasProjection;
  onAdd(): void;
  onRemove(): void;
  setMap(map: GoogleMap | null): void;
};

export type GoogleMapsNamespace = {
  Map: new (
    element: HTMLElement,
    options: Record<string, unknown>,
  ) => GoogleMap;
  MapTypeId: { ROADMAP: string };
  OverlayView: new () => GoogleOverlayView;
  Point: new (x: number, y: number) => GooglePoint;
  RenderingType: { VECTOR: GoogleRenderingType };
  event: {
    addListenerOnce: (
      instance: GoogleMap,
      eventName: string,
      handler: () => void,
    ) => GoogleMapsEventListener;
    clearInstanceListeners: (instance: GoogleMap) => void;
  };
};

export type GoogleDrawingMode =
  | "Navigate"
  | "Pencil"
  | "Move area"
  | "Deform area";

type AdapterOptions = {
  container: HTMLDivElement;
  map: GoogleMap;
  maps: GoogleMapsNamespace;
  onCompletedDrawingCountChange: (count: number) => void;
  onModeChange: (mode: GoogleDrawingMode) => void;
};

type DrawingLayer = {
  id: string;
  type: "circle" | "fill" | "line";
  source: string;
  filter?: unknown;
  paint?: Record<string, unknown>;
};

type DrawingSource = {
  data: FeatureCollection;
  setData: (data: FeatureCollection) => void;
};

type AdapterEventName = "mousedown" | "mousemove" | "mouseup";
type AdapterEventHandler = (event: MapMouseEvent) => void;
type ScreenPoint = { x: number; y: number };

const COMPLETED_SOURCE_ID = "worldrawing-completed-drawings";
const COMPLETED_FILL_LAYER_ID = "worldrawing-completed-drawings-fill";

function isFeatureCollection(value: unknown): value is FeatureCollection {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "FeatureCollection" &&
    "features" in value &&
    Array.isArray(value.features)
  );
}

function distanceToSegment(
  point: ScreenPoint,
  start: ScreenPoint,
  end: ScreenPoint,
) {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSquared = segmentX * segmentX + segmentY * segmentY;

  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const ratio = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * segmentX +
        (point.y - start.y) * segmentY) /
        lengthSquared,
    ),
  );

  return Math.hypot(
    point.x - (start.x + segmentX * ratio),
    point.y - (start.y + segmentY * ratio),
  );
}

function propertyValue(
  expression: unknown,
  properties: Record<string, unknown>,
) {
  if (
    Array.isArray(expression) &&
    expression[0] === "get" &&
    typeof expression[1] === "string"
  ) {
    return properties[expression[1]];
  }

  return expression;
}

function resolvedPaintValue(
  value: unknown,
  properties: Record<string, unknown>,
): unknown {
  if (!Array.isArray(value) || value[0] !== "match" || value.length < 5) {
    return value;
  }

  const input = propertyValue(value[1], properties);
  for (let index = 2; index < value.length - 1; index += 2) {
    if (input === value[index]) return value[index + 1];
  }

  return value.at(-1);
}

function matchesFilter(
  filter: unknown,
  properties: Record<string, unknown>,
) {
  if (!Array.isArray(filter) || filter[0] !== "==") return true;
  return propertyValue(filter[1], properties) === filter[2];
}

function featureProperties(feature: Feature<Geometry>) {
  return feature.properties ?? {};
}

export class GoogleDrawingMapAdapter {
  private readonly container: HTMLDivElement;
  private readonly map: GoogleMap;
  private readonly maps: GoogleMapsNamespace;
  private readonly canvas = document.createElement("canvas");
  private readonly sources = new Map<string, DrawingSource>();
  private readonly layers = new Map<string, DrawingLayer>();
  private readonly handlers: Record<
    AdapterEventName,
    Set<AdapterEventHandler>
  > = {
    mousedown: new Set(),
    mousemove: new Set(),
    mouseup: new Set(),
  };
  private readonly overlay: GoogleOverlayView;
  private readonly resizeObserver: ResizeObserver;
  private readonly onCompletedDrawingCountChange: (count: number) => void;
  private readonly onModeChange: (mode: GoogleDrawingMode) => void;
  private projection: GoogleMapCanvasProjection | null = null;
  private renderFrame: number | null = null;
  private completedDrawingCount = 0;
  private mode: GoogleDrawingMode = "Navigate";
  private spacePressed = false;
  private dragPanEnabled = true;
  private capturedPointerId: number | null = null;
  private stopped = false;
  private resolveReady!: () => void;
  private readonly readyPromise: Promise<void>;

  readonly dragPan = {
    enable: () => {
      if (this.dragPanEnabled) return;
      this.dragPanEnabled = true;
      this.map.setOptions({ gestureHandling: "greedy" });
      if (!this.spacePressed) this.setMode("Navigate");
    },
    disable: () => {
      if (!this.dragPanEnabled) return;
      this.dragPanEnabled = false;
      this.map.setOptions({ gestureHandling: "none" });
    },
    isEnabled: () => this.dragPanEnabled,
  };

  readonly dragRotate = {
    enable: () => undefined,
    disable: () => undefined,
    isEnabled: () => false,
  };

  constructor({
    container,
    map,
    maps,
    onCompletedDrawingCountChange,
    onModeChange,
  }: AdapterOptions) {
    this.container = container;
    this.map = map;
    this.maps = maps;
    this.onCompletedDrawingCountChange = onCompletedDrawingCountChange;
    this.onModeChange = onModeChange;
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    this.canvas.setAttribute("aria-hidden", "true");
    Object.assign(this.canvas.style, {
      position: "absolute",
      display: "block",
      pointerEvents: "none",
    });

    const adapter = this;
    class DrawingOverlay extends maps.OverlayView {
      override onAdd() {
        const panes = this.getPanes();
        if (panes) adapter.attachCanvas(panes.overlayLayer);
      }

      override draw() {
        adapter.projection = this.getProjection();
        adapter.resolveReady();
        adapter.requestRender();
      }

      override onRemove() {
        adapter.canvas.remove();
        adapter.projection = null;
      }
    }

    this.overlay = new DrawingOverlay();
    this.resizeObserver = new ResizeObserver(() => this.requestRender());
    this.resizeObserver.observe(container);
    this.addDomListeners();
    this.overlay.setMap(map);
  }

  whenReady() {
    return this.readyPromise;
  }

  asMapLibreMap() {
    return this as unknown as MapLibreMap;
  }

  addSource(id: string, specification: unknown) {
    const candidate = specification as { type?: unknown; data?: unknown };
    if (candidate.type !== "geojson" || !isFeatureCollection(candidate.data)) {
      throw new Error(`Unsupported benchmark drawing source: ${id}`);
    }

    const source: DrawingSource = {
      data: candidate.data,
      setData: (data) => {
        source.data = data;
        if (id === COMPLETED_SOURCE_ID) {
          this.updateCompletedDrawingCount(data.features.length);
        }
        this.requestRender();
      },
    };
    this.sources.set(id, source);
    if (id === COMPLETED_SOURCE_ID) {
      this.updateCompletedDrawingCount(candidate.data.features.length);
    }
    this.requestRender();
  }

  getSource(id: string) {
    return this.sources.get(id);
  }

  removeSource(id: string) {
    this.sources.delete(id);
    this.requestRender();
  }

  addLayer(specification: unknown) {
    const layer = specification as DrawingLayer;
    if (
      typeof layer.id !== "string" ||
      typeof layer.source !== "string" ||
      !["circle", "fill", "line"].includes(layer.type)
    ) {
      throw new Error("Unsupported benchmark drawing layer.");
    }

    this.layers.set(layer.id, layer);
    this.requestRender();
  }

  getLayer(id: string) {
    return this.layers.get(id);
  }

  removeLayer(id: string) {
    this.layers.delete(id);
    this.requestRender();
  }

  project(lngLat: { lng: number; lat: number }) {
    const point = this.projection?.fromLatLngToContainerPixel(lngLat);
    if (!point) return { x: Number.NaN, y: Number.NaN };
    return { x: point.x, y: point.y };
  }

  unproject(point: [number, number] | ScreenPoint) {
    const x = Array.isArray(point) ? point[0] : point.x;
    const y = Array.isArray(point) ? point[1] : point.y;
    const lngLat = this.projection?.fromContainerPixelToLatLng(
      new this.maps.Point(x, y),
      true,
    );

    return {
      lng: lngLat?.lng() ?? Number.NaN,
      lat: lngLat?.lat() ?? Number.NaN,
    };
  }

  queryRenderedFeatures(
    geometry: [number, number] | [[number, number], [number, number]],
    options?: { layers?: string[] },
  ) {
    const layerIds = options?.layers ?? [...this.layers.keys()];
    const point =
      typeof geometry[0] === "number"
        ? { x: geometry[0], y: geometry[1] as number }
        : null;
    const results: Array<{ properties: Record<string, unknown> }> = [];

    for (const layerId of layerIds.toReversed()) {
      const layer = this.layers.get(layerId);
      const source = layer ? this.sources.get(layer.source) : undefined;
      if (!layer || !source) continue;

      for (const feature of source.data.features.toReversed()) {
        if (feature.geometry.type !== "Polygon") continue;
        const properties = featureProperties(feature);

        if (
          layer.type === "fill" &&
          point &&
          this.polygonContainsPoint(feature.geometry.coordinates[0], point)
        ) {
          results.push({ properties });
        } else if (layer.type === "line" && !point) {
          results.push({ properties });
        }
      }
    }

    return results;
  }

  getCanvas() {
    return this.container;
  }

  on(eventName: AdapterEventName, handler: AdapterEventHandler) {
    this.handlers[eventName].add(handler);
  }

  off(eventName: AdapterEventName, handler: AdapterEventHandler) {
    this.handlers[eventName].delete(handler);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.capturedPointerId !== null) {
      this.releasePointer(this.capturedPointerId);
    }
    this.removeDomListeners();
    this.resizeObserver.disconnect();
    if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame);
    this.renderFrame = null;
    this.overlay.setMap(null);
    this.sources.clear();
    this.layers.clear();
  }

  private attachCanvas(pane: Element) {
    if (!this.canvas.isConnected) pane.append(this.canvas);
  }

  private updateCompletedDrawingCount(count: number) {
    if (count === this.completedDrawingCount) return;
    this.completedDrawingCount = count;
    this.onCompletedDrawingCountChange(count);
  }

  private setMode(mode: GoogleDrawingMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.onModeChange(mode);
  }

  private requestRender() {
    if (this.renderFrame !== null || this.stopped) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = null;
      this.render();
    });
  }

  private render() {
    if (!this.projection || !this.canvas.isConnected) return;
    const bounds = this.container.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const containerOrigin = this.projection.fromContainerPixelToLatLng(
      new this.maps.Point(0, 0),
      true,
    );
    const paneOrigin = containerOrigin
      ? this.projection.fromLatLngToDivPixel(containerOrigin)
      : null;
    if (paneOrigin) {
      this.canvas.style.left = `${paneOrigin.x}px`;
      this.canvas.style.top = `${paneOrigin.y}px`;
    }
    this.canvas.style.width = `${bounds.width}px`;
    this.canvas.style.height = `${bounds.height}px`;
    const pixelWidth = Math.max(1, Math.round(bounds.width * ratio));
    const pixelHeight = Math.max(1, Math.round(bounds.height * ratio));
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;

    const context = this.canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, bounds.width, bounds.height);

    for (const layer of this.layers.values()) {
      const source = this.sources.get(layer.source);
      if (!source) continue;

      for (const feature of source.data.features) {
        const properties = featureProperties(feature);
        if (!matchesFilter(layer.filter, properties)) continue;

        if (layer.type === "fill" && feature.geometry.type === "Polygon") {
          this.drawFill(context, feature.geometry.coordinates, layer, properties);
        } else if (layer.type === "line") {
          this.drawLine(context, feature, layer, properties);
        } else if (
          layer.type === "circle" &&
          feature.geometry.type === "Point"
        ) {
          this.drawCircle(context, feature.geometry.coordinates, layer, properties);
        }
      }
    }
  }

  private drawFill(
    context: CanvasRenderingContext2D,
    rings: Position[][],
    layer: DrawingLayer,
    properties: Record<string, unknown>,
  ) {
    context.beginPath();
    for (const ring of rings) this.traceCoordinates(context, ring, true);
    const color = resolvedPaintValue(
      layer.paint?.["fill-color"],
      properties,
    );
    const opacity = resolvedPaintValue(
      layer.paint?.["fill-opacity"],
      properties,
    );
    context.fillStyle = typeof color === "string" ? color : "#0ea5e9";
    context.globalAlpha = typeof opacity === "number" ? opacity : 1;
    context.fill("evenodd");
    context.globalAlpha = 1;
  }

  private drawLine(
    context: CanvasRenderingContext2D,
    feature: Feature<Geometry>,
    layer: DrawingLayer,
    properties: Record<string, unknown>,
  ) {
    const geometry = feature.geometry;
    if (geometry.type !== "LineString" && geometry.type !== "Polygon") return;
    context.beginPath();
    if (geometry.type === "LineString") {
      this.traceCoordinates(context, geometry.coordinates, false);
    } else {
      for (const ring of geometry.coordinates) {
        this.traceCoordinates(context, ring, true);
      }
    }

    const color = resolvedPaintValue(
      layer.paint?.["line-color"],
      properties,
    );
    const width = resolvedPaintValue(
      layer.paint?.["line-width"],
      properties,
    );
    const opacity = resolvedPaintValue(
      layer.paint?.["line-opacity"],
      properties,
    );
    context.strokeStyle = typeof color === "string" ? color : "#0284c7";
    context.lineWidth = typeof width === "number" ? width : 1;
    context.globalAlpha = typeof opacity === "number" ? opacity : 1;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.stroke();
    context.globalAlpha = 1;
  }

  private drawCircle(
    context: CanvasRenderingContext2D,
    coordinate: Position,
    layer: DrawingLayer,
    properties: Record<string, unknown>,
  ) {
    const point = this.projectCoordinate(coordinate);
    if (!point) return;
    const radius = resolvedPaintValue(
      layer.paint?.["circle-radius"],
      properties,
    );
    const color = resolvedPaintValue(
      layer.paint?.["circle-color"],
      properties,
    );
    const strokeColor = resolvedPaintValue(
      layer.paint?.["circle-stroke-color"],
      properties,
    );
    const strokeWidth = resolvedPaintValue(
      layer.paint?.["circle-stroke-width"],
      properties,
    );

    context.beginPath();
    context.arc(
      point.x,
      point.y,
      typeof radius === "number" ? radius : 4,
      0,
      Math.PI * 2,
    );
    context.fillStyle = typeof color === "string" ? color : "#0f172a";
    context.fill();
    context.strokeStyle =
      typeof strokeColor === "string" ? strokeColor : "#ffffff";
    context.lineWidth = typeof strokeWidth === "number" ? strokeWidth : 0;
    if (context.lineWidth > 0) context.stroke();
  }

  private traceCoordinates(
    context: CanvasRenderingContext2D,
    coordinates: Position[],
    close: boolean,
  ) {
    let previous: ScreenPoint | null = null;
    const worldWidth = this.projection?.getWorldWidth() ?? 0;

    coordinates.forEach((coordinate, index) => {
      const projected = this.projectCoordinate(coordinate);
      if (!projected) return;
      const point = { ...projected };

      if (previous && worldWidth > 0) {
        while (point.x - previous.x > worldWidth / 2) point.x -= worldWidth;
        while (previous.x - point.x > worldWidth / 2) point.x += worldWidth;
      }

      if (index === 0 || !previous) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
      previous = point;
    });

    if (close) context.closePath();
  }

  private projectCoordinate(coordinate: Position) {
    if (!this.projection) return null;
    const point = this.projection.fromLatLngToContainerPixel({
      lng: coordinate[0],
      lat: coordinate[1],
    });
    return point ? { x: point.x, y: point.y } : null;
  }

  private polygonContainsPoint(ring: Position[], point: ScreenPoint) {
    const screenRing = ring
      .map((coordinate) => this.projectCoordinate(coordinate))
      .filter((candidate): candidate is ScreenPoint => candidate !== null);
    return screenRing.length >= 3 && pointInScreenPolygon(point, screenRing);
  }

  private isNearCompletedBorder(point: ScreenPoint) {
    const source = this.sources.get(COMPLETED_SOURCE_ID);
    if (!source) return false;

    return source.data.features.some((feature) => {
      if (feature.geometry.type !== "Polygon") return false;
      const ring = feature.geometry.coordinates[0]
        .map((coordinate) => this.projectCoordinate(coordinate))
        .filter((candidate): candidate is ScreenPoint => candidate !== null);

      return ring.some((start, index) => {
        const end = ring[(index + 1) % ring.length];
        return distanceToSegment(point, start, end) <= 10;
      });
    });
  }

  private pointHitsCompletedDrawing(point: ScreenPoint) {
    return (
      this.queryRenderedFeatures([point.x, point.y], {
        layers: [COMPLETED_FILL_LAYER_ID],
      }).length > 0 || this.isNearCompletedBorder(point)
    );
  }

  private adapterEvent(event: PointerEvent) {
    const bounds = this.container.getBoundingClientRect();
    const point = {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    };
    const lngLat = this.unproject(point);

    return {
      point,
      lngLat,
      originalEvent: event,
      preventDefault: () => event.preventDefault(),
    } as unknown as MapMouseEvent;
  }

  private dispatch(eventName: AdapterEventName, event: PointerEvent) {
    if (!this.projection) return;
    const adapterEvent = this.adapterEvent(event);
    for (const handler of this.handlers[eventName]) handler(adapterEvent);
  }

  private readonly handlePointerDown = (event: PointerEvent) => {
    if (event.button === 0) {
      const bounds = this.container.getBoundingClientRect();
      const point = {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      };
      const drawingInteraction =
        this.spacePressed || this.isNearCompletedBorder(point);
      if (drawingInteraction) {
        this.container.setPointerCapture(event.pointerId);
        this.capturedPointerId = event.pointerId;
      }

      if (this.spacePressed) {
        this.setMode(
          this.pointHitsCompletedDrawing(point) ? "Move area" : "Pencil",
        );
      } else if (this.isNearCompletedBorder(point)) {
        this.setMode("Deform area");
      }
    }
    this.dispatch("mousedown", event);
  };

  private readonly handlePointerMove = (event: PointerEvent) => {
    this.dispatch("mousemove", event);
  };

  private readonly handlePointerUp = (event: PointerEvent) => {
    this.dispatch("mouseup", event);
    this.releasePointer(event.pointerId);
    this.setMode(this.spacePressed ? "Pencil" : "Navigate");
  };

  private readonly handlePointerCancel = (event: PointerEvent) => {
    this.dispatch("mouseup", event);
    this.releasePointer(event.pointerId);
    this.setMode(this.spacePressed ? "Pencil" : "Navigate");
  };

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (
      event.code !== "Space" ||
      event.repeat ||
      (event.target instanceof HTMLElement &&
        event.target.closest("input, textarea, select, button"))
    ) {
      return;
    }

    this.spacePressed = true;
    this.setMode("Pencil");
  };

  private readonly handleKeyUp = (event: KeyboardEvent) => {
    if (event.code !== "Space") return;
    this.spacePressed = false;
    this.setMode("Navigate");
  };

  private readonly handleBlur = () => {
    if (this.capturedPointerId !== null) {
      this.releasePointer(this.capturedPointerId);
    }
    this.spacePressed = false;
    this.setMode("Navigate");
  };

  private releasePointer(pointerId: number) {
    if (
      this.capturedPointerId === pointerId &&
      this.container.hasPointerCapture(pointerId)
    ) {
      this.container.releasePointerCapture(pointerId);
    }
    if (this.capturedPointerId === pointerId) this.capturedPointerId = null;
  }

  private addDomListeners() {
    this.container.addEventListener(
      "pointerdown",
      this.handlePointerDown,
      true,
    );
    this.container.addEventListener(
      "pointermove",
      this.handlePointerMove,
      true,
    );
    this.container.addEventListener("pointerup", this.handlePointerUp, true);
    this.container.addEventListener(
      "pointercancel",
      this.handlePointerCancel,
      true,
    );
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    window.addEventListener("blur", this.handleBlur);
  }

  private removeDomListeners() {
    this.container.removeEventListener(
      "pointerdown",
      this.handlePointerDown,
      true,
    );
    this.container.removeEventListener(
      "pointermove",
      this.handlePointerMove,
      true,
    );
    this.container.removeEventListener("pointerup", this.handlePointerUp, true);
    this.container.removeEventListener(
      "pointercancel",
      this.handlePointerCancel,
      true,
    );
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    window.removeEventListener("blur", this.handleBlur);
  }
}
