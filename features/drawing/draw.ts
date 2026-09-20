import type {
  Feature,
  FeatureCollection,
  LineString,
  Polygon,
  Position,
} from "geojson";
import type { GeoJSONSource, Map, MapMouseEvent } from "maplibre-gl";
import {
  createPencil,
  screenPolygonsOverlap,
  type PencilController,
} from "./pencil";

type CreateDrawOptions = {
  map: Map;
  onReady: () => void;
};

export type DrawProjection = "web-mercator" | "globe";

export type CompletedDrawing = {
  id: string;
  points: Position[];
  closed: boolean;
};

type ScreenPoint = { x: number; y: number };

type ShapeDrag = {
  drawingId: string;
  start: ScreenPoint;
  originalPoints: Position[];
};

type DeformationPoint = {
  coordinate: Position;
  screen: ScreenPoint;
  weight: number;
};

type BorderDeformation = {
  drawingId: string;
  start: ScreenPoint;
  points: DeformationPoint[];
  anchorIndex: number;
  restoreDragPan: boolean;
};

type BorderTarget = {
  drawingId: string;
  segmentIndex: number;
  segmentRatio: number;
};

const SOURCE_ID = "worldrawing-completed-drawings";
const FILL_LAYER_ID = "worldrawing-completed-drawings-fill";
const OUTLINE_LAYER_ID = "worldrawing-completed-drawings-outline";
const BORDER_SOURCE_ID = "worldrawing-border-highlight";
const BORDER_LAYER_ID = "worldrawing-border-highlight-line";
const BORDER_HIT_RADIUS = 10;
const BORDER_HIGHLIGHT_RADIUS = 50;
const BORDER_DEFORMATION_RADIUS = 90;
const BORDER_SUPPORT_SPACING = 12;

function screenDistance(left: ScreenPoint, right: ScreenPoint) {
  return Math.hypot(left.x - right.x, left.y - right.y);
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
    return { distance: screenDistance(point, start), ratio: 0 };
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

  return {
    distance: screenDistance(point, {
      x: start.x + segmentX * ratio,
      y: start.y + segmentY * ratio,
    }),
    ratio,
  };
}

function isSameBorderTarget(
  left: BorderTarget | null,
  right: BorderTarget | null,
) {
  return (
    left?.drawingId === right?.drawingId &&
    left?.segmentIndex === right?.segmentIndex &&
    Math.abs((left?.segmentRatio ?? 0) - (right?.segmentRatio ?? 0)) < 0.01
  );
}

function isShortcutTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest("input, textarea, select, button") !== null)
  );
}

function createRenderData(
  drawings: CompletedDrawing[],
): FeatureCollection<Polygon> {
  return {
    type: "FeatureCollection",
    features: drawings
      .filter((drawing) => drawing.closed)
      .map((drawing) => ({
        id: drawing.id,
        type: "Feature",
        properties: { drawingId: drawing.id },
        geometry: { type: "Polygon", coordinates: [drawing.points] },
      })),
  };
}

export function createDraw({ map, onReady }: CreateDrawOptions) {
  const drawings: CompletedDrawing[] = [];
  let pencil: PencilController | null = null;
  let spacePressed = false;
  let shapeDrag: ShapeDrag | null = null;
  let lastPointer: ScreenPoint | null = null;
  let deletePopover: HTMLDivElement | null = null;
  let hoveredBorder: BorderTarget | null = null;
  let borderDeformation: BorderDeformation | null = null;

  map.addSource(SOURCE_ID, {
    type: "geojson",
    data: createRenderData(drawings),
  });
  map.addLayer({
    id: FILL_LAYER_ID,
    type: "fill",
    source: SOURCE_ID,
    paint: {
      "fill-color": "#0ea5e9",
      "fill-opacity": 0.3,
    },
  });
  map.addLayer({
    id: OUTLINE_LAYER_ID,
    type: "line",
    source: SOURCE_ID,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#0284c7",
      "line-width": 3,
    },
  });
  map.addSource(BORDER_SOURCE_ID, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: BORDER_LAYER_ID,
    type: "line",
    source: BORDER_SOURCE_ID,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#38bdf8",
      "line-width": 6,
      "line-opacity": 0.95,
    },
  });

  const render = () => {
    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(createRenderData(drawings));
  };

  const borderSection = (target: BorderTarget) => {
    const drawing = drawings.find(
      (candidate) => candidate.id === target.drawingId,
    );
    if (!drawing || drawing.points.length < 3) return null;

    const vertices = drawing.points.slice(0, -1);
    const vertexCount = vertices.length;
    if (vertexCount < 2 || target.segmentIndex >= vertexCount) return null;

    const projected = vertices.map((coordinate) => {
      const point = map.project({ lng: coordinate[0], lat: coordinate[1] });
      return { x: point.x, y: point.y };
    });
    const startIndex = target.segmentIndex;
    const endIndex = (startIndex + 1) % vertexCount;
    const start = projected[startIndex];
    const end = projected[endIndex];
    const center = {
      x: start.x + (end.x - start.x) * target.segmentRatio,
      y: start.y + (end.y - start.y) * target.segmentRatio,
    };
    const centerLngLat = map.unproject([center.x, center.y]);
    const coordinates: Position[] = [[centerLngLat.lng, centerLngLat.lat]];

    const extend = (direction: -1 | 1) => {
      let remaining = BORDER_HIGHLIGHT_RADIUS;
      let currentPoint = center;
      let vertexIndex = direction === -1 ? startIndex : endIndex;
      let visited = 0;

      while (remaining > 0 && visited < vertexCount) {
        const vertexPoint = projected[vertexIndex];
        const segmentLength = screenDistance(currentPoint, vertexPoint);
        let coordinate: Position;

        if (segmentLength <= remaining) {
          coordinate = [...vertices[vertexIndex]];
          remaining -= segmentLength;
          currentPoint = vertexPoint;
          vertexIndex =
            (vertexIndex + direction + vertexCount) % vertexCount;
          visited += 1;
        } else {
          const ratio = remaining / segmentLength;
          const cutoff = {
            x: currentPoint.x + (vertexPoint.x - currentPoint.x) * ratio,
            y: currentPoint.y + (vertexPoint.y - currentPoint.y) * ratio,
          };
          const lngLat = map.unproject([cutoff.x, cutoff.y]);
          coordinate = [lngLat.lng, lngLat.lat];
          remaining = 0;
        }

        if (direction === -1) coordinates.unshift(coordinate);
        else coordinates.push(coordinate);
      }
    };

    extend(-1);
    extend(1);

    return coordinates;
  };

  const prepareBorderDeformation = (
    drawing: CompletedDrawing,
    target: BorderTarget,
  ) => {
    const vertices = drawing.points.slice(0, -1);
    if (vertices.length < 3) return null;

    const projected = vertices.map((coordinate) => {
      const point = map.project({ lng: coordinate[0], lat: coordinate[1] });
      return { x: point.x, y: point.y };
    });
    const segmentLengths = projected.map((point, index) =>
      screenDistance(point, projected[(index + 1) % projected.length]),
    );
    const cumulative = [0];
    for (const length of segmentLengths) {
      cumulative.push(cumulative.at(-1)! + length);
    }
    const perimeter = cumulative.at(-1)!;
    if (perimeter === 0) return null;

    const targetPosition =
      cumulative[target.segmentIndex] +
      segmentLengths[target.segmentIndex] * target.segmentRatio;
    const points: DeformationPoint[] = [];
    let anchorIndex = -1;

    for (let segmentIndex = 0; segmentIndex < vertices.length; segmentIndex += 1) {
      const start = projected[segmentIndex];
      const end = projected[(segmentIndex + 1) % vertices.length];
      const segmentLength = segmentLengths[segmentIndex];
      const sampleRatios = [0];
      const sampleCount = Math.max(
        1,
        Math.ceil(segmentLength / BORDER_SUPPORT_SPACING),
      );

      for (let sample = 1; sample < sampleCount; sample += 1) {
        const ratio = sample / sampleCount;
        const position = cumulative[segmentIndex] + segmentLength * ratio;
        const directDistance = Math.abs(position - targetPosition);
        const outlineDistance = Math.min(
          directDistance,
          perimeter - directDistance,
        );
        if (outlineDistance < BORDER_DEFORMATION_RADIUS) {
          sampleRatios.push(ratio);
        }
      }

      if (segmentIndex === target.segmentIndex) {
        sampleRatios.push(target.segmentRatio);
      }

      const uniqueRatios = [...new Set(sampleRatios)].sort(
        (left, right) => left - right,
      );
      for (const ratio of uniqueRatios) {
        const screen = {
          x: start.x + (end.x - start.x) * ratio,
          y: start.y + (end.y - start.y) * ratio,
        };
        const position = cumulative[segmentIndex] + segmentLength * ratio;
        const directDistance = Math.abs(position - targetPosition);
        const outlineDistance = Math.min(
          directDistance,
          perimeter - directDistance,
        );
        const weight =
          outlineDistance >= BORDER_DEFORMATION_RADIUS
            ? 0
            : (1 +
                Math.cos(
                  (Math.PI * outlineDistance) / BORDER_DEFORMATION_RADIUS,
                )) /
              2;
        let coordinate: Position;

        if (ratio === 0) {
          coordinate = [...vertices[segmentIndex]];
        } else {
          const lngLat = map.unproject([screen.x, screen.y]);
          coordinate = [lngLat.lng, lngLat.lat];
        }

        if (
          segmentIndex === target.segmentIndex &&
          Math.abs(ratio - target.segmentRatio) < 0.000001
        ) {
          anchorIndex = points.length;
        }
        points.push({ coordinate, screen, weight });
      }
    }

    return anchorIndex >= 0 ? { points, anchorIndex } : null;
  };

  const renderBorderHighlight = () => {
    const coordinates = hoveredBorder ? borderSection(hoveredBorder) : null;
    const features: Array<Feature<LineString>> = coordinates
      ? [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates },
          },
        ]
      : [];
    const source = map.getSource(BORDER_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData({ type: "FeatureCollection", features });
  };

  const overlapsCompletedDrawing = (
    screenRing: ScreenPoint[],
    excludedDrawingId?: string,
  ) =>
    drawings.some((drawing) => {
      if (!drawing.closed || drawing.id === excludedDrawingId) return false;

      const existingScreenRing = drawing.points.map((coordinate) => {
        const point = map.project({ lng: coordinate[0], lat: coordinate[1] });
        return { x: point.x, y: point.y };
      });

      return screenPolygonsOverlap(screenRing, existingScreenRing);
    });

  const completePolygon = (
    ring: Position[],
    screenRing: ScreenPoint[],
  ) => {
    if (overlapsCompletedDrawing(screenRing)) return false;

    drawings.push({
      id: crypto.randomUUID(),
      points: ring.map((coordinate) => [...coordinate]),
      closed: true,
    });
    render();
    return true;
  };

  const drawingAt = (point: ScreenPoint) => {
    const feature = map.queryRenderedFeatures([point.x, point.y], {
      layers: [FILL_LAYER_ID],
    })[0];
    const drawingId = feature?.properties?.drawingId;

    return typeof drawingId === "string"
      ? drawings.find((drawing) => drawing.id === drawingId)
      : undefined;
  };

  const borderAt = (point: ScreenPoint): BorderTarget | null => {
    const nearbyFeatures = map.queryRenderedFeatures(
      [
        [point.x - BORDER_HIT_RADIUS, point.y - BORDER_HIT_RADIUS],
        [point.x + BORDER_HIT_RADIUS, point.y + BORDER_HIT_RADIUS],
      ],
      { layers: [OUTLINE_LAYER_ID] },
    );
    const nearbyDrawingIds = new Set(
      nearbyFeatures
        .map((feature) => feature.properties?.drawingId)
        .filter((drawingId): drawingId is string => typeof drawingId === "string"),
    );
    let nearest: { target: BorderTarget; distance: number } | null = null;

    for (const drawing of drawings) {
      if (!drawing.closed || !nearbyDrawingIds.has(drawing.id)) continue;

      const vertices = drawing.points.slice(0, -1);
      const projected = vertices.map((coordinate) => {
        const projectedPoint = map.project({
          lng: coordinate[0],
          lat: coordinate[1],
        });
        return { x: projectedPoint.x, y: projectedPoint.y };
      });

      for (let index = 0; index < vertices.length; index += 1) {
        const segmentHit = distanceToSegment(
          point,
          projected[index],
          projected[(index + 1) % vertices.length],
        );

        if (
          segmentHit.distance <= BORDER_HIT_RADIUS &&
          (!nearest || segmentHit.distance < nearest.distance)
        ) {
          const isSegmentEnd = segmentHit.ratio > 0.999999;
          nearest = {
            target: {
              drawingId: drawing.id,
              segmentIndex: isSegmentEnd
                ? (index + 1) % vertices.length
                : index,
              segmentRatio: isSegmentEnd ? 0 : segmentHit.ratio,
            },
            distance: segmentHit.distance,
          };
        }
      }
    }

    return nearest?.target ?? null;
  };

  const closeDeletePopover = () => {
    deletePopover?.remove();
    deletePopover = null;
  };

  const deleteDrawing = (drawingId: string) => {
    const drawingIndex = drawings.findIndex(
      (drawing) => drawing.id === drawingId,
    );
    if (drawingIndex === -1) return;

    if (borderDeformation?.drawingId === drawingId) {
      finishBorderDeformation();
    }
    drawings.splice(drawingIndex, 1);
    if (hoveredBorder?.drawingId === drawingId) hoveredBorder = null;
    render();
    renderBorderHighlight();
  };

  const openDeletePopover = (
    drawingId: string,
    clientPoint: ScreenPoint,
  ) => {
    closeDeletePopover();

    const popover = document.createElement("div");
    popover.setAttribute("role", "menu");
    Object.assign(popover.style, {
      position: "fixed",
      left: `${clientPoint.x}px`,
      top: `${clientPoint.y}px`,
      zIndex: "10",
      padding: "4px",
      border: "1px solid rgba(0, 0, 0, 0.18)",
      borderRadius: "6px",
      background: "white",
      boxShadow: "0 6px 18px rgba(0, 0, 0, 0.22)",
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "Delete";
    deleteButton.setAttribute("role", "menuitem");
    Object.assign(deleteButton.style, {
      display: "block",
      width: "100%",
      padding: "7px 12px",
      border: "0",
      borderRadius: "3px",
      background: "transparent",
      color: "#b91c1c",
      cursor: "pointer",
      font: "600 13px system-ui, sans-serif",
      textAlign: "left",
    });
    deleteButton.addEventListener("click", () => {
      deleteDrawing(drawingId);
      closeDeletePopover();
    });

    popover.append(deleteButton);
    document.body.append(popover);
    deletePopover = popover;

    const bounds = popover.getBoundingClientRect();
    popover.style.left = `${Math.max(
      8,
      Math.min(clientPoint.x, window.innerWidth - bounds.width - 8),
    )}px`;
    popover.style.top = `${Math.max(
      8,
      Math.min(clientPoint.y, window.innerHeight - bounds.height - 8),
    )}px`;
    deleteButton.focus();
  };

  const handleContextMenu = (event: MouseEvent) => {
    const canvasBounds = map.getCanvas().getBoundingClientRect();
    const point = {
      x: event.clientX - canvasBounds.left,
      y: event.clientY - canvasBounds.top,
    };
    const border = borderAt(point);
    const drawing = border
      ? drawings.find((candidate) => candidate.id === border.drawingId)
      : drawingAt(point);

    if (!drawing) {
      closeDeletePopover();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    finishBorderDeformation();
    finishShapeDrag();
    openDeletePopover(drawing.id, {
      x: event.clientX,
      y: event.clientY,
    });
  };

  const handleOutsidePointerDown = (event: PointerEvent) => {
    if (
      deletePopover &&
      event.target instanceof Node &&
      !deletePopover.contains(event.target)
    ) {
      closeDeletePopover();
    }
  };

  const translatedPoints = (drag: ShapeDrag, point: ScreenPoint) => {
    const deltaX = point.x - drag.start.x;
    const deltaY = point.y - drag.start.y;
    const moved = drag.originalPoints.map((coordinate) => {
      const projected = map.project({ lng: coordinate[0], lat: coordinate[1] });
      const lngLat = map.unproject([
        projected.x + deltaX,
        projected.y + deltaY,
      ]);

      return [lngLat.lng, lngLat.lat] as Position;
    });

    return moved.every(
      (coordinate) =>
        Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1]),
    )
      ? moved
      : null;
  };

  const deformedPoints = (
    deformation: BorderDeformation,
    point: ScreenPoint,
  ) => {
    const deltaX = point.x - deformation.start.x;
    const deltaY = point.y - deformation.start.y;
    const moved = deformation.points.map((sample) => {
      if (sample.weight === 0) return [...sample.coordinate];

      const lngLat = map.unproject([
        sample.screen.x + deltaX * sample.weight,
        sample.screen.y + deltaY * sample.weight,
      ]);
      return [lngLat.lng, lngLat.lat] as Position;
    });

    if (
      moved.some(
        (coordinate) =>
          !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1]),
      )
    ) {
      return null;
    }

    moved.push([...moved[0]]);
    return moved;
  };

  const finishBorderDeformation = () => {
    if (!borderDeformation) return;
    if (borderDeformation.restoreDragPan) map.dragPan.enable();
    borderDeformation = null;
  };

  const finishShapeDrag = () => {
    shapeDrag = null;
  };

  const handleShapeMouseDown = (event: MapMouseEvent) => {
    if (event.originalEvent.button !== 0) return;

    const point = { x: event.point.x, y: event.point.y };
    const border = borderAt(point);

    if (!spacePressed && border) {
      const drawing = drawings.find(
        (candidate) => candidate.id === border.drawingId,
      );
      const prepared = drawing
        ? prepareBorderDeformation(drawing, border)
        : null;
      if (!drawing || !prepared) return;

      event.preventDefault();
      closeDeletePopover();
      const restoreDragPan = map.dragPan.isEnabled();
      map.dragPan.disable();
      borderDeformation = {
        drawingId: drawing.id,
        start: point,
        points: prepared.points,
        anchorIndex: prepared.anchorIndex,
        restoreDragPan,
      };
      map.getCanvas().style.cursor = "ew-resize";
      return;
    }

    if (!spacePressed) return;

    const drawing = border
      ? drawings.find((candidate) => candidate.id === border.drawingId)
      : drawingAt(point);
    if (!drawing) return;

    event.preventDefault();
    pencil?.pause();
    shapeDrag = {
      drawingId: drawing.id,
      start: point,
      originalPoints: drawing.points.map((coordinate) => [...coordinate]),
    };
    map.getCanvas().style.cursor = "grabbing";
  };

  const handleShapeMouseMove = (event: MapMouseEvent) => {
    const point = { x: event.point.x, y: event.point.y };
    lastPointer = point;

    if (borderDeformation) {
      if ((event.originalEvent.buttons & 1) !== 1) {
        finishBorderDeformation();
      } else {
        const deformation = borderDeformation;
        const drawing = drawings.find(
          (candidate) => candidate.id === deformation.drawingId,
        );
        const points = deformedPoints(deformation, point);

        if (drawing && points) {
          const screenRing = points.map((coordinate) => {
            const projected = map.project({
              lng: coordinate[0],
              lat: coordinate[1],
            });
            return { x: projected.x, y: projected.y };
          });

          if (!overlapsCompletedDrawing(screenRing, drawing.id)) {
            drawing.points = points;
            hoveredBorder = {
              drawingId: drawing.id,
              segmentIndex: deformation.anchorIndex,
              segmentRatio: 0,
            };
            render();
            renderBorderHighlight();
          }
        }
      }

      map.getCanvas().style.cursor = "ew-resize";
      return;
    }

    if (shapeDrag) {
      if ((event.originalEvent.buttons & 1) !== 1) {
        finishShapeDrag();
      } else {
        const drawing = drawings.find(
          (candidate) => candidate.id === shapeDrag?.drawingId,
        );
        const points = translatedPoints(shapeDrag, point);

        if (drawing && points) {
          const screenRing = points.map((coordinate) => {
            const projected = map.project({
              lng: coordinate[0],
              lat: coordinate[1],
            });
            return { x: projected.x, y: projected.y };
          });

          if (!overlapsCompletedDrawing(screenRing, drawing.id)) {
            drawing.points = points;
            render();
            renderBorderHighlight();
          }
        }
      }

      map.getCanvas().style.cursor = shapeDrag ? "grabbing" : "grab";
      return;
    }

    const border = borderAt(point);
    if (!isSameBorderTarget(border, hoveredBorder)) {
      hoveredBorder = border;
      renderBorderHighlight();
    }

    if (spacePressed) {
      if (border || drawingAt(point)) map.getCanvas().style.cursor = "grab";
    } else {
      map.getCanvas().style.cursor = border ? "ew-resize" : "";
    }
  };

  const handleShapeMouseUp = (event: MapMouseEvent) => {
    if (borderDeformation) {
      lastPointer = { x: event.point.x, y: event.point.y };
      finishBorderDeformation();
      map.getCanvas().style.cursor = borderAt(lastPointer) ? "ew-resize" : "";
      return;
    }

    if (!shapeDrag) return;

    lastPointer = { x: event.point.x, y: event.point.y };
    finishShapeDrag();
    map.getCanvas().style.cursor =
      spacePressed && (borderAt(lastPointer) || drawingAt(lastPointer))
        ? "grab"
        : "crosshair";
  };

  const handleCanvasMouseLeave = () => {
    if (hoveredBorder) {
      hoveredBorder = null;
      renderBorderHighlight();
    }
    if (!shapeDrag && !borderDeformation && !spacePressed) {
      map.getCanvas().style.cursor = "";
    }
  };

  const handleWindowMouseUp = () => {
    if (borderDeformation) {
      finishBorderDeformation();
      map.getCanvas().style.cursor = "";
      return;
    }

    if (!shapeDrag) return;
    finishShapeDrag();
    map.getCanvas().style.cursor =
      spacePressed &&
      lastPointer &&
      (borderAt(lastPointer) || drawingAt(lastPointer))
        ? "grab"
        : spacePressed
          ? "crosshair"
          : "";
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (isShortcutTarget(event.target)) return;

    if (event.code === "Space") {
      event.preventDefault();
      if (event.repeat || spacePressed || !pencil || borderDeformation) return;

      spacePressed = true;
      pencil.enable();
      if (lastPointer && (borderAt(lastPointer) || drawingAt(lastPointer))) {
        map.getCanvas().style.cursor = "grab";
      }
      return;
    }

    if (event.key === "Escape" && pencil?.hasStroke()) {
      event.preventDefault();
      pencil.cancel();
    }
  };

  const handleKeyUp = (event: KeyboardEvent) => {
    if (event.code !== "Space" || !spacePressed) return;

    event.preventDefault();
    finishShapeDrag();
    spacePressed = false;
    pencil?.disable();
  };

  const handleWindowBlur = () => {
    finishBorderDeformation();
    finishShapeDrag();
    spacePressed = false;
    pencil?.disable();
  };

  pencil = createPencil({
    map,
    canStart: (point) =>
      borderAt(point) === null &&
      map.queryRenderedFeatures([point.x, point.y], {
        layers: [FILL_LAYER_ID],
      }).length === 0,
    completePolygon,
  });
  map.on("mousedown", handleShapeMouseDown);
  map.on("mousemove", handleShapeMouseMove);
  map.on("mouseup", handleShapeMouseUp);
  map.getCanvas().addEventListener("contextmenu", handleContextMenu);
  map.getCanvas().addEventListener("mouseleave", handleCanvasMouseLeave);
  document.addEventListener("pointerdown", handleOutsidePointerDown);
  window.addEventListener("mouseup", handleWindowMouseUp);
  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", handleKeyUp);
  window.addEventListener("blur", handleWindowBlur);
  onReady();

  return {
    getDrawings() {
      return drawings.map((drawing) => ({
        ...drawing,
        points: drawing.points.map((coordinate) => [...coordinate]),
      }));
    },
    setProjection(_projection: DrawProjection) {
      closeDeletePopover();
      finishBorderDeformation();
      finishShapeDrag();
      hoveredBorder = null;
      renderBorderHighlight();
      pencil?.setProjection();
    },
    reset() {
      closeDeletePopover();
      finishBorderDeformation();
      finishShapeDrag();
      hoveredBorder = null;
      spacePressed = false;
      pencil?.disable();
      pencil?.clear();
      drawings.length = 0;
      render();
      renderBorderHighlight();
    },
    stop() {
      closeDeletePopover();
      finishBorderDeformation();
      pencil?.stop();
      pencil = null;
      map.off("mousedown", handleShapeMouseDown);
      map.off("mousemove", handleShapeMouseMove);
      map.off("mouseup", handleShapeMouseUp);
      map.getCanvas().removeEventListener("contextmenu", handleContextMenu);
      map.getCanvas().removeEventListener("mouseleave", handleCanvasMouseLeave);
      document.removeEventListener("pointerdown", handleOutsidePointerDown);
      window.removeEventListener("mouseup", handleWindowMouseUp);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);

      if (map.getLayer(BORDER_LAYER_ID)) map.removeLayer(BORDER_LAYER_ID);
      if (map.getLayer(OUTLINE_LAYER_ID)) map.removeLayer(OUTLINE_LAYER_ID);
      if (map.getLayer(FILL_LAYER_ID)) map.removeLayer(FILL_LAYER_ID);
      if (map.getSource(BORDER_SOURCE_ID)) map.removeSource(BORDER_SOURCE_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    },
  };
}

export type DrawController = ReturnType<typeof createDraw>;
